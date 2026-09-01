"""Tests for the deterministic pieces of the org agent — CLAUDE.md §0c "still worth doing" item 3.

Everything the cross-org match depends on that is NOT a model call: indicator
normalization/hashing, deterministic indicator extraction, the privacy
guard-rail, the technique-id gate, and Open-Responses parsing against the
actual Kimi response shape (reasoning item before message item, captured live
2026-08-26).
"""

import pytest

from org_a.agent import (
    DEMO_CONSORTIUM_KEY,
    _TECHNIQUE_RE,
    _consortium_key,
    _loads_lenient,
    _hash_indicator,
    _registrable_domain,
    _leaks_identity,
    _normalize_indicator,
    _row_fingerprint,
    _structured_output,
    extract_indicator,
    hunt_own_log,
    load_watermark,
    save_watermark,
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
    """Under the default demo key, every live run must reproduce this value.

    Changed on 2026-08-27 when the bare sha256 became a consortium-keyed HMAC.
    The old value (39b83e8cf8e2dd93) was recoverable in 121 guesses.
    """
    h = _hash_indicator("secure-update-delivery.net")
    assert h == "12f23ed9d97811dd"
    assert len(h) == 16
    int(h, 16)  # raises if not hex


def test_hash_is_keyed_not_a_bare_digest(monkeypatch):
    """Regression guard for the break in docs/threat-model.md.

    A bare sha256 of a domain is reversible: the preimage space is enumerable,
    and the previously published value fell in 121 attempts. If someone ever
    reverts _hash_indicator to an unkeyed digest, this fails.
    """
    import hashlib

    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "a-real-consortium-secret")
    indicator = "secure-update-delivery.net"
    unkeyed = hashlib.sha256(indicator.encode("utf-8")).hexdigest()[:16]
    assert _hash_indicator(indicator) != unkeyed


def test_different_keys_give_different_hashes(monkeypatch):
    """Two consortia must not be able to correlate against each other."""
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "consortium-one")
    first = _hash_indicator("secure-update-delivery.net")
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "consortium-two")
    second = _hash_indicator("secure-update-delivery.net")
    assert first != second


def test_same_key_matches_across_orgs(monkeypatch):
    """The property the whole system rests on: two orgs, same key, same value,
    with neither having seen the other's data."""
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "shared-consortium-secret")
    org_a_sees = _hash_indicator("https://secure-update-delivery.net/")
    org_b_sees = _hash_indicator("secure-update-delivery.net")
    assert org_a_sees == org_b_sees


def test_demo_key_is_used_when_unset(monkeypatch):
    monkeypatch.delenv("POLLEN_CONSORTIUM_KEY", raising=False)
    assert _consortium_key() == DEMO_CONSORTIUM_KEY.encode("utf-8")


def test_different_indicators_hash_differently():
    assert _hash_indicator("evil-a.net") != _hash_indicator("evil-b.net")


def test_normalize_strips_scheme_case_and_trailing_punctuation():
    """Scheme, case and trailing punctuation are stripped, and the host is then
    collapsed to its registrable domain — so `evil.example.com` becomes
    `example.com`. That collapsing is deliberate (see
    test_subdomain_and_port_variants_still_correlate): attacker infrastructure
    appears under different subdomains at different orgs, and matching the full
    hostname missed it."""
    assert _normalize_indicator("HTTPS://Evil.Example.COM/.") == "example.com"


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


# --- retro-hunt: the org searches its OWN log, never the correlator ----------


def _rows():
    return [
        {"timestamp": "2026-08-26T09:02:11Z", "source_process": "chrome.exe",
         "event_type": "network_connection", "detail": "outbound TCP 443 to news-site.com, browsing"},
        {"timestamp": "2026-08-26T09:14:02Z", "source_process": "powershell.exe",
         "event_type": "network_connection",
         "detail": "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe"},
        {"timestamp": "2026-08-26T09:20:10Z", "source_process": "svchost.exe",
         "event_type": "network_connection", "detail": "outbound TCP 443 to windowsupdate.microsoft.com, routine"},
    ]


