"""org_a's Flower AgentApp — see CLAUDE.md §4.

Reads only this org's own mock log, classifies each row, extracts an
anonymized signature for anything flagged, and POSTs that signature (never
raw log content) to the correlation server. One pass per run.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from flwr.agentapp import AgentApp, AgentSession
from flwr.app import Context

# Model output (e.g. em dashes, arrows) can contain characters the Windows
# console's legacy codepage can't encode; without this, printing it crashes
# the whole run rather than just losing a glyph.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

app = AgentApp()

CONFIDENCE_THRESHOLD_DEFAULT = 0.5
REQUEST_TIMEOUT_SECONDS = 5.0

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_INTERNAL_TOKEN_RE = re.compile(r"\b(corp|internal|hostname)\b", re.IGNORECASE)

CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "flag": {"type": "boolean"},
        "reason": {"type": "string"},
    },
    "required": ["flag", "reason"],
    "additionalProperties": False,
}

CLASSIFY_INSTRUCTIONS = (
    "You are a first-pass triage agent reviewing ONE log line from your own "
    "organization's security telemetry. You will never see another "
    "organization's data. Decide whether this line is ordinary background "
    "noise or worth escalating as possibly part of a broader, "
    "multi-organization attack pattern (for example: a living-off-the-land "
    "technique, unusual process ancestry, or beaconing-like outbound "
    "behavior)."
)

# All fields required-but-nullable, per OpenAI-style strict structured output:
# a single flat schema (no oneOf) that still lets the model signal failure by
# nulling every signature field and filling `error` instead.
EXTRACT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "error": {"type": ["string", "null"]},
        "technique": {"type": ["string", "null"]},
        "indicator": {"type": ["string", "null"]},
        "window_start": {"type": ["string", "null"]},
        "window_end": {"type": ["string", "null"]},
        "confidence": {"type": ["number", "null"]},
    },
    "required": [
        "error",
        "technique",
        "indicator",
        "window_start",
        "window_end",
        "confidence",
    ],
    "additionalProperties": False,
}

EXTRACT_INSTRUCTIONS = (
    "You are extracting a SHAREABLE signature from a flagged security log "
    "line, to be sent to an external cross-organization correlation "
    "service.\n\n"
    "CRITICAL RULES:\n"
    "- NEVER include a company name, hostname, username, or raw IP address "
    "in any field.\n"
    "- NEVER include a raw domain name that identifies YOUR OWN "
    "organization or its internal infrastructure.\n"
    "- EXCEPTION: the 'indicator' field is allowed to contain the raw "
    "external attacker-controlled token (e.g. a malicious domain-like "
    "string) — that is external infrastructure, not information about your "
    "own organization, and the caller will hash it before it ever leaves "
    "this process.\n"
    "- If you cannot produce a compliant signature without leaking "
    "identifying detail about your OWN organization, set 'error' to a short "
    "reason and leave every other field null."
)


def _extract_structured_output(response: dict[str, Any]) -> dict[str, Any]:
    """Pull the JSON payload out of an Open-Responses-shaped model response."""
    output_text = response.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return json.loads(output_text)

    for item in response.get("output", []) or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue  # skip reasoning/other non-answer items (e.g. Kimi's reasoning trace)
        for part in item.get("content", []) or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                return json.loads(part["text"])

    raise ValueError(f"No structured output found in model response: {response!r}")


def _classify(agent: AgentSession, model: str, row: dict[str, str]) -> tuple[bool, str]:
    response = agent.responses.create(
        {
            "model": model,
            "instructions": CLASSIFY_INSTRUCTIONS,
            "input": f"Log line (JSON): {json.dumps(row)}",
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "classification",
                    "schema": CLASSIFY_SCHEMA,
                    "strict": True,
                }
            },
        }
    )
    payload = _extract_structured_output(response)
    return bool(payload["flag"]), str(payload["reason"])


def _extract(agent: AgentSession, model: str, row: dict[str, str]) -> dict[str, Any] | None:
    response = agent.responses.create(
        {
            "model": model,
            "instructions": EXTRACT_INSTRUCTIONS,
            "input": f"Log line (JSON): {json.dumps(row)}",
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "signature_extraction",
                    "schema": EXTRACT_SCHEMA,
                    "strict": True,
                }
            },
        }
    )
    payload = _extract_structured_output(response)
    if payload.get("error"):
        return None
    required = ("technique", "indicator", "window_start", "window_end", "confidence")
    if any(payload.get(field) is None for field in required):
        return None
    return payload


def _has_identifying_content(signature: dict[str, Any]) -> bool:
    """Deterministic guard-rail — see CLAUDE.md §4.3c. Never trust the model's word."""
    for field in ("technique", "window_start", "window_end"):
        value = signature.get(field)
        if not isinstance(value, str):
            continue
        if _IPV4_RE.search(value) or _INTERNAL_TOKEN_RE.search(value):
            return True
    return False


def _normalize_indicator(raw: str) -> str:
    """Strip scheme/whitespace/trailing punctuation so identical infra hashes
    identically across orgs, regardless of minor formatting differences."""
    value = raw.strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    value = value.rstrip("/.")
    return value


def _hash_indicator(raw: str) -> str:
    normalized = _normalize_indicator(raw)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


@app.main()
def main(agent: AgentSession, context: Context) -> None:
    org_id = str(context.run_config["agent.org_id"])
    log_path = Path(str(context.run_config["agent.log_path"]))
    server_url = str(context.run_config["agent.server_url"])
    model = str(context.run_config.get("agent.model", "Kimi-K2.7-Code"))

    if not log_path.is_absolute():
        log_path = Path(__file__).resolve().parent.parent / log_path

    with log_path.open(encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    print(f"[{org_id}] loaded {len(rows)} log rows from {log_path}")

    for i, row in enumerate(rows):
        try:
            flag, reason = _classify(agent, model, row)
        except Exception as exc:  # model/network failure — skip this row, keep going
            print(f"[{org_id}] row {i}: classify failed ({exc}); skipping")
            continue

        print(f"[{org_id}] row {i}: flag={flag} reason={reason!r}")
        if not flag:
            continue

        try:
            signature = _extract(agent, model, row)
        except Exception as exc:
            print(f"[{org_id}] row {i}: extract failed ({exc}); dropping row")
            continue

        if signature is None:
            print(f"[{org_id}] row {i}: model could not redact safely; dropping row")
            continue

        if _has_identifying_content(signature):
            print(f"[{org_id}] row {i}: guard-rail rejected signature; dropping row")
            continue

        window_start = signature["window_start"]
        window_end = signature["window_end"]
        if not _valid_timestamp(window_start) or not _valid_timestamp(window_end):
            window_start = window_end = row["timestamp"]

        indicator_hash = _hash_indicator(str(signature["indicator"]))

        outgoing = {
            "org_id": org_id,
            "technique": signature["technique"],
            "indicator": indicator_hash,
            "window_start": window_start,
            "window_end": window_end,
            "confidence": float(signature["confidence"]),
        }

        try:
            resp = requests.post(server_url, json=outgoing, timeout=REQUEST_TIMEOUT_SECONDS)
            print(
                f"[{org_id}] row {i}: sent technique={outgoing['technique']} "
                f"indicator_hash={indicator_hash} -> HTTP {resp.status_code}"
            )
        except requests.RequestException as exc:
            print(f"[{org_id}] row {i}: submission failed ({exc})")

    print(f"[{org_id}] run complete — {len(rows)} rows processed")
