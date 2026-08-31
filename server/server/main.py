"""FastAPI app — sole owner of all shared state. See CLAUDE.md §5."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from server import agent_runner, attacks, persistence, store
from server.matching import process_new_signature
from server.models import (
    AgentRunRequest,
    AgentStopRequest,
    AttackLaunchRequest,
    CustomAttackRequest,
    LocalActionRequest,
    MatchRecord,
    MatchStatus,
    ModeRequest,
    OrgRecord,
    OrgRegisterRequest,
    OrgStatus,
    SignatureCreate,
    SignatureRecord,
    SignatureSubmitResponse,
)

# server/server/main.py -> parents[2] is the repo root, so this resolves to
# <repo_root>/orgs/<org_id>/data/mock_log.csv once the Flower org projects exist.
REPO_ROOT = Path(__file__).resolve().parents[2]
ORG_IDS = ("org_a", "org_b", "org_c")

app = FastAPI(title="Pollen Mesh Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.on_event("startup")
def _startup() -> None:
    """Restore the last snapshot, then ensure each demo org has a working log
    (copied from its committed seed) so the log views work before any attack."""
    if persistence.load():
        print(
            f"[startup] restored {len(store.signatures)} signature(s), "
            f"{len(store.matches)} match(es) from {persistence.db_path()}"
        )
    for org_id in ORG_IDS:
        attacks.ensure_working_log(org_id)


@app.middleware("http")
async def _persist_after_mutation(request: Request, call_next):
    """Snapshot state after any request that could have changed it.

    Blanket-applied rather than sprinkled through each endpoint so a new
    mutating route cannot silently forget to persist.
    """
    response = await call_next(request)
    if request.method != "GET" and response.status_code < 400:
        persistence.save()
    return response


def _require_demo_mode(what: str = "This") -> None:
    """Refuse anything that fabricates, drives, or reads the demo orgs.

    In demo mode the server also plays the part of the three demo orgs' own
    machines, so it may read their logs. A real org runs its own agent on its
    own infrastructure and only ever POSTs a stripped signature in — the server
    must never be able to read its telemetry.
    """
    if not store.demo_mode:
        raise HTTPException(
            status_code=403,
            detail=(
                f"{what} is demo-mode only. A real org's raw log is never readable "
                "by the correlator — run the agent's own hunt mode instead."
            ),
        )


def _require_demo_org(org_id: str, what: str) -> None:
    record = store.orgs.get(org_id)
    if record is not None and record.kind != "demo":
        raise HTTPException(
            status_code=403,
            detail=f"{what} is not available for real orgs — their logs never reach the correlator.",
        )


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "pollen-mesh-server"}


@app.get("/api/mode")
def get_mode() -> dict[str, bool]:
    return {"demo_mode": store.demo_mode}


@app.post("/api/mode")
def set_mode(payload: ModeRequest) -> dict[str, bool]:
    store.demo_mode = payload.demo_mode
    return {"demo_mode": store.demo_mode}


@app.get("/api/orgs", response_model=list[OrgRecord])
def list_orgs() -> list[OrgRecord]:
    return list(store.orgs.values())


@app.post("/api/orgs", response_model=OrgRecord)
def register_org(payload: OrgRegisterRequest) -> OrgRecord:
    """Register a real, external org (or rename one). Demo orgs are protected."""
    existing = store.orgs.get(payload.org_id)
    if existing is not None and existing.kind == "demo":
        raise HTTPException(status_code=409, detail="That is a reserved demo org id")
    record = OrgRecord(
        org_id=payload.org_id,
        label=payload.label or payload.org_id,
        kind="real",
    )
    store.orgs[payload.org_id] = record
    return record


@app.post("/api/demo/reset")
def demo_reset(restore_logs: bool = True) -> dict[str, object]:
    """Clear all correlation state so a demo can be re-run without restarting.

    Not part of §5.4's contract — added so §10 step 1 ("reset, fresh terminals")
    doesn't require killing the process mid-demo. Also rewinds each org's log
    file to its pre-attack baseline unless asked not to, and drops the persisted
    snapshot so a restart doesn't resurrect what was just cleared.
    """
    _require_demo_mode()
    cleared_signatures = len(store.signatures)
    cleared_matches = len(store.matches)
    store.clear_all()
    persistence.wipe()
    restored = attacks.restore_logs(list(ORG_IDS)) if restore_logs else {}
    return {
        "cleared_signatures": cleared_signatures,
        "cleared_matches": cleared_matches,
        "restored_logs": restored,
    }


@app.post("/api/agents/run")
def run_agents(payload: AgentRunRequest) -> dict[str, object]:
    """Start the real Flower agents for the given orgs, in parallel.

    Shells out to the same `flwr run` a human would type, in that org's own
    project directory. Returns immediately — poll /api/agents for progress.
    """
    _require_demo_mode()
    started: dict[str, object] = {}
    for org_id in payload.org_ids:
        try:
            started[org_id] = agent_runner.start(org_id, payload.model).as_dict()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"runs": started}


@app.post("/api/agents/stop")
def stop_agents(payload: AgentStopRequest) -> dict[str, object]:
    """Abort running agents. Stops the run on the SuperLink, not just our stream."""
    if payload.org_ids:
        stopped = [o for o in payload.org_ids if agent_runner.stop(o) is not None]
    else:
        stopped = agent_runner.stop_all()
    return {"stopped": stopped, "runs": agent_runner.snapshot()}


@app.get("/api/agents")
def agent_status() -> dict[str, object]:
    """Live reasoning from each running agent, parsed from its own stdout."""
    return {"runs": agent_runner.snapshot()}


@app.get("/api/attacks")
def list_attacks() -> list[dict[str, object]]:
    """The scenario library the demo console offers."""
    return [attacks.scenario_summary(s) for s in attacks.SCENARIOS]


def _deliver_attack(
    per_org: dict[str, list[dict[str, str]]],
    mode: str,
    scenario_id: str,
    name: str,
    started_iso: str,
) -> dict[str, object]:
    """Shared path for built-in and custom attacks: write rows, and in demo
    mode run the stand-in detector and submit through the public signature path."""
    written: dict[str, int] = {}
    for org_id, rows in per_org.items():
        try:
            written[org_id] = attacks.append_rows(org_id, rows)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    detected: list[dict[str, object]] = []
    match_ids: set[str] = set()

    if mode == "demo":
        for org_id, rows in per_org.items():
            for row in rows:
                verdict = attacks.analyse_row(row)
                if verdict is None:
                    continue
                created = SignatureCreate(
                    org_id=org_id,
                    technique=str(verdict["technique"]),
                    indicator=attacks.hash_indicator(str(verdict["indicator"])),
                    window_start=row["timestamp"],
                    window_end=row["timestamp"],
                    confidence=float(verdict["confidence"]),  # type: ignore[arg-type]
                )
                record, match_id, _duplicate = _store_signature(created)
                if match_id:
                    match_ids.add(match_id)
                detected.append(
                    {
                        "signature_id": record.id,
                        "org_id": org_id,
                        "technique": record.technique,
                        "indicator_hash": record.indicator_hash,
                        "match_id": match_id,
                    }
                )

    return {
        "scenario_id": scenario_id,
        "name": name,
        "mode": mode,
        "launched_at": started_iso,
        "rows_written": written,
        "org_ids": list(per_org.keys()),
        "detected": detected,
        "match_ids": sorted(match_ids),
    }


@app.post("/api/attacks/custom/launch")
def launch_custom_attack(payload: CustomAttackRequest) -> dict[str, object]:
    """Build and deliver a custom attack — either explicit steps, or the
    shorthand org_ids + indicator. Demo-mode only, same honest pipeline.

    Declared before the {scenario_id} route so 'custom' isn't captured as an id.
    """
    _require_demo_mode()
    started = attacks.utc_now()
    try:
        per_org = attacks.build_custom_rows(payload, started)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if not per_org:
        raise HTTPException(status_code=422, detail="Custom attack produced no rows")
    return _deliver_attack(
        per_org, payload.mode, "custom", payload.name, started.isoformat()
    )


@app.post("/api/attacks/{scenario_id}/launch")
def launch_attack(scenario_id: str, payload: AttackLaunchRequest) -> dict[str, object]:
    """Deliver a built-in attack into the targeted orgs' own local logs.

    Always writes real rows. In `demo` mode it additionally runs the rule-based
    detector (see attacks.py) and submits the resulting signatures through the
    same internal path as a live agent, so correlation is genuinely computed.
    """
    _require_demo_mode()
    scenario = attacks.SCENARIOS_BY_ID.get(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail="Unknown attack scenario")

    started = attacks.utc_now()
    per_org = attacks.build_rows(scenario, started)
    result = _deliver_attack(
        per_org, payload.mode, scenario.id, scenario.name, started.isoformat()
    )
    result["org_ids"] = scenario.org_ids  # declared targets, even if a row wrote nothing
    return result


def _store_signature(
    payload: SignatureCreate,
) -> tuple[SignatureRecord, str | None, bool]:
    """The one path by which a signature enters the system.

    Idempotent on (org_id, indicator_hash, window_start): re-running an agent
    over an unchanged log resubmits everything it escalated, and a match built
    from three copies of one event would misrepresent how much evidence there
    actually is. The agent watermarks too, but the correlator cannot assume a
    well-behaved submitter — so the invariant is enforced here as well.
    """
    duplicate = store.find_duplicate(
        payload.org_id, payload.indicator, payload.window_start
    )
    if duplicate is not None:
        return duplicate, store.match_containing(duplicate.id), True

    record = SignatureRecord(
        id=store.new_signature_id(),
        org_id=payload.org_id,
        technique=payload.technique,
        indicator_hash=payload.indicator,
        window_start=payload.window_start,
        window_end=payload.window_end,
        confidence=payload.confidence,
        received_at=_now(),
    )
    store.ensure_org(record.org_id)  # unknown submitter -> registered as a real org
    store.signatures.append(record)
    store.signature_keys[
        store.dedupe_key(record.org_id, record.indicator_hash, record.window_start)
    ] = record.id
    return record, process_new_signature(record), False


@app.post("/api/signatures", status_code=201, response_model=SignatureSubmitResponse)
def submit_signature(payload: SignatureCreate) -> SignatureSubmitResponse:
    record, match_id, duplicate = _store_signature(payload)
    return SignatureSubmitResponse(
        signature_id=record.id, match_id=match_id, duplicate=duplicate
    )


@app.get("/api/signatures", response_model=list[SignatureRecord])
def list_signatures() -> list[SignatureRecord]:
    return store.signatures


@app.get("/api/matches", response_model=list[MatchRecord])
def list_matches(status: MatchStatus | None = None) -> list[MatchRecord]:
    values = list(store.matches.values())
    if status is not None:
        values = [m for m in values if m.status == status]
    return values


@app.get("/api/matches/{match_id}", response_model=MatchRecord)
def get_match(match_id: str) -> MatchRecord:
    match = store.matches.get(match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return match


@app.post("/api/matches/{match_id}/approve", response_model=MatchRecord)
def approve_match(match_id: str) -> MatchRecord:
    match = store.matches.get(match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=409, detail="Match is not pending")

    match.status = "approved"
    match.approved_at = _now()
    match.local_actions = {org_id: "pending" for org_id in match.org_ids}
    return match


@app.post("/api/matches/{match_id}/reject", response_model=MatchRecord)
def reject_match(match_id: str) -> MatchRecord:
    match = store.matches.get(match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "pending":
        raise HTTPException(status_code=409, detail="Match is not pending")

    match.status = "rejected"
    return match


@app.post("/api/matches/{match_id}/local-action/{org_id}", response_model=MatchRecord)
def local_action(match_id: str, org_id: str, payload: LocalActionRequest) -> MatchRecord:
    match = store.matches.get(match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status != "approved":
        raise HTTPException(status_code=409, detail="Match is not approved")
    if org_id not in match.org_ids:
        raise HTTPException(status_code=404, detail="Org is not part of this match")

    match.local_actions[org_id] = payload.decision
    if match.local_actions and all(v == "approved" for v in match.local_actions.values()):
        match.status = "resolved"
    return match


@app.get("/api/orgs/{org_id}/status", response_model=OrgStatus)
def org_status(org_id: str) -> OrgStatus:
    signature_count = sum(1 for s in store.signatures if s.org_id == org_id)
    pending_match_count = sum(
        1
        for m in store.matches.values()
        if m.status == "pending" and org_id in m.org_ids
    )
    record = store.orgs.get(org_id)
    return OrgStatus(
        org_id=org_id,
        signature_count=signature_count,
        pending_match_count=pending_match_count,
        kind=record.kind if record else "real",
        label=record.label if record else org_id,
    )


@app.get("/api/orgs/{org_id}/hunt")
def org_hunt(org_id: str, indicator_hash: str) -> dict[str, object]:
    """Retro-hunt a DEMO org's log for a disclosed indicator hash.

    The real implementation of this lives in the agent (`hunt_own_log`), where
    it belongs: a real org hunts its own logs on its own machine and the
    correlator never sees them. A correlator that greps your raw logs is
    precisely what this system exists to avoid.

    This endpoint is the demo-mode stand-in, and is only defensible because in
    demo mode the server IS the three demo orgs' machine. It is refused
    outright in real mode.
    """
    _require_demo_mode("retro-hunt")
    _require_demo_org(org_id, "retro-hunt")
    hits = attacks.hunt_local(org_id, indicator_hash)
    return {"org_id": org_id, "indicator_hash": indicator_hash, "hits": hits}


@app.get("/api/orgs/{org_id}/log")
def org_log(org_id: str) -> list[dict[str, str]]:
    """Optional convenience endpoint — see CLAUDE.md §5.4 and §7's live-SDK note.

    Reads JSONL, not CSV: the Flower FAB packager's built-in include allowlist
    (.py/.toml/.md/.yaml/.yml/.json/.jsonl only) can't ship a .csv into an
    AgentApp bundle, so each org's own mock log is JSONL and this endpoint
    matches that.
    """
    _require_demo_mode("reading a raw log")
    _require_demo_org(org_id, "reading a raw log")
    attacks.ensure_working_log(org_id)  # seed the working log from its committed seed if needed
    log_path = attacks.log_path(org_id)
    if not log_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No mock log found for '{org_id}' at {log_path}",
        )
    with log_path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
