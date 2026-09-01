"""Pollen Mesh org agent — see CLAUDE.md §4.

Reads only this org's own mock log, triages each row with a live model, and for
anything worth escalating submits a stripped, hashed signature to the
correlation server. One pass per run. Nothing else leaves the process.

The org id, log path, server URL and model all come from run config, so one copy
of this app serves any organization.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

import requests
from flwr.agentapp import AgentApp, AgentSession
from flwr.app import Context

from . import sources

app = AgentApp()

# Model output can contain characters the Windows console codepage can't encode;
# without this a stray arrow or em dash kills the whole run (see CLAUDE.md §0b).
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CONSORTIUM_KEY_ENV = "POLLEN_CONSORTIUM_KEY"
# Well-known default so `git clone && run` works with no setup. A real
# consortium MUST set POLLEN_CONSORTIUM_KEY to its own secret — with this
# default the indicator hashes are reversible by anyone who reads this file.
DEMO_CONSORTIUM_KEY = "pollen-mesh-public-demo-key-not-for-real-use"

REQUEST_TIMEOUT_SECONDS = 5.0
MODEL_ATTEMPTS = 3           # transient failures are common; retry before giving up
TRIAGE_VOTES = 2             # escalate if ANY vote says so — recall beats precision here

_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_INTERNAL_TOKEN_RE = re.compile(r"\b(corp|internal|hostname)\b", re.IGNORECASE)
_TECHNIQUE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_DOMAIN_RE = re.compile(
    r"\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b", re.IGNORECASE
)
# A URL is unambiguous, so it is looked for first and wins outright.
_URL_RE = re.compile(
    r"\b[a-z][a-z0-9+.-]*://((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})",
    re.IGNORECASE,
)

# Real telemetry is full of dotted tokens that are not domains: file names
# (`install.py`), object paths (`TimeCreated.ToUniversalTime`), namespaced
# identifiers. Hashing one of those produces an indicator no other org can ever
# match, and — worse — two orgs running the same tooling could match on it and
# manufacture a correlation out of nothing. So a bare dotted token is only
# treated as a domain if its last label is an actual TLD.
_KNOWN_TLDS = {
    # generic
    "com", "net", "org", "info", "biz", "name", "pro", "mobi", "asia", "int",
    "edu", "gov", "mil", "app", "dev", "cloud", "tech", "online", "site",
    "store", "shop", "live", "space", "website", "click", "link", "work",
    "fun", "top", "xyz", "icu", "cyou", "monster", "buzz", "digital", "email",
    "agency", "systems", "solutions", "services", "network", "host", "press",
    "one", "world", "life", "today", "team", "group", "center", "company",
    # country codes seen in threat intel
    "io", "ai", "co", "me", "tv", "cc", "ws", "su", "ru", "cn", "uk", "de",
    "fr", "it", "es", "nl", "se", "no", "fi", "dk", "pl", "cz", "ro", "gr",
    "pt", "hu", "ch", "at", "be", "ie", "il", "ae", "sa", "tr", "ua", "us",
    "ca", "au", "nz", "jp", "kr", "sg", "hk", "tw", "in", "id", "th", "vn",
    "ph", "my", "br", "mx", "ar", "cl", "za", "ng", "ke", "eu", "tk", "ml",
    "ga", "cf", "gq", "pw", "sh", "st", "to", "vc", "gg", "im",
}

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


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _loads_lenient(text: str) -> dict[str, Any]:
    """Parse the JSON object out of a model reply.

    Not every Open-Responses endpoint honours `text.format.json_schema`. Venice,
    for one, accepts the request and returns prose anyway — measured across five
    models, reasoning and not. Rather than restrict which providers this agent
    works with, the schema is also stated in the prompt and the reply is parsed
    leniently: exact JSON first, then a fenced block, then the first balanced
    object in the text.

    This is recovery, not guesswork — every field is still validated by the
    caller (`_TECHNIQUE_RE`, the confidence clamp, `_leaks_identity`), so a
    malformed or invented reply is rejected exactly as before.
    """
    text = text.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass

    fenced = _JSON_FENCE_RE.search(text)
    if fenced:
        try:
            parsed = json.loads(fenced.group(1))
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass

    start = text.find("{")
    while start != -1:
        depth, in_string, escaped = 0, False, False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(text[start : index + 1])
                        if isinstance(parsed, dict):
                            return parsed
                    except ValueError:
                        pass
                    break
        start = text.find("{", start + 1)

    raise ValueError(f"no JSON object in model reply: {text[:160]!r}")


def _structured_output(response: dict[str, Any]) -> dict[str, Any]:
    """Pull the JSON payload out of an Open-Responses-shaped model response."""
    text = response.get("output_text")
    if isinstance(text, str) and text.strip():
        return _loads_lenient(text)

    for item in response.get("output", []) or []:
        # Reasoning-tuned models emit a 'reasoning' item before the answer; only
        # the 'message' item carries the answer.
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content", []) or []:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                if not part["text"].strip():
                    continue
                return _loads_lenient(part["text"])

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
    # The schema is sent twice on purpose: as `text.format` for endpoints that
    # enforce it, and restated in the prompt for those that quietly ignore it.
    # Belt and braces costs a few tokens and is the difference between working
    # against any Open-Responses provider and only the strict ones.
    instructions = (
        f"{instructions}\n\n"
        f"Reply with ONLY a JSON object matching this schema, and nothing else "
        f"— no prose, no explanation, no markdown fences:\n{json.dumps(schema)}"
    )
    last: Exception | None = None
    for attempt in range(MODEL_ATTEMPTS):
        try:
            response = agent.responses.create(
                {
                    "model": model,
                    # Sent as a system item in `input` rather than the separate
                    # `instructions` field: some Open-Responses endpoints drop
                    # `instructions` silently, so the model answers as if it had
                    # no system prompt at all — measured on Venice, which then
                    # returned conversational prose for every model. `input`
                    # accepting a list of item objects is part of the spec, and
                    # is honoured everywhere tested.
                    "input": [
                        {"role": "system", "content": instructions},
                        {
                            "role": "user",
                            "content": f"Log line (JSON): {json.dumps(row)}",
                        },
                    ],
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

    # A URL says outright that the token is a network destination.
    for match in _URL_RE.finditer(detail):
        candidate = match.group(1).lower().rstrip(".")
        if not _is_benign(candidate):
            return candidate

    for match in _DOMAIN_RE.finditer(detail):
        candidate = match.group(1).lower().rstrip(".")
        if _is_benign(candidate):
            continue
        # Reject anything sitting inside a filesystem path: `C:\tools\build.py`
        # is a file, not infrastructure.
        if match.start() > 0 and detail[match.start() - 1] in "\\/":
            continue
        if candidate.rsplit(".", 1)[-1] not in _KNOWN_TLDS:
            continue
        return candidate
    return None


def _is_benign(candidate: str) -> bool:
    if candidate in BENIGN_DOMAINS:
        return True
    # Also cover subdomains of a benign registrable domain.
    return _registrable_domain(candidate) in BENIGN_DOMAINS


def _consortium_key() -> bytes:
    """The shared secret that makes an indicator hash unreversible.

    Held by consortium MEMBERS only. The correlator never receives it, which is
    what lets it match two signatures without being able to learn what it
    matched. Without a key, `sha256(domain)` is trivially reversible: the
    preimage space is just "domains", and the value published in our own README
    was recovered in 121 guesses. See docs/threat-model.md.
    """
    return os.environ.get(CONSORTIUM_KEY_ENV, DEMO_CONSORTIUM_KEY).encode("utf-8")


# Suffixes where the registrable name is the THIRD label from the right, not the
# second. Without these, "example.co.uk" would collapse to the useless "co.uk".
# An approximation of the Public Suffix List covering the common cases; the full
# PSL would be more correct but needs a dependency that fetches at runtime.
_MULTI_PART_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "co.za", "co.jp", "or.jp", "ne.jp", "ac.jp",
    "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk",
    "co.in", "co.kr", "co.il", "com.ar", "com.pl", "com.tw",
}


def _registrable_domain(host: str) -> str:
    """Collapse a hostname to the domain someone actually registered.

    Attacker infrastructure appears at different orgs under different
    subdomains — one sees `www.evil.net`, another `cdn.evil.net`. Matching the
    full hostname misses that; matching the registrable domain catches it,
    which is also the granularity threat intel is normally shared at.

    Left alone if it is an IP address or already a bare name.
    """
    if _IPV4_RE.fullmatch(host):
        return host
    labels = host.split(".")
    if len(labels) < 3:
        return host
    if ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def _normalize_indicator(raw: str) -> str:
    value = raw.strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    value = value.split("/")[0].split(":")[0]  # drop any path or port
    value = value.rstrip("/.")
    return _registrable_domain(value)


def _hash_indicator(raw: str) -> str:
    """Keyed HMAC, not a bare hash — see _consortium_key.

    Two orgs holding the same key still produce identical values for the same
    indicator, so correlation is unchanged; nobody outside the consortium can
    enumerate the space to reverse one.
    """
    return hmac.new(
        _consortium_key(),
        _normalize_indicator(raw).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:16]


def hunt_own_log(
    rows: list[dict[str, str]], indicator_hash: str
) -> list[dict[str, object]]:
    """Retro-hunt THIS org's own log for a disclosed indicator hash.

    This is the whole point of keying the indicator. The org is told only an
    opaque value; it re-derives the same value over its own tokens and compares.
    It can discover it was hit — and find events it originally missed — without
    ever being told what the indicator is, and without its logs leaving the
    machine.

    Deliberately implemented here, in the agent, and not on the correlator: a
    correlator that greps your raw logs is exactly the thing this system exists
    to avoid.
    """
    hits: list[dict[str, object]] = []
    for index, row in enumerate(rows):
        detail = row.get("detail") or ""
        for match in _DOMAIN_RE.finditer(detail):
            token = match.group(1).lower().rstrip(".")
            if _hash_indicator(token) == indicator_hash:
                hits.append({
                    "row": index,
                    "timestamp": row.get("timestamp"),
                    "source_process": row.get("source_process"),
                    "event_type": row.get("event_type"),
                    "detail": detail,
                })
                break
    return hits


def _leaks_identity(*values: str) -> bool:
    """Deterministic guard-rail (§4.3c) — independent of what the model claims."""
    for value in values:
        if _IPV4_RE.search(value) or _INTERNAL_TOKEN_RE.search(value):
            return True
    return False


# --- watermark ----------------------------------------------------------------
# Without this, re-running an agent over an unchanged log re-triages every row
# (slow, and burns model calls) and resubmits every signature it already sent,
# so one real-world event ends up counted three times. The correlator dedupes
# too, but an agent that knows what it has already seen is the right place to
# stop: a re-run should cost only the rows that are actually new.


def _row_fingerprint(row: dict[str, str]) -> str:
    """Stable id for a log row, independent of key order and position."""
    canonical = json.dumps(row, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _watermark_path(log_path: Path) -> Path:
    return log_path.with_name(log_path.stem + ".watermark.json")


def load_watermark(log_path: Path) -> dict[str, dict[str, str]]:
    path = _watermark_path(log_path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}  # a corrupt watermark means "re-process", never "crash"
    seen = data.get("seen")
    return seen if isinstance(seen, dict) else {}


def save_watermark(log_path: Path, seen: dict[str, dict[str, str]]) -> None:
    path = _watermark_path(log_path)
    try:
        path.write_text(
            json.dumps({"version": 1, "seen": seen}, indent=2), encoding="utf-8"
        )
    except OSError as exc:  # noqa: BLE001 - a read-only dir must not fail the run
        print(f"[watermark] could not persist: {exc}")


def _parse_event_ids(raw: str) -> list[int]:
    return [int(part) for part in re.split(r"[,\s]+", raw.strip()) if part.isdigit()]


def _resolve_source(context: Context) -> tuple[str, Path, Path]:
    """Return (source spec, base dir, watermark anchor).

    `agent.log_source` is the general form (`jsonl:`, `file:`, `winevent:`).
    `agent.log_path` remains as it was so existing configs keep working — it is
    just the jsonl case spelled out.
    """
    base_dir = Path(__file__).resolve().parent.parent
    spec = str(context.run_config.get("agent.log_source", "")).strip()
    if not spec:
        spec = f"jsonl:{context.run_config['agent.log_path']}"

    kind, argument = sources.parse_spec(spec)
    if kind == "winevent":
        # Live channel — nothing on disk to sit beside, so the watermark is
        # keyed by channel name under the project's own data directory.
        safe = re.sub(r"[^A-Za-z0-9]+", "_", argument).strip("_").lower()
        anchor = base_dir / "data" / f"winevent_{safe}.jsonl"
        anchor.parent.mkdir(parents=True, exist_ok=True)
        return spec, base_dir, anchor

    path = Path(argument)
    if not path.is_absolute():
        path = base_dir / path
    return spec, base_dir, path


@app.main()
def main(agent: AgentSession, context: Context) -> None:
    org_id = str(context.run_config["agent.org_id"])
    server_url = str(context.run_config["agent.server_url"])
    model = str(context.run_config.get("agent.model", "zai-org-glm-5-2"))

    spec, base_dir, log_path = _resolve_source(context)
    kind, _argument = sources.parse_spec(spec)

    # The working log is gitignored (attacks mutate it); regenerate it from the
    # committed seed if it's absent — e.g. on a fresh clone or FAB build.
    if kind != "winevent" and not log_path.exists():
        seed = log_path.with_name(log_path.stem + ".seed" + log_path.suffix)
        if seed.exists():
            log_path.parent.mkdir(parents=True, exist_ok=True)
            log_path.write_text(seed.read_text(encoding="utf-8"), encoding="utf-8")

    event_ids = _parse_event_ids(str(context.run_config.get("agent.log_event_ids", "")))
    max_events = int(context.run_config.get("agent.log_max_events", sources.WINEVENT_MAX_EVENTS))

    try:
        rows = sources.load_rows(
            spec, base_dir=base_dir, event_ids=event_ids, max_events=max_events
        )
    except Exception as exc:  # noqa: BLE001 - an unreadable source is a config error
        print(f"[{org_id}] cannot read log source {spec!r}: {exc}")
        return

    # Hunt mode: no model calls, no submission — just answer "was I hit too?"
    # against our own log, using a hash someone else disclosed.
    mode = str(context.run_config.get("agent.mode", "triage"))
    if mode == "hunt":
        wanted = str(context.run_config.get("agent.hunt_hash", "")).strip()
        if not wanted:
            print(f"[{org_id}] hunt mode needs agent.hunt_hash")
            return
        hits = hunt_own_log(rows, wanted)
        print(f"[{org_id}] hunted {len(rows)} local rows for {wanted}")
        for hit in hits:
            print(f"[{org_id}] HIT row {hit['row']} {hit['timestamp']} {hit['source_process']}")
        print(f"[{org_id}] hunt complete — {len(hits)} matching event(s) in our own history")
        return

    # Preflight: prove the model is reachable before working through the log.
    # Without this, an unreachable endpoint fails every row independently — each
    # retrying three times behind a 180s connect timeout — so a dead endpoint
    # looks like a slow run for several minutes before admitting anything is
    # wrong. That happened live on 2026-08-31, when the shared endpoints the
    # demo was configured against were withdrawn after the event.
    try:
        _ask(
            agent, model, TRIAGE_INSTRUCTIONS, TRIAGE_SCHEMA, "triage",
            {"detail": "preflight: routine outbound TCP 443 to slack.com"},
        )
    except Exception as exc:  # noqa: BLE001
        print(
            f"[{org_id}] model {model!r} is not reachable — aborting before "
            f"reading any rows.\n"
            f"[{org_id}] check FLWR_MODEL_API_ENDPOINT / FLWR_MODEL_API_KEY, and "
            f"remember the local SuperLink keeps the environment it started with "
            f"(kill flower-superlink to pick up new values).\n"
            f"[{org_id}] {exc}"
        )
        return

    rescan = str(context.run_config.get("agent.rescan", "")).lower() in {"1", "true", "yes"}
    seen = {} if rescan else load_watermark(log_path)
    new_rows = [(i, r) for i, r in enumerate(rows) if _row_fingerprint(r) not in seen]

    print(
        f"[{org_id}] {len(rows)} rows from {spec} | model={model} | "
        f"{len(new_rows)} new, {len(rows) - len(new_rows)} already triaged"
    )
    sent = 0

    for i, row in enumerate(rows):
        fingerprint = _row_fingerprint(row)
        previous = seen.get(fingerprint)
        if previous is not None:
            print(
                f"[{org_id}] row {i}: already triaged "
                f"({previous.get('outcome', 'seen')}) — skipping"
            )
            continue

        def remember(outcome: str, **extra: str) -> None:
            seen[fingerprint] = {"outcome": outcome, **extra}
            save_watermark(log_path, seen)

        try:
            escalate, reason = _triage(agent, model, row)
        except Exception as exc:  # noqa: BLE001
            # Deliberately NOT watermarked: a transient failure must be retried
            # on the next run, not silently swallowed forever.
            print(f"[{org_id}] row {i}: triage failed ({exc}) — skipping")
            continue

        if not escalate:
            print(f"[{org_id}] row {i}: noise — {reason[:90]}")
            remember("noise")
            continue

        print(f"[{org_id}] row {i}: ESCALATE — {reason[:90]}")

        indicator = extract_indicator(row)
        if indicator is None:
            print(f"[{org_id}] row {i}: no external indicator to share — dropped")
            remember("no-indicator")
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
            remember("guard-rail")
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
            # Only watermark once it is actually delivered — a failed POST must
            # be retried on the next run.
            remember("sent", technique=technique, indicator=indicator_hash)
        except requests.RequestException as exc:
            print(f"[{org_id}] row {i}: submission failed ({exc})")

    print(
        f"[{org_id}] done — {sent} signature(s) released from "
        f"{len(new_rows)} new row(s) ({len(rows)} in log)"
    )
