"""Where an organisation's telemetry actually comes from.

A real deployment has no mock JSONL file. It has an EDR, a SIEM, or — on a bare
Windows host — the Event Log. This module turns any of those into the one row
shape the agent reasons over:

    {"timestamp": ..., "source_process": ..., "event_type": ..., "detail": ...}

Sources are named by a `<kind>:<argument>` spec in run config:

    jsonl:data/mock_log.jsonl              one JSON object per line (demo default)
    file:/var/log/edr/alerts.log           plain text, one event per line
    winevent:Windows PowerShell            the live Windows Event Log

Everything here is deterministic and offline. No model is involved in deciding
what an event says — only in deciding what it means.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

# `powershell.exe -EncodedCommand <base64>` is how a real intrusion hides its
# command line, and it is also all the Event Log records. The base64 is decoded
# here, deterministically, before anything looks at the text — an agent that
# cannot read the command cannot triage it, and an indicator hidden inside
# base64 would never correlate with the same indicator seen in the clear
# somewhere else.
_ENCODED_COMMAND_RE = re.compile(
    r"-(?:enc|encodedcommand|e)\s+([A-Za-z0-9+/=]{16,})", re.IGNORECASE
)
_HOST_APPLICATION_RE = re.compile(r"^\s*HostApplication\s*=\s*(.+)$", re.MULTILINE)
_COMMAND_LINE_RE = re.compile(r"^\s*(?:CommandLine|Process Command Line)\s*=\s*(.+)$", re.MULTILINE)

# Local identity that has no business reaching a model endpoint. The signature
# that leaves the org never contains any of it, but triage sends the raw line
# out, so it is stripped here first. See docs/threat-model.md.
#
# Every rule is anchored to an explicit context (a home directory, a named
# field). An earlier version matched bare `WORD\word` to catch `DOMAIN\user`,
# and on real Event Log data it ate the middle of every filesystem path —
# `...\v1.0\powershell.exe` became `...\v1.<domain>\<user>`, destroying the
# only part of the line worth triaging. Redaction that removes the evidence is
# worse than no redaction: it hides the failure instead of the identity.
_REDACTIONS = (
    (re.compile(r"(?i)(\\Users\\)[^\\\s\"']+"), r"\1<user>"),
    (re.compile(r"(?i)(/home/)[^/\s\"']+"), r"\1<user>"),
    (re.compile(r"(?i)(/Users/)[^/\s\"']+"), r"\1<user>"),
    (
        re.compile(
            r"(?i)\b(User|UserName|UserId|Account|AccountName|SubjectUserName|"
            r"TargetUserName|ComputerName|MachineName|HostName)\s*[=:]\s*"
            r"[^\s,;\"']+"
        ),
        r"\1=<redacted>",
    ),
)

WINEVENT_MAX_EVENTS = 60


def decode_encoded_commands(text: str) -> str:
    """Expand any `-EncodedCommand <base64>` in place, leaving the rest alone.

    PowerShell encodes as UTF-16LE; a value that does not decode cleanly is left
    exactly as found rather than guessed at.
    """

    def expand(match: re.Match[str]) -> str:
        blob = match.group(1)
        for encoding in ("utf-16-le", "utf-8"):
            try:
                decoded = base64.b64decode(blob, validate=True).decode(encoding)
            except (ValueError, UnicodeDecodeError):
                continue
            if decoded.isprintable() or "\n" in decoded:
                cleaned = " ".join(decoded.split())
                return f"{match.group(0)} [decoded: {cleaned}]"
        return match.group(0)

    return _ENCODED_COMMAND_RE.sub(expand, text)


def redact_local_identity(text: str) -> str:
    """Strip usernames and machine names before a line is sent for triage."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


def _condense(text: str) -> str:
    return " ".join(text.split())


def event_to_row(event: dict[str, object]) -> dict[str, str]:
    """Map one Windows event to the agent's row shape.

    The interesting text is the command line, which the classic PowerShell log
    carries as `HostApplication=` inside the message body rather than as a
    field of its own — so it is preferred when present, and the whole message
    used otherwise.
    """
    message = str(event.get("Message") or "")
    event_id = int(event.get("Id") or 0)

    command = None
    for pattern in (_HOST_APPLICATION_RE, _COMMAND_LINE_RE):
        found = pattern.search(message)
        if found:
            command = found.group(1).strip()
            break

    detail = _condense(command or message)[:1200]
    detail = redact_local_identity(decode_encoded_commands(detail))

    source_process = "powershell.exe"
    if command:
        executable = command.split()[0].strip('"')
        source_process = Path(executable).name or source_process

    return {
        "timestamp": str(event.get("TimeCreated") or ""),
        "source_process": source_process,
        "event_type": _EVENT_TYPES.get(event_id, "log_event"),
        "detail": detail,
    }


