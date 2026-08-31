"""The matching engine — CLAUDE.md §5.5.

This is the part of the system that is genuinely novel, and until now it had no
tests. Every rule it implements is asserted here, including the one that was
wrong at the hackathon (extend-on-shared-indicator).
"""

from __future__ import annotations

from server import store
from server.matching import CONFIDENCE_THRESHOLD, process_new_signature
from server.models import SignatureRecord

BASE = "2026-08-26T09:14:02+00:00"


def add(
    org_id: str,
    *,
    technique: str = "T1059.001",
    indicator: str = "12f23ed9d97811dd",
    start: str = BASE,
    end: str | None = None,
    confidence: float = 0.9,
) -> tuple[SignatureRecord, str | None]:
    """Store a signature the way the API does, then run matching over it."""
    record = SignatureRecord(
        id=store.new_signature_id(),
        org_id=org_id,
        technique=technique,
        indicator_hash=indicator,
        window_start=start,
        window_end=end or start,
        confidence=confidence,
        received_at=BASE,
    )
    store.ensure_org(org_id)
    store.signatures.append(record)
    return record, process_new_signature(record)


# --- the ">= 2 orgs" rule -----------------------------------------------------


def test_one_org_alone_never_matches():
    _, match_id = add("org_a")
    assert match_id is None
    assert store.matches == {}


def test_one_org_reporting_twice_still_never_matches():
    """A single org cannot correlate with itself, however much it submits —
    otherwise an org could manufacture a "cross-org" campaign on its own."""
    add("org_a", start="2026-08-26T09:14:02+00:00")
    _, match_id = add("org_a", start="2026-08-26T09:20:00+00:00")
    assert match_id is None
    assert store.matches == {}


def test_two_orgs_sharing_an_indicator_match():
    add("org_a")
    _, match_id = add("org_b")
    assert match_id is not None
    match = store.matches[match_id]
    assert sorted(match.org_ids) == ["org_a", "org_b"]
    assert match.indicator_hash == "12f23ed9d97811dd"
    assert match.status == "pending"


# --- rule 1a: identical indicator beats everything ----------------------------


def test_shared_indicator_matches_even_with_different_techniques():
    """Two orgs can label the same attacker infrastructure differently — one
    calls it T1059.001, the other T1071.001. The shared indicator is the strong
    signal and must win regardless."""
    add("org_a", technique="T1059.001")
    _, match_id = add("org_b", technique="T1071.001")
    assert match_id is not None


def test_shared_indicator_matches_across_distant_time_windows():
    """Same infrastructure, weeks apart, is still the same infrastructure."""
    add("org_a", start="2026-08-01T09:00:00+00:00")
    _, match_id = add("org_b", start="2026-08-26T09:00:00+00:00")
    assert match_id is not None


# --- rule 1b: same technique + overlapping window -----------------------------


def test_same_technique_within_tolerance_matches():
    add("org_a", indicator="aaaaaaaaaaaaaaaa", start="2026-08-26T09:00:00+00:00")
    _, match_id = add(
        "org_b", indicator="bbbbbbbbbbbbbbbb", start="2026-08-26T09:45:00+00:00"
    )
    assert match_id is not None
    # No shared indicator, so the match carries none — the weaker signal is
    # visibly weaker to whoever has to approve it.
    assert store.matches[match_id].indicator_hash is None


def test_same_technique_outside_tolerance_does_not_match():
    add("org_a", indicator="aaaaaaaaaaaaaaaa", start="2026-08-26T09:00:00+00:00")
    _, match_id = add(
        "org_b", indicator="bbbbbbbbbbbbbbbb", start="2026-08-26T11:30:00+00:00"
    )
    assert match_id is None


