"""Tests for the deterministic pieces of the org agent — CLAUDE.md §0c "still worth doing" item 3.

Everything the cross-org match depends on that is NOT a model call: indicator
normalization/hashing, deterministic indicator extraction, the privacy
guard-rail, the technique-id gate, and Open-Responses parsing against the
actual Kimi response shape (reasoning item before message item, captured live
2026-08-26).
"""

import pytest

from org_c.agent import (
    _TECHNIQUE_RE,
    _hash_indicator,
    _leaks_identity,
    _normalize_indicator,
    _structured_output,
    extract_indicator,
)

# --- indicator normalization + hashing: WHY cross-org matching works ---------


def test_hash_identical_across_formatting_variants():
    variants = [
        "secure-update-delivery.net",
        "http://secure-update-delivery.net",
        "https://secure-update-delivery.net.",
        "  secure-update-delivery.net  ",
        "secure-update-delivery.net/",
        "SECURE-UPDATE-DELIVERY.NET",
    ]
    assert len({_hash_indicator(v) for v in variants}) == 1


def test_hash_locks_the_demo_value():
    h = _hash_indicator("secure-update-delivery.net")
    assert h == "39b83e8cf8e2dd93"  # the cross-org hash every live run must reproduce
    assert len(h) == 16
    int(h, 16)  # raises if not hex


def test_different_indicators_hash_differently():
    assert _hash_indicator("evil-a.net") != _hash_indicator("evil-b.net")


def test_normalize_strips_scheme_case_and_trailing_punctuation():
    assert _normalize_indicator("HTTPS://Evil.Example.COM/.") == "evil.example.com"


# --- deterministic indicator extraction (model never sees this job) ----------


def test_extracts_attacker_domain_from_campaign_row():
    row = {
        "timestamp": "2026-08-26T09:14:02Z",
        "source_process": "powershell.exe",
        "event_type": "network_connection",
        "detail": "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present",
    }
    assert extract_indicator(row) == "secure-update-delivery.net"


@pytest.mark.parametrize(
    "detail",
    [
        "outbound TCP 443 to windowsupdate.microsoft.com, routine",
        "outbound TCP 443 to teams.microsoft.com, routine",
        "outbound TCP 443 to slack.com, routine",
        "outbound TCP 443 to cdn-assets-fastly.net, normal browsing",
        "outbound TCP 443 to backup-vendor.com, scheduled job",
    ],
)
def test_benign_domains_are_never_indicators(detail):
    assert extract_indicator({"detail": detail}) is None


def test_process_names_are_not_domains():
    row = {"detail": "spawned from winword.exe, base64-encoded command line"}
    assert extract_indicator(row) is None


def test_no_detail_yields_no_indicator():
    assert extract_indicator({}) is None


# --- privacy guard-rail: never trust the model's word -------------------------


@pytest.mark.parametrize(
    "value",
    [
        "beacon to 10.0.0.5",
        "192.168.1.1",
        "CORP-DC-01 lateral movement",
        "internal host compromised",
        "hostname disclosure",
    ],
)
def test_guard_rail_rejects_identifying_content(value):
    assert _leaks_identity(value)


def test_guard_rail_passes_clean_values():
    assert not _leaks_identity("T1059.001", "office macro spawned encoded powershell")


# --- technique-id gate --------------------------------------------------------


@pytest.mark.parametrize("technique", ["T1059.001", "T1071", "T1105"])
def test_technique_gate_accepts_mitre_ids(technique):
    assert _TECHNIQUE_RE.match(technique)


@pytest.mark.parametrize(
    "technique",
    [
        "office-application-spawns-powershell-with-encoded-command",  # seen live pre-fix
        "PowerShell execution from Office application with encoded command",
        "T105",
        "T10590.001",
        "t1059.001",
        "",
    ],
)
def test_technique_gate_rejects_free_text(technique):
    assert not _TECHNIQUE_RE.match(technique)


# --- Open-Responses parsing against the real Kimi shape -----------------------

KIMI_RESPONSE_FIXTURE = {
    "object": "response",
    "output": [
        {
            "type": "reasoning",
            "content": [
                {
                    "type": "reasoning_text",
                    "text": "Let me think about whether this log line is suspicious...",
                }
            ],
        },
        {
            "type": "message",
            "content": [
                {
                    "type": "output_text",
                    "text": '{"reason": "Office spawning encoded PowerShell.", "escalate": true}',
                }
            ],
        },
    ],
}


def test_parses_message_item_not_reasoning_trace():
    payload = _structured_output(KIMI_RESPONSE_FIXTURE)
    assert payload == {"reason": "Office spawning encoded PowerShell.", "escalate": True}


def test_parses_top_level_output_text_when_present():
    assert _structured_output({"output_text": '{"escalate": false, "reason": "x"}'}) == {
        "escalate": False,
        "reason": "x",
    }


def test_raises_on_model_error_payload():
    with pytest.raises(ValueError, match="model error"):
        _structured_output({"output": [], "error": {"message": "overloaded"}})


def test_raises_when_no_message_item_exists():
    reasoning_only = {"output": [KIMI_RESPONSE_FIXTURE["output"][0]]}
    with pytest.raises(ValueError):
        _structured_output(reasoning_only)
