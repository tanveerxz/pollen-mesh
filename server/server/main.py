"""FastAPI app — sole owner of all shared state. See CLAUDE.md §5."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from server import store
from server.matching import process_new_signature
from server.models import (
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


@app.post("/api/signatures", status_code=201, response_model=SignatureSubmitResponse)
def submit_signature(payload: SignatureCreate) -> SignatureSubmitResponse:
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
    match_id = process_new_signature(record)
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
