# Pollen Mesh Agent

**Reason over your own security log locally. Share only a stripped, hashed signature.**

When a coordinated attack hits several companies at once, each security team sees only
its own sliver — one odd process chain here, one strange outbound connection there.
Individually it looks like noise; only comparing notes makes the pattern obvious. But
companies won't hand each other raw security logs.

This AgentApp is the per-organization half of [Pollen Mesh](https://github.com/tanveerxz/pollen-mesh).
It runs **inside** one organization, reads **only that organization's own log**, and the
only thing it ever emits is an anonymized signature:

| Field | Example | Notes |
|---|---|---|
| `technique` | `T1059.001` | MITRE ATT&CK id |
| `indicator` | `12f23ed9d97811dd` | Consortium-keyed HMAC-SHA256, truncated — **never the raw value**, and not reversible without the key |
| `window_start` / `window_end` | `2026-08-26T09:14:02Z` | when it was seen |
| `confidence` | `0.9` | 0.0–1.0 |

No log lines. No hostnames, usernames, or IP addresses. No company identifiers.

Two organizations hit by the same attacker infrastructure independently produce the
**same value**, so a correlator can match them without either side ever disclosing what
the indicator was — or that it was them.

### Why the indicator is keyed, not just hashed

A bare `sha256(domain)` is **not** private. Domains are a small, enumerable space: an
earlier version of this agent published `39b83e8cf8e2dd93`, and it was recovered in
**121 guesses** from a trivial wordlist. Anyone holding the correlator's database —
including whoever operates it — could reverse every indicator instantly.

So the indicator is keyed with a secret shared by consortium members:

```
indicator = HMAC-SHA256(consortium_key, normalized_indicator)[:16]
```

Members hold the key. **The correlator never receives it.** Equal indicators still
produce equal values, so matching is unchanged — but the correlator can match without
being able to learn what it matched, and an outsider cannot enumerate at all.

Set `POLLEN_CONSORTIUM_KEY` to your consortium's own secret. The built-in default is
public and exists only so `git clone && run` works; with it, the values *are* reversible.

**What this does not solve:** a malicious consortium *member* has the key and can still
brute-force. HMAC stops outsiders, not insiders. Private set intersection is the
honest next step.

## How it works

For each row of its own log:

1. **Triage** — a live model decides whether the row is background noise or worth
   escalating. The schema generates the *reason before the boolean*, so the verdict is
   conditioned on the analysis rather than rationalized after it. Escalation is
   recall-biased: if any vote escalates, it escalates.
2. **Technique** — the model labels the event with a MITRE ATT&CK id, validated
   against `T####[.###]` in code before it is trusted.
3. **Indicator extraction — deterministic, in code, never by the model.** A regex plus a
   benign-domain allowlist pulls the external token out of the row. This is deliberate:
   it guarantees two organizations produce an identical hash, and no model safety filter
   can refuse it.
4. **Guard-rail** — a deterministic check rejects any field containing an IPv4 address
   or internal-hostname token, independent of what the model claims it did.
5. **Hash and submit** — the agent's own code one-way-hashes the indicator, then POSTs
   the signature. That single HTTP call is the only thing that leaves the process.

Rows with no external indicator to share are dropped rather than padded — correctly, a
process-ancestry anomaly with no attacker infrastructure in it has nothing shareable.

## Configuration

All settings come from run config, so one app serves any organization:

| Key | Default | Meaning |
|---|---|---|
| `agent.org_id` | `my-org` | identifies you in submitted signatures |
| `agent.log_path` | `data/mock_log.jsonl` | the only file this agent reads |
| `agent.server_url` | `http://localhost:8000/api/signatures` | your correlator endpoint |
| `agent.model` | `/models/Kimi-K2.7-Code` | any Open-Responses-compatible model |

The log is JSONL, one object per line:

```json
{"timestamp": "2026-08-26T09:14:02Z", "source_process": "powershell.exe", "event_type": "network_connection", "detail": "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"}
```

A small sample log ships in `data/mock_log.seed.jsonl`; the agent copies it to the
working path on first run if that path is absent.

## Usage

```bash
flwr run . supergrid \
  --run-config 'agent.org_id="acme-corp" agent.server_url="https://correlator.example/api/signatures"' \
  --stream
```

Model calls are routed through the SuperLink, so the endpoint and credentials are
supplied by your Flower environment (`FLWR_MODEL_API_ENDPOINT` / `FLWR_MODEL_API_KEY`)
rather than baked into the app.

On Windows, set `PYTHONIOENCODING=utf-8` first — model output contains characters the
legacy console codepage cannot encode.

## The correlator

This agent submits to any endpoint accepting the signature shape above and replying
`201`. The reference implementation — deterministic cross-org matching plus the two
human approval gates that must clear before anything crosses an organizational
boundary — lives in the [Pollen Mesh repository](https://github.com/tanveerxz/pollen-mesh).

Correlation there is deliberately **not** model-driven: matching on identical indicator
hashes, or shared technique with overlapping time windows, has to be reproducible and
explainable.

## License

MIT — see `LICENSE`.