def test_hunt_finds_the_event_from_only_a_hash():
    """The disclosed value is opaque; the org re-derives it over its own tokens."""
    disclosed = _hash_indicator("secure-update-delivery.net")
    hits = hunt_own_log(_rows(), disclosed)
    assert len(hits) == 1
    assert hits[0]["row"] == 1
    assert hits[0]["source_process"] == "powershell.exe"


def test_hunt_finds_nothing_when_never_hit():
    disclosed = _hash_indicator("some-other-attacker-domain.net")
    assert hunt_own_log(_rows(), disclosed) == []


def test_hunt_needs_the_same_key(monkeypatch):
    """An org in a different consortium cannot hunt our disclosures."""
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "consortium-one")
    disclosed = _hash_indicator("secure-update-delivery.net")
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "consortium-two")
    assert hunt_own_log(_rows(), disclosed) == []


# --- registrable-domain collapsing: subdomain rotation must still match -----


@pytest.mark.parametrize(
    "variant",
    [
        "secure-update-delivery.net",
        "https://secure-update-delivery.net/",
        "www.secure-update-delivery.net",
        "cdn.secure-update-delivery.net",
        "a.b.c.secure-update-delivery.net",
        "secure-update-delivery.net:443",
        "https://secure-update-delivery.net/beacon?id=1",
    ],
)
def test_subdomain_and_port_variants_still_correlate(variant):
    """Attacker infra shows up under different subdomains at different orgs.
    Matching the registrable domain catches that; matching the full hostname
    did not (a bare `www.` used to break the correlation)."""
    assert _hash_indicator(variant) == _hash_indicator("secure-update-delivery.net")


@pytest.mark.parametrize(
    "different",
    ["secure-update-delivery.com", "secure-updates-delivery.net", "delivery.net"],
)
def test_genuinely_different_domains_do_not_collide(different):
    """Collapsing must not over-reach: TLD rotation and typosquats are different
    registrations and are documented as NOT matched (docs/threat-model.md)."""
    assert _hash_indicator(different) != _hash_indicator("secure-update-delivery.net")


@pytest.mark.parametrize(
    "host,expected",
    [
        ("evil.co.uk", "evil.co.uk"),
        ("www.evil.co.uk", "evil.co.uk"),
        ("shop.example.com.au", "example.com.au"),
        ("example.com", "example.com"),
        ("192.168.1.1", "192.168.1.1"),
    ],
)
def test_multi_part_suffixes_are_not_over_collapsed(host, expected):
    """Without the suffix list, evil.co.uk would collapse to the useless co.uk."""
    assert _registrable_domain(host) == expected


# --- watermark: why a re-run doesn't count the same event twice --------------


def test_fingerprint_is_stable_across_key_order():
    a = {"timestamp": "2026-08-26T09:14:02Z", "detail": "x", "source_process": "p"}
    b = {"detail": "x", "source_process": "p", "timestamp": "2026-08-26T09:14:02Z"}
    assert _row_fingerprint(a) == _row_fingerprint(b)


def test_fingerprint_differs_for_different_rows():
    a = {"timestamp": "2026-08-26T09:14:02Z", "detail": "x"}
    b = {"timestamp": "2026-08-26T09:14:02Z", "detail": "y"}
    assert _row_fingerprint(a) != _row_fingerprint(b)


def test_watermark_round_trips(tmp_path):
    log = tmp_path / "mock_log.jsonl"
    log.write_text("", encoding="utf-8")
    assert load_watermark(log) == {}

    seen = {"abc123": {"outcome": "sent", "technique": "T1059.001"}}
    save_watermark(log, seen)
    assert load_watermark(log) == seen


def test_corrupt_watermark_means_reprocess_not_crash(tmp_path):
    """A damaged watermark must degrade to 'triage everything again', never to
    a failed run — losing time is recoverable, silently skipping rows is not."""
    log = tmp_path / "mock_log.jsonl"
    log.write_text("", encoding="utf-8")
    (tmp_path / "mock_log.watermark.json").write_text("{not json", encoding="utf-8")
    assert load_watermark(log) == {}


