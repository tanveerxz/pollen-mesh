"""In-memory shared state. Resets on process restart — see CLAUDE.md §5.2."""

from __future__ import annotations

import uuid

from server.models import MatchRecord, SignatureRecord

signatures: list[SignatureRecord] = []
matches: dict[str, MatchRecord] = {}


def new_signature_id() -> str:
    return f"sig_{uuid.uuid4().hex[:12]}"


def new_match_id() -> str:
    return f"match_{uuid.uuid4().hex[:12]}"
