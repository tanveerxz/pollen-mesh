"""Deterministic cross-org matching — see CLAUDE.md §5.5. No model calls here."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from server import store
from server.models import MatchRecord, SignatureRecord

OVERLAP_TOLERANCE = timedelta(minutes=60)
CONFIDENCE_THRESHOLD = 0.5


def _parse(ts: str) -> datetime:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _windows_overlap(
    s_start: datetime, s_end: datetime, t_start: datetime, t_end: datetime
) -> bool:
    """True if [s_start, s_end] overlaps [t_start, t_end] padded by the tolerance."""
    t_start_padded = t_start - OVERLAP_TOLERANCE
    t_end_padded = t_end + OVERLAP_TOLERANCE
    return s_start <= t_end_padded and t_start_padded <= s_end


def _is_partner(s: SignatureRecord, t: SignatureRecord) -> bool:
    if s.id == t.id or s.org_id == t.org_id:
        return False
    if s.indicator_hash == t.indicator_hash:
        return True
    if s.technique != t.technique:
        return False
    return _windows_overlap(
        _parse(s.window_start), _parse(s.window_end),
        _parse(t.window_start), _parse(t.window_end),
    )


def process_new_signature(sig: SignatureRecord) -> str | None:
    """Run the matching algorithm for a newly stored signature.

    Returns the id of the match created or extended, or None if no match resulted.
    Assumes `sig` has already been appended to `store.signatures`.
    """
    partners = [t for t in store.signatures if _is_partner(sig, t)]

    org_ids = {sig.org_id} | {p.org_id for p in partners}
    if len(org_ids) < 2:
        return None

    confidence = max([sig.confidence, *(p.confidence for p in partners)])
    if confidence < CONFIDENCE_THRESHOLD:
        return None

    shared_indicator_hash = next(
        (sig.indicator_hash for p in partners if p.indicator_hash == sig.indicator_hash),
        None,
    )

    contributing = [sig, *partners]
    window_start = min(_parse(c.window_start) for c in contributing).isoformat()
    window_end = max(_parse(c.window_end) for c in contributing).isoformat()

    for match in store.matches.values():
        if match.status != "pending":
            continue
        same_technique = match.technique == sig.technique
        same_indicator = (
            match.indicator_hash is not None
            and match.indicator_hash == sig.indicator_hash
        )
        if not (same_technique or same_indicator):
            continue
        candidate_org_ids = set(match.org_ids) | {sig.org_id}
        if candidate_org_ids <= org_ids:
            if sig.id not in match.signature_ids:
                match.signature_ids.append(sig.id)
            if sig.org_id not in match.org_ids:
                match.org_ids.append(sig.org_id)
            match.confidence = max(match.confidence, confidence)
            match.window_start = min(match.window_start, window_start)
            match.window_end = max(match.window_end, window_end)
            return match.id

    new_match = _create_match(
        sig=sig,
        partners=partners,
        org_ids=org_ids,
        technique=sig.technique,
        indicator_hash=shared_indicator_hash,
        confidence=confidence,
        window_start=window_start,
        window_end=window_end,
    )
    return new_match.id


def _create_match(
    *,
    sig: SignatureRecord,
    partners: list[SignatureRecord],
    org_ids: set[str],
    technique: str,
    indicator_hash: str | None,
    confidence: float,
    window_start: str,
    window_end: str,
) -> MatchRecord:
    match = MatchRecord(
        id=store.new_match_id(),
        signature_ids=[sig.id, *(p.id for p in partners)],
        org_ids=list(org_ids),
        technique=technique,
        indicator_hash=indicator_hash,
        window_start=window_start,
        window_end=window_end,
        confidence=confidence,
        status="pending",
        created_at=datetime.now(timezone.utc).isoformat(),
        local_actions={},
    )
    store.matches[match.id] = match
    return match