_EVENT_TYPES = {
    400: "process_create",       # engine started — carries the full command line
    403: "process_create",       # engine stopped — same, and always present
    600: "provider_lifecycle",
    800: "pipeline_execution",
    4103: "pipeline_execution",  # module logging
    4104: "script_block",        # script-block logging, when enabled
    4688: "process_create",      # Security log, needs admin to read
}


def _run_powershell(script: str) -> str:
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"Get-WinEvent failed: {(completed.stderr or '').strip()[:400]}"
        )
    return completed.stdout


def read_windows_event_log(
    log_name: str,
    *,
    event_ids: list[int] | None = None,
    max_events: int = WINEVENT_MAX_EVENTS,
) -> list[dict[str, str]]:
    """Read real events from the live Windows Event Log.

    Shells out to `Get-WinEvent` rather than taking a dependency: it is present
    on every Windows host, needs no install, and reads the `Windows PowerShell`
    and `Microsoft-Windows-PowerShell/Operational` channels without admin.
    """
    if sys.platform != "win32":
        raise RuntimeError("winevent sources are only available on Windows")

    filters = [f"LogName='{log_name}'"]
    if event_ids:
        filters.append("Id=@(" + ",".join(str(i) for i in event_ids) + ")")
    script = (
        f"$ErrorActionPreference='Stop';"
        f"Get-WinEvent -FilterHashtable @{{{'; '.join(filters)}}} "
        f"-MaxEvents {int(max_events)} | "
        "Select-Object @{N='TimeCreated';E={$_.TimeCreated.ToUniversalTime()"
        ".ToString('yyyy-MM-ddTHH:mm:ssZ')}}, Id, ProviderName, Message | "
        "ConvertTo-Json -Depth 3 -Compress"
    )
    raw = _run_powershell(script).strip()
    if not raw:
        return []

    parsed = json.loads(raw)
    events = parsed if isinstance(parsed, list) else [parsed]
    rows = [event_to_row(e) for e in events]
    # Get-WinEvent returns newest first; the agent reasons forwards in time.
    rows.reverse()
    return rows


def read_jsonl(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def read_plain_file(path: Path) -> list[dict[str, str]]:
    """One event per line, with no structure to lean on.

    Timestamp and process are extracted if the line happens to start with them,
    and left blank otherwise — the agent reasons over `detail` either way.
    """
    rows: list[dict[str, str]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        stamp = ""
        found = re.match(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*)\s+(.*)$", line)
        if found:
            stamp, line = found.group(1).replace(" ", "T"), found.group(2)
        rows.append(
            {
                "timestamp": stamp,
                "source_process": "",
                "event_type": "log_event",
                "detail": redact_local_identity(decode_encoded_commands(line))[:1200],
            }
        )
    return rows


def parse_spec(spec: str) -> tuple[str, str]:
    """Split `<kind>:<argument>`, defaulting to jsonl for a bare path."""
    kind, separator, argument = spec.partition(":")
    if not separator:
        return "jsonl", spec
    # A bare Windows path (C:\...) is a path, not a source kind.
    if len(kind) == 1:
        return "jsonl", spec
    return kind.strip().lower(), argument.strip()


def load_rows(
    spec: str,
    *,
    base_dir: Path,
    event_ids: list[int] | None = None,
    max_events: int = WINEVENT_MAX_EVENTS,
) -> list[dict[str, str]]:
    """Resolve a source spec to rows. The agent's only way of reading anything."""
    kind, argument = parse_spec(spec)

    if kind == "winevent":
        return read_windows_event_log(
            argument, event_ids=event_ids, max_events=max_events
        )

    path = Path(argument)
    if not path.is_absolute():
        path = base_dir / path

    if kind == "jsonl":
        return read_jsonl(path)
    if kind == "file":
        return read_plain_file(path)

    raise ValueError(f"unknown log source kind {kind!r} (expected jsonl, file, winevent)")
