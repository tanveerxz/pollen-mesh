"""In-memory shared state. Resets on process restart — see CLAUDE.md §5.2."""

from __future__ import annotations

import uuid

from server.models import MatchRecord, OrgRecord, SignatureRecord

signatures: list[SignatureRecord] = []
matches: dict[str, MatchRecord] = {}

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


def ensure_org(org_id: str) -> OrgRecord:
    """Return the org record, auto-registering an unknown submitter as real."""
    record = orgs.get(org_id)
    if record is None:
        record = OrgRecord(org_id=org_id, label=org_id, kind="real")
        orgs[org_id] = record
    return record


def new_signature_id() -> str:
    return f"sig_{uuid.uuid4().hex[:12]}"


def new_match_id() -> str:
    return f"match_{uuid.uuid4().hex[:12]}"