def test_tolerance_boundary_is_sixty_minutes():
    add("org_a", indicator="aaaaaaaaaaaaaaaa", start="2026-08-26T09:00:00+00:00")
    _, inside = add(
        "org_b", indicator="bbbbbbbbbbbbbbbb", start="2026-08-26T09:59:00+00:00"
    )
    assert inside is not None

    store.clear_all()
    add("org_a", indicator="aaaaaaaaaaaaaaaa", start="2026-08-26T09:00:00+00:00")
    _, outside = add(
        "org_b", indicator="bbbbbbbbbbbbbbbb", start="2026-08-26T10:01:00+00:00"
    )
    assert outside is None


def test_different_technique_and_different_indicator_never_match():
    add("org_a", technique="T1059.001", indicator="aaaaaaaaaaaaaaaa")
    _, match_id = add("org_b", technique="T1486", indicator="bbbbbbbbbbbbbbbb")
    assert match_id is None


# --- confidence gate ----------------------------------------------------------


def test_low_confidence_on_both_sides_does_not_match():
    add("org_a", confidence=0.2)
    _, match_id = add("org_b", confidence=0.3)
    assert match_id is None


def test_one_confident_org_is_enough():
    """Confidence is a max, not a mean: one org being sure is enough to warrant
    showing a human, and a human still has to approve it."""
    add("org_a", confidence=0.2)
    _, match_id = add("org_b", confidence=0.95)
    assert match_id is not None
    assert store.matches[match_id].confidence == 0.95


def test_threshold_is_inclusive():
    add("org_a", confidence=CONFIDENCE_THRESHOLD)
    _, match_id = add("org_b", confidence=CONFIDENCE_THRESHOLD)
    assert match_id is not None


# --- extend vs create ---------------------------------------------------------


def test_third_org_extends_the_existing_match():
    """"org C joins late" — the demo flourish. A third org sharing the indicator
    must grow the open match, not open a competing one."""
    add("org_a")
    _, first = add("org_b")
    _, second = add("org_c")
    assert second == first
    assert len(store.matches) == 1
    assert sorted(store.matches[first].org_ids) == ["org_a", "org_b", "org_c"]


def test_third_org_extends_even_with_a_different_technique_label():
    """The hackathon bug: extension checked technique only, so a third org whose
    model labelled the same infrastructure differently opened a second match."""
    add("org_a", technique="T1059.001")
    _, first = add("org_b", technique="T1059.001")
    _, second = add("org_c", technique="T1071.001")
    assert second == first
    assert len(store.matches) == 1


def test_an_unrelated_campaign_creates_a_separate_match():
    add("org_a", indicator="1111111111111111", technique="T1059.001")
    _, first = add("org_b", indicator="1111111111111111", technique="T1059.001")
    add("org_a", indicator="2222222222222222", technique="T1486")
    _, second = add("org_b", indicator="2222222222222222", technique="T1486")
    assert first != second
    assert len(store.matches) == 2


def test_extension_widens_the_match_window():
    add("org_a", start="2026-08-26T09:00:00+00:00", end="2026-08-26T09:05:00+00:00")
    _, match_id = add(
        "org_b", start="2026-08-26T08:30:00+00:00", end="2026-08-26T08:40:00+00:00"
    )
    add("org_c", start="2026-08-26T10:00:00+00:00", end="2026-08-26T10:10:00+00:00")
    match = store.matches[match_id]
    assert match.window_start.startswith("2026-08-26T08:30")
    assert match.window_end.startswith("2026-08-26T10:10")


def test_an_approved_match_is_not_extended():
    """Once a human has approved a specific disclosure, later evidence must open
    a new match rather than silently changing what was already approved."""
    add("org_a")
    _, match_id = add("org_b")
    store.matches[match_id].status = "approved"
    _, second = add("org_c")
    assert second != match_id
    assert len(store.matches) == 2


# --- correlation never sees anything but the four fields ----------------------


def test_matching_uses_only_the_submitted_signature_fields():
    """Guard against the engine ever growing a dependency on raw telemetry:
    everything it needs is on SignatureRecord, and there is nothing else here."""
    import inspect

    from server import matching

    source = inspect.getsource(matching)
    for forbidden in ("open(", "requests", "httpx", "log_path", "subprocess"):
        assert forbidden not in source, f"matching.py must not reference {forbidden}"
