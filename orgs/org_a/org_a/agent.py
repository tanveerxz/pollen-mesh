"""Pollen Mesh org agent — see CLAUDE.md §4.

Reads only this org's own mock log, triages each row with a live model, and for
anything worth escalating submits a stripped, hashed signature to the
correlation server. One pass per run. Nothing else leaves the process.

The org id, log path and server URL all come from run config, so this file is
identical across org_a / org_b / org_c.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from flwr.agentapp import AgentApp, AgentSession
from flwr.app import Context

app = AgentApp()

# Model output can contain characters the Windows console codepage can't encode;
# without this a stray arrow or em dash kills the whole run (see CLAUDE.md §0b).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REQUEST_TIMEOUT_SECONDS = 5.0
MODEL_ATTEMPTS = 3           # transient failures are common; retry before giving up
TRIAGE_VOTES = 2             # escalate if ANY vote says so — recall beats precision here

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_INTERNAL_TOKEN_RE = re.compile(r"\b(corp|internal|hostname)\b", re.IGNORECASE)
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_DOMAIN_RE = re.compile(
    r"\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b", re.IGNORECASE
)

# Ordinary corporate destinations. Never a shareable indicator, so the agent has
# to actually discriminate rather than hash the first domain it sees.
BENIGN_DOMAINS = {
    "windowsupdate.microsoft.com", "teams.microsoft.com", "slack.com",
    "outlook.office365.com", "cdn-assets-fastly.net", "news-aggregator.com",
    "news-site.com", "backup-vendor.com", "github.com",
    "login.microsoftonline.com", "microsoft.com", "office.com",
}

# --- triage -----------------------------------------------------------------
# `reason` is generated BEFORE `escalate` on purpose: with the boolean first the
# model commits to an answer and then rationalises it, which measured ~50% recall
# on the campaign row. Reasoning first took that to 15/15 across all three shared
# models (benchmarked 2026-08-26). Do not reorder these properties.
TRIAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"reason": {"type": "string"}, "escalate": {"type": "boolean"}},
    "required": ["reason", "escalate"],
    "additionalProperties": False,
}

TRIAGE_INSTRUCTIONS = (
    "You are a first-pass triage agent reviewing ONE log line from your own "
    "organization's security telemetry. You will never see another "
    "organization's data.\n\n"
    "Write your analysis in 'reason' FIRST, then set 'escalate' to match that "
    "analysis.\n"
    "Escalate when the line shows a living-off-the-land technique, anomalous "
    "process ancestry (an Office application spawning a shell), encoded or "
    "obfuscated command lines, credential-harvesting behaviour, destructive "
    "staging, or beaconing-like outbound traffic to non-corporate "
    "infrastructure.\n"
    "Do NOT escalate routine vendor traffic (Windows Update, Teams, Slack, "
    "CDNs) or ordinary user file access.\n"
    "If your reason describes the activity as suspicious, malicious, anomalous, "
    "or says to escalate, then 'escalate' MUST be true."
)

# --- technique --------------------------------------------------------------
# The model is NOT asked for the indicator. Requesting an attacker domain reads
# as an exfiltration request and gets refused by safety filters on some models;
# the agent extracts it deterministically below instead, which is both
# unrefusable and reproducible across orgs.
TECHNIQUE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "rationale": {"type": "string"},
        "technique": {"type": "string"},
        "confidence": {"type": "number"},
    },
    "required": ["rationale", "technique", "confidence"],
    "additionalProperties": False,
}

TECHNIQUE_INSTRUCTIONS = (
    "Classify this already-triaged suspicious security event with a MITRE "
    "ATT&CK technique id.\n"
    "Reply with the id in 'technique' (format T#### or T####.###), a one-line "
    "'rationale', and a 'confidence' between 0 and 1.\n"
    "Do not include any hostname, username, IP address, or organization name."
)


def _structured_output(response: dict[str, Any]) -> dict[str, Any]:
    """Pull the JSON payload out of an Open-Responses-shaped model response."""
    text = response.get("output_text")
    if isinstance(text, str) and text.strip():
        return json.loads(text)

    for item in response.get("output", []) or []:
        # Reasoning-tuned models emit a 'reasoning' item before the answer; only
        # the 'message' item carries the schema-constrained JSON.
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content", []) or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                return json.loads(part["text"])

    error = response.get("error")
    if error:
        raise ValueError(f"model error: {error}")
    raise ValueError("no structured output in model response")


def _ask(
    agent: AgentSession,
    model: str,
    instructions: str,
    schema: dict[str, Any],
    name: str,
    row: dict[str, str],
) -> dict[str, Any]:
    """One schema-constrained model call, retried on transient failure."""
    last: Exception | None = None
    for attempt in range(MODEL_ATTEMPTS):
        try:
            response = agent.responses.create(
                {
                    "model": model,
                    "instructions": instructions,
                    "input": f"Log line (JSON): {json.dumps(row)}",
                    "text": {
                        "format": {
                            "type": "json_schema",
                            "name": name,
                            "schema": schema,
                            "strict": True,
                        }
                    },
                }
            )
            return _structured_output(response)
        except Exception as exc:  # noqa: BLE001 - retry any transport/parse failure
            last = exc
            if attempt < MODEL_ATTEMPTS - 1:
                time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"model call failed after {MODEL_ATTEMPTS} attempts: {last}")


def _triage(agent: AgentSession, model: str, row: dict[str, str]) -> tuple[bool, str]:
    """Escalate if ANY vote escalates: a missed campaign row is far more costly
    than one extra signature, which correlation would simply never match."""
    reason = ""
    for _ in range(TRIAGE_VOTES):
        verdict = _ask(
            agent, model, TRIAGE_INSTRUCTIONS, TRIAGE_SCHEMA, "triage", row
        )
        reason = str(verdict.get("reason", ""))
        if bool(verdict.get("escalate")):
            return True, reason
    return False, reason


def extract_indicator(row: dict[str, str]) -> str | None:
    """Deterministically pull the external attacker token out of the row.

    Done in code rather than by the model so it is reproducible across orgs —
    two orgs seeing the same infrastructure must produce the same hash — and so
    no safety filter can refuse it.
    """
    detail = row.get("detail") or ""
    for match in _DOMAIN_RE.finditer(detail):
        candidate = match.group(1).lower().rstrip(".")
        if candidate in BENIGN_DOMAINS or candidate.endswith(".exe"):
            continue
        return candidate
    return None


def _normalize_indicator(raw: str) -> str:
    value = raw.strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    return value.rstrip("/.")


def _hash_indicator(raw: str) -> str:
    return hashlib.sha256(_normalize_indicator(raw).encode("utf-8")).hexdigest()[:16]


def _leaks_identity(*values: str) -> bool:
    """Deterministic guard-rail (§4.3c) — independent of what the model claims."""
    for value in values:
        if _IPV4_RE.search(value) or _INTERNAL_TOKEN_RE.search(value):
            return True
    return False


@app.main()
def main(agent: AgentSession, context: Context) -> None:
    org_id = str(context.run_config["agent.org_id"])
    log_path = Path(str(context.run_config["agent.log_path"]))
    server_url = str(context.run_config["agent.server_url"])
    model = str(context.run_config.get("agent.model", "/models/Kimi-K2.7-Code"))

    if not log_path.is_absolute():
        log_path = Path(__file__).resolve().parent.parent / log_path

    # The working log is gitignored (attacks mutate it); regenerate it from the
    # committed seed if it's absent — e.g. on a fresh clone or FAB build.
    if not log_path.exists():
        seed = log_path.with_name(log_path.stem + ".seed" + log_path.suffix)
        if seed.exists():
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(seed.read_text(encoding="utf-8"), encoding="utf-8")

    with log_path.open(encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    print(f"[{org_id}] {len(rows)} rows from {log_path.name} | model={model}")
    sent = 0

    for i, row in enumerate(rows):
        try:
            escalate, reason = _triage(agent, model, row)
        except Exception as exc:  # noqa: BLE001
            print(f"[{org_id}] row {i}: triage failed ({exc}) — skipping")
            continue

        if not escalate:
            print(f"[{org_id}] row {i}: noise — {reason[:90]}")
            continue

        print(f"[{org_id}] row {i}: ESCALATE — {reason[:90]}")

        indicator = extract_indicator(row)
        if indicator is None:
            print(f"[{org_id}] row {i}: no external indicator to share — dropped")
            continue

        try:
            verdict = _ask(
                agent, model, TECHNIQUE_INSTRUCTIONS, TECHNIQUE_SCHEMA,
                "technique", row,
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[{org_id}] row {i}: technique call failed ({exc}) — dropped")
            continue

        technique = str(verdict.get("technique", "")).strip().upper()
        if not _TECHNIQUE_RE.match(technique):
            print(f"[{org_id}] row {i}: bad technique {technique!r} — dropped")
            continue

        try:
            confidence = float(verdict.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        confidence = min(max(confidence, 0.0), 1.0)

        if _leaks_identity(technique):
            print(f"[{org_id}] row {i}: guard-rail rejected signature — dropped")
            continue

        indicator_hash = _hash_indicator(indicator)
        payload = {
            "org_id": org_id,
            "technique": technique,
            "indicator": indicator_hash,
            "window_start": row["timestamp"],
            "window_end": row["timestamp"],
            "confidence": confidence,
        }

        try:
            res = requests.post(
                server_url, json=payload, timeout=REQUEST_TIMEOUT_SECONDS
            )
            sent += 1
            print(
                f"[{org_id}] row {i}: SENT {technique} hash={indicator_hash} "
                f"conf={confidence:.2f} -> HTTP {res.status_code}"
            )
        except requests.RequestException as exc:
            print(f"[{org_id}] row {i}: submission failed ({exc})")

    print(f"[{org_id}] done — {sent} signature(s) released from {len(rows)} rows")