def test_watermark_lives_beside_the_log_not_inside_it(tmp_path):
    log = tmp_path / "mock_log.jsonl"
    log.write_text('{"timestamp":"t","detail":"d"}\n', encoding="utf-8")
    save_watermark(log, {"x": {"outcome": "noise"}})
    assert log.read_text(encoding="utf-8") == '{"timestamp":"t","detail":"d"}\n'
    assert (tmp_path / "mock_log.watermark.json").exists()


# --- false indicators: real logs are full of dotted tokens that are not domains


@pytest.mark.parametrize(
    "detail",
    [
        "Get-WinEvent | Select TimeCreated.ToUniversalTime",
        "System.Management.Automation.PSCustomObject created",
        "loaded module Newtonsoft.Json",
        r"running C:\ProgramData\tools\install.py",
        "wrote /var/tmp/payload.sh",
    ],
)
def test_dotted_tokens_that_are_not_domains_are_rejected(detail):
    """Hashing one of these produces an indicator no other org can match — or,
    worse, one that two orgs running the same tooling would both produce,
    inventing a correlation out of shared software rather than a shared
    attacker. Found on the first run against a real Windows Event Log, where
    `TimeCreated.ToUniversalTime` was extracted as the indicator."""
    assert extract_indicator({"detail": detail}) is None


def test_a_url_wins_over_a_bare_dotted_token():
    detail = "Newtonsoft.Json loaded; then GET https://secure-update-delivery.net/beacon"
    assert extract_indicator({"detail": detail}) == "secure-update-delivery.net"


def test_a_domain_inside_a_filesystem_path_is_not_an_indicator():
    assert extract_indicator({"detail": r"C:\builds\vendor.io\out.dll"}) is None


def test_a_benign_subdomain_is_still_benign():
    assert extract_indicator({"detail": "outbound TCP 443 to fs.microsoft.com"}) is None


@pytest.mark.parametrize("host", ["evil-c2.xyz", "beacon.top", "payload.icu", "drop.su"])
def test_unusual_but_real_tlds_are_accepted(host):
    assert extract_indicator({"detail": f"GET http://{host}/x"}) == host


# --- lenient parsing: not every endpoint honours text.format ------------------


def test_prose_wrapped_json_is_recovered():
    """Venice accepts a json_schema request and returns prose anyway (measured
    across five models). The schema is also stated in the prompt, and the reply
    parsed leniently, so the agent is not restricted to strict providers."""
    reply = (
        "Here is my assessment:\n\n"
        '{"reason": "Office spawning encoded PowerShell.", "escalate": true}\n\n'
        "Let me know if you need more detail."
    )
    assert _loads_lenient(reply) == {
        "reason": "Office spawning encoded PowerShell.",
        "escalate": True,
    }


def test_fenced_json_block_is_recovered():
    reply = 'Assessment:\n```json\n{"reason": "beaconing", "escalate": true}\n```\n'
    assert _loads_lenient(reply)["escalate"] is True


def test_nested_braces_do_not_truncate_the_object():
    reply = '{"reason": "saw {nested} braces", "escalate": false, "meta": {"a": 1}}'
    assert _loads_lenient(reply)["meta"] == {"a": 1}


def test_braces_inside_strings_do_not_confuse_the_parser():
    reply = 'text {"reason": "matched \\"}\\" literally", "escalate": true} end'
    assert _loads_lenient(reply)["escalate"] is True


def test_a_reply_with_no_json_is_an_error_not_a_guess():
    with pytest.raises(ValueError):
        _loads_lenient("I cannot help with that request.")


def test_empty_message_content_falls_through_to_an_error():
    """Venice with a schema returned an empty message and spent the whole budget
    on reasoning. That must raise so the retry loop sees it, not return {}."""
    response = {
        "output": [
            {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "..."}]},
            {"type": "message", "content": [{"type": "output_text", "text": "   "}]},
        ]
    }
    with pytest.raises(ValueError):
        _structured_output(response)


def test_strict_json_still_takes_the_fast_path():
    assert _loads_lenient('{"escalate": true, "reason": "x"}') == {
        "escalate": True,
        "reason": "x",
    }
