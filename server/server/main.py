"""FastAPI app — sole owner of all shared state. See CLAUDE.md §5."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from server import agent_runner, attacks, store
from server.matching import process_new_signature
from server.models import (
    AgentRunRequest,
    AttackLaunchRequest,
    LocalActionRequest,
    MatchRecord,
    MatchStatus,
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


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "pollen-mesh-server"}


@app.post("/api/demo/reset")
def demo_reset(restore_logs: bool = True) -> dict[str, object]:
    """Clear all in-memory state so a demo can be re-run without restarting.

    Not part of §5.4's contract — added so §10 step 1 ("reset, fresh terminals")
    doesn't require killing the process mid-demo. State is in-memory anyway
    (§5.2), so this just does explicitly what a restart does implicitly. Also
    rewinds each org's log file to its pre-attack baseline unless asked not to.
    """
    cleared_signatures = len(store.signatures)
    cleared_matches = len(store.matches)
    store.signatures.clear()
    store.matches.clear()
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
    started: dict[str, object] = {}
    for org_id in payload.org_ids:
        try:
            started[org_id] = agent_runner.start(org_id, payload.model).as_dict()
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"runs": started}


@app.get("/api/agents")
def agent_status() -> dict[str, object]:
    """Live reasoning from each running agent, parsed from its own stdout."""
    return {"runs": agent_runner.snapshot()}


@app.get("/api/attacks")
def list_attacks() -> list[dict[str, object]]:
    """The scenario library the demo console offers."""
    return [attacks.scenario_summary(s) for s in attacks.SCENARIOS]


@app.post("/api/attacks/{scenario_id}/launch")
def launch_attack(scenario_id: str, payload: AttackLaunchRequest) -> dict[str, object]:
    """Deliver an attack into the targeted orgs' own local logs.

    Always writes real rows. In `demo` mode it additionally runs the rule-based
    detector (see attacks.py) and submits the resulting signatures through the
    same internal path as a live agent, so correlation is genuinely computed.
    """
    scenario = attacks.SCENARIOS_BY_ID.get(scenario_id)
    if scenario is None:
        raise HTTPException(status_code=404, detail="Unknown attack scenario")

    started = attacks.utc_now()
    per_org = attacks.build_rows(scenario, started)

    written: dict[str, int] = {}
    for org_id, rows in per_org.items():
        try:
            written[org_id] = attacks.append_rows(org_id, rows)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    detected: list[dict[str, object]] = []
    match_ids: set[str] = set()

    if payload.mode == "demo":
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
                record, match_id = _store_signature(created)
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
        "scenario_id": scenario.id,
        "name": scenario.name,
        "mode": payload.mode,
        "launched_at": started.isoformat(),
        "rows_written": written,
        "org_ids": scenario.org_ids,
        "detected": detected,
        "match_ids": sorted(match_ids),
    }


def _store_signature(payload: SignatureCreate) -> tuple[SignatureRecord, str | None]:
    """The one path by which a signature enters the system."""
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
    store.signatures.append(record)
    return record, process_new_signature(record)


@app.post("/api/signatures", status_code=201, response_model=SignatureSubmitResponse)
def submit_signature(payload: SignatureCreate) -> SignatureSubmitResponse:
    record, match_id = _store_signature(payload)
    return SignatureSubmitResponse(signature_id=record.id, match_id=match_id)


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
    return OrgStatus(
        org_id=org_id,
        signature_count=signature_count,
        pending_match_count=pending_match_count,
    )


@app.get("/api/orgs/{org_id}/hunt")
def org_hunt(org_id: str, indicator_hash: str) -> dict[str, object]:
    """Search one org's own log for a disclosed indicator hash.

    The org never receives the raw indicator — it hashes its own tokens and
    compares. See attacks.hunt_local.
    """
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
    log_path = REPO_ROOT / "orgs" / org_id / "data" / "mock_log.jsonl"
    if not log_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No mock log found for '{org_id}' at {log_path}",
        )
    with log_path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
