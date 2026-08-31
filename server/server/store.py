"""Shared state, owned solely by the server — see CLAUDE.md §5.2.

Held in module-level containers for simplicity, and snapshotted to SQLite by
`server.persistence` after every mutation so a crash mid-demo doesn't lose it.
"""

from __future__ import annotations

import uuid

from server.models import MatchRecord, OrgRecord, SignatureRecord

signatures: list[SignatureRecord] = []
matches: dict[str, MatchRecord] = {}

# Dedupe index: (org_id, indicator_hash, window_start) -> signature id.
#
# An agent re-run over an unchanged log re-triages and resubmits every row it
# escalated the first time. Without this the same real-world event is counted
# two or three times, inflating both the org's signature count and any match it
# feeds. The key deliberately excludes `technique`: the same event re-triaged can
# come back with a different ATT&CK label, and it is still the same event.
signature_keys: dict[tuple[str, str, str], str] = {}

# The three demo orgs are the ones this repo can drive locally (own Flower
# project + mock log + the attack console). A "real" org is external: it runs
# its own agent on its own machine and only ever POSTs signatures in — so real
# orgs are registered on first contact, never spun up here.
DEMO_ORG_LABELS = {
    "org_a": "Northwind Financial",
    "org_b": "Meridian Logistics",
    "org_c": "Halcyon Health",
}


def _seed_orgs() -> dict[str, OrgRecord]:
    return {
        org_id: OrgRecord(org_id=org_id, label=label, kind="demo")
        for org_id, label in DEMO_ORG_LABELS.items()
    }


orgs: dict[str, OrgRecord] = _seed_orgs()

# Demo mode gates everything that fabricates or drives the demo orgs (attack
# console, local agent runner, reset). Off = the server is a passive correlator
# for whatever real external agents send it.
demo_mode: bool = True


def reset_orgs() -> None:
    orgs.clear()
    orgs.update(_seed_orgs())


def clear_all() -> None:
    """Wipe every piece of correlation state. Used by /api/demo/reset."""
    signatures.clear()
    matches.clear()
    signature_keys.clear()
    reset_orgs()


def ensure_org(org_id: str) -> OrgRecord:
    """Return the org record, auto-registering an unknown submitter as real."""
    record = orgs.get(org_id)
    if record is None:
        record = OrgRecord(org_id=org_id, label=org_id, kind="real")
        orgs[org_id] = record
    return record


def dedupe_key(
    org_id: str, indicator_hash: str, window_start: str
) -> tuple[str, str, str]:
    return (org_id, indicator_hash, window_start)


def find_duplicate(
    org_id: str, indicator_hash: str, window_start: str
) -> SignatureRecord | None:
    """The signature this submission would duplicate, if any."""
    existing_id = signature_keys.get(dedupe_key(org_id, indicator_hash, window_start))
    if existing_id is None:
        return None
    return next((s for s in signatures if s.id == existing_id), None)


def match_containing(signature_id: str) -> str | None:
    for match in matches.values():
        if signature_id in match.signature_ids:
            return match.id
    return None


def new_signature_id() -> str:
    return f"sig_{uuid.uuid4().hex[:12]}"


def new_match_id() -> str:
    return f"match_{uuid.uuid4().hex[:12]}"


# --- snapshot / restore, for server.persistence -------------------------------


def snapshot() -> dict[str, object]:
    return {
        "signatures": [s.model_dump() for s in signatures],
        "matches": {k: v.model_dump() for k, v in matches.items()},
        "orgs": {k: v.model_dump() for k, v in orgs.items()},
        "signature_keys": [[list(k), v] for k, v in signature_keys.items()],
        "demo_mode": demo_mode,
    }


def restore(state: dict[str, object]) -> None:
    global demo_mode

    signatures.clear()
    signatures.extend(SignatureRecord(**s) for s in state.get("signatures", []))

    matches.clear()
    matches.update(
        {k: MatchRecord(**v) for k, v in (state.get("matches") or {}).items()}
    )

    orgs.clear()
    orgs.update({k: OrgRecord(**v) for k, v in (state.get("orgs") or {}).items()})
    if not orgs:
        orgs.update(_seed_orgs())

    signature_keys.clear()
    signature_keys.update(
        {tuple(k): v for k, v in (state.get("signature_keys") or [])}  # type: ignore[misc]
    )

    demo_mode = bool(state.get("demo_mode", True))
