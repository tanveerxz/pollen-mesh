# SignatureV1 — the only thing that ever crosses an org boundary

This is the canonical signature shape, referenced by all three org agents and the
server. It is deliberately a **reference document, not a shared code module**: each
Flower AgentApp is packaged as its own isolated bundle, so every org agent constructs
this shape independently, and the server validates it independently. If any piece
drifts from this document, this document wins.

## How the fields are produced inside the org agent (pre-hash)

| Field | Type | Produced by | Notes |
|---|---|---|---|
| `technique` | string | model | MITRE ATT&CK id, gated deterministically against `T####` / `T####.###` — a free-text label is dropped, not sent |
| `indicator` | string | **agent code, never the model** | the external attacker token (e.g. a domain), pulled from the row by regex + benign-domain allowlist so two orgs seeing the same infrastructure are guaranteed to produce the same value, and no model safety filter can refuse it |
| `window_start` | string | agent code | ISO 8601 — the row's own timestamp |
| `window_end` | string | agent code | ISO 8601 — the row's own timestamp |
| `confidence` | number | model | clamped by agent code to 0.0–1.0 |

A flagged row with no external indicator to share is dropped — nothing leaves the
process for it.

## What actually goes over the wire (`POST /api/signatures`)

```json
{
  "org_id": "org_a",
  "technique": "T1071.001",
  "indicator": "39b83e8cf8e2dd93",
  "window_start": "2026-08-26T09:14:02Z",
  "window_end": "2026-08-26T09:14:02Z",
  "confidence": 0.85
}
```

Differences from the model's output:

1. **`org_id` is attached** by the agent's own code.
2. **`indicator` is hashed** by the agent's own code — never by the model — so the
   hash is deterministic and reproducible across orgs hit by the same infrastructure:
   normalize (lowercase, strip scheme/whitespace/trailing `/` and `.`), then
   `sha256(normalized)` truncated to the first 16 hex characters. The server stores
   this value as `indicator_hash`.

## Hard rules enforced before anything is sent

- No field may contain a company name, hostname, username, raw IP address, or raw
  domain name (the raw `indicator` exists only in-process, pre-hash).
- A deterministic guard-rail re-checks the produced signature **independently of the
  model's claims**: any field containing an IPv4-looking token or an
  internal-hostname-style word (`corp`, `internal`, `hostname`) causes the signature
  to be dropped, not sent.
