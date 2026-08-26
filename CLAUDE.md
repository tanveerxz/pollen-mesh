# Pollen Mesh — full specification for Claude Code

**Track: Track 2 — Infrastructure (the "define your own problem" track, confirmed on the day as the successor to the pre-event "Open Exploration" framing).** Nothing about the architecture below changes for this — Track 2 explicitly permits a multi-agent project running on SuperGrid or a local SuperLink. The one open decision Track 2 grants: stick with SuperGrid's managed model access (simpler, assumed throughout this spec), or stand up a local SuperLink against one of the AMD-hosted models (Qwen3.5 397B, Kimi-K2.7-Code, GLM-5.2, MiniMax-M3) if the default model's JSON-following on the classify/extract steps turns out unreliable in testing — Kimi-K2.7-Code is the natural fallback for that, being tuned for strict structured output.

**Running this solo** — the §11 team split below was written for a team of up to four; it's kept as a reference for what each piece of work looks like in isolation; being solo just means the same order of operations applies serially: get `org_a` verified end-to-end against the live SDK first (since it's the piece gated on external Flower account/login access), then replicate the pattern to `org_b`/`org_c`, with `server/` and `client/` already built.

**This is a specification, not a codebase.** It describes exactly what every piece must do — every field, every endpoint's contract, every rule the matching logic follows, every screen's exact content — without pre-writing the implementation. The reasoning is deliberate: writing the actual code should happen against the real, installed Flower SDK (see §0), not against a guess of it, and a detailed behavioral spec lets whoever builds each piece choose their own implementation while still landing on something that fits every other piece exactly. Nothing described below is optional detail — if it's in this file, it's a requirement.

---

## 0. Verified against a live install (2026-08-25, `flwr==1.35.0`)

The commands below were actually run against a real `pip install flwr` (not just doc review). Findings:

**Confirmed, matches the spec as written:**
- `AgentApp` exists with exactly the documented shape: `app = AgentApp()`, `@app.main() def main(agent: AgentSession, context: Context) -> None`.
- `Context` (`flwr.app.message.context.Context`, re-exported as `flwr.app.Context`) has `run_config: dict[str, bool|float|int|str]` and `state: RecordDict` — a local-only scratchpad that never leaves the node — plus `run_id`, `node_id`, `node_config`, `series_id`. `run_config` behaves exactly as §4.2 assumes.
- No cross-AgentApp calling mechanism exists, and `start_automation` (`flwr/supercore/task_process/connector/automation.py`) only takes `{input, start_at, fixed_interval, max_runs}` — it reschedules future runs of the *same* app/run series, nothing else. This confirms the HTTP-fallback design for org→server communication in §1/§4.3e is correct, not a workaround for a documentation gap.
- The connector list is fixed and closed, confirmed via `flwr/supercore/task_process/connector/registry.py`: `web_search`, `web_fetch`, `start_automation`, `browser_use` (**one more built-in than the spec assumed**), plus OAuth account connectors loaded dynamically. No custom-connector registration path exists.
- pyproject.toml must declare `[tool.flwr.app.components]` with an `agentapp = "<module>:<attribute>"` object reference (validated in `flwr/common/config.py`) — this is what "Entry point" in §4.2 refers to concretely: a module-level `AgentApp()` instance, not a bare function.

**Refines what the spec was vague about — matters for implementing §4.4:**
- `AgentSession` has three properties, not a generic "model calls + connector calls": `.responses` (model calls), `.connectors` (connector tool schemas + execution), `.events` (optional structured events for the run-viewer frontend — emit is fire-and-forget, not required for anything in this spec).
- `agent.responses.create(request)` is **Open-Responses-API-shaped**, not a bare prompt-in/JSON-out helper. The request dict takes `model`, `input` (string or list of item objects), `instructions`, `tools`, `tool_choice`, `reasoning`, `max_output_tokens`, `text`, `metadata`, `previous_response_id`. **Use `text: {"format": {"type": "json_schema", "schema": {...}, "name": "...", "strict": true}}` to get structured output for the classify (`{flag, reason}`) and extract (§4.5 schema) calls, instead of relying on "Respond with ONLY a JSON object" prompt text** — the schema in §4.4/§4.5 should be wired in as an actual `text.format` JSON Schema, not just prose instructions. Confirmed against `flwr/supercore/task_process/agent/session.py::RuntimeAgentResponses._create_model_response`.

**Still unresolved — needs the user, not more doc-reading:**
- `agent.responses.create()` dispatches to a **child model task created through the SuperLink** (`self._stub.CreateTask(CreateTaskRequest(type=TaskType.MODEL, model_ref=model))`) — model calls are routed through Flower's own control plane, not a locally-held API key. Likewise `uv run flwr run . supergrid --stream` targets a federation named/aliased `supergrid`, which per `flwr run --help` resolves to `@<account>/<federation-name>` on a SuperLink — this requires `flwr login` against an account that already has that federation and model access provisioned. **This is exactly the kind of thing to confirm with a Flower mentor on the day**: what account/org to log into, what `model_ref` string(s) are valid, and whether `supergrid` is a hackathon-provided federation name or something each team must create with `flwr federation create`. Nothing about this can be resolved by reading the SDK locally — there's no offline/no-login simulation path surfaced by `flwr --help`.

---

## 1. What this is, in one paragraph

Three isolated processes (`org_a`, `org_b`, `org_c`), each a real Flower `AgentApp`, each reading only its own mock security log and using an LLM to classify each line and, for anything suspicious, extract a stripped, anonymized "signature." The only thing each process ever sends anywhere is that signature, via one HTTP call to a FastAPI server. The server runs deterministic (non-LLM) matching logic across signatures from different orgs, holds any match above threshold in a pending state, and only advances it when a human approves on a Next.js dashboard screen that shows exactly what would be disclosed. Approved matches then wait on a second, per-org "local action" approval before being marked resolved.

---

## 2. Repo layout

```
pollen/
├── CLAUDE.md
├── README.md                # public-facing description — "open-source" is a submission requirement
├── client/                  # Next.js — frontend only, calls the server over HTTP, no API routes of its own
├── server/                  # FastAPI — owns all state and the matching logic
├── orgs/
│   ├── org_a/                # its own Flower project: config + agent logic + its own mock log
│   ├── org_b/                # identical shape
│   └── org_c/                # identical shape
└── shared/
    └── signature.md          # the canonical signature shape, referenced by both org agents and the server
```

Each `orgs/org_x/` is its own installable Flower project with its own dependency environment, so the three processes are genuinely independent — no shared interpreter state between them.

**Why FastAPI for the server:** same language as the org agents, so the payload an org agent builds and the payload the server expects can be the exact same shape with no translation layer to drift out of sync under time pressure.

**Why `shared/signature.md` is a reference doc, not a shared code module:** Flower packages each org's AgentApp as its own bundle, scoped to that org's own directory — a cross-directory import from `shared/` is a packaging assumption that needs verifying against the live SDK (see §0) before relying on it. Default to each org agent constructing the signature independently to match the documented shape; only share the actual module if a live check confirms cross-directory includes work.

---

## 3. Non-negotiable rules

1. **Never fake the output.** Seeding synthetic input data so the pipeline has something real to find is fine (§7 — the campaign rows share a literal indicator on purpose). Hardcoding a match result, or making Approve do anything other than a real state change, is not.
2. **The privacy boundary must be real.** Each org process reads only its own local log and makes exactly one kind of outbound call — the signature submission. No shortcut may give one org's process access to another's raw data.
3. **The matching logic is deterministic, not an LLM call.** Reliability over "everything is an agent."
4. **The installed Flower SDK overrules this document** wherever they conflict.

---

## 4. Specification: the org agents (Flower)

### 4.1 Responsibility

Read one org's own mock log, decide which lines are worth escalating, extract an anonymized signature from each escalated line, and submit each signature to the server. Nothing else leaves the process.

### 4.2 Project configuration requirements

Each `orgs/org_x/` needs a Flower project configuration declaring:

| Requirement | Value |
|---|---|
| Runtime dependency | the `flwr` package (a version compatible with whatever `uv run flwr --help` reports as installed) plus an HTTP client library for the one outbound call |
| Declared run-config key `agent.org_id` | `"org_a"`, `"org_b"`, or `"org_c"` respectively |
| Declared run-config key `agent.log_path` | path to that org's own mock log file, e.g. `data/mock_log.csv` |
| Declared run-config key `agent.server_url` | `http://localhost:8000/api/signatures` |
| Entry point | one function registered as the app's main entry point, receiving a model/connector session object and a context object carrying the run config above |
| Packaging scope | only that org's own package directory and its own data file — never a path outside `orgs/org_x/` unless §0's cross-directory check passes |

### 4.3 Runtime behavior, in order

1. On start, read the org's own run-config values (`org_id`, `log_path`, `server_url`).
2. Load every row of the local mock log file (see §7 for exact content — a small table of timestamped security-relevant events).
3. For each row, in order:
   a. **Classify.** Send the row to the model with instructions to decide whether it's ordinary background noise or worth escalating as possibly part of a broader, multi-organization attack pattern. The model must respond with exactly two fields: a boolean `flag`, and a one-sentence `reason`. If the row isn't flagged, move to the next row — nothing further happens for it.
   b. **Extract.** For a flagged row, send it back to the model with instructions to produce a signature matching the schema in §4.5, under a hard rule: never include a company name, hostname, username, raw IP address, or raw domain name in any field. If the model cannot produce a compliant signature, it must respond with an explicit error field instead of guessing — that row is then dropped, not sent.
   c. **Guard-rail check (deterministic, independent of what the model claims it did).** Before anything is sent, the produced signature must be checked for identifying content itself — reject and drop (do not send) any signature whose fields contain what looks like a raw IPv4 address (four dot-separated number groups), or an obvious internal-hostname-style token (words like "corp", "internal", "hostname" embedded in a field). This check exists specifically so a model mistake doesn't get sent just because the model said it redacted correctly.
   d. **Hash the indicator.** The signature's `indicator` field, as produced by the model, must be hashed (a stable one-way hash, e.g. SHA-256, truncated to a fixed short length such as the first 16 hex characters) before it leaves the process. The model is instructed to hand back the raw representative token specifically so the *agent's own code*, not the model, controls the hashing — this keeps the hash deterministic and reproducible across orgs hit by the same indicator.
   e. **Send.** Submit the resulting signature (with the `org_id` field attached — see the attribution note in §6) as one HTTP POST to `agent.server_url`, with a short timeout (a few seconds is enough; a demo shouldn't hang on a stalled request). Log the outcome (technique + response status) to the console so the live demo has visible proof of what happened.
4. When every row has been processed, the run ends. There is no loop back to the top — one pass over the log per run.

### 4.4 Exact prompts

**Classify prompt** — sent once per log row:

> You are a first-pass triage agent reviewing ONE log line from your own organization's security telemetry. You will never see another organization's data.
>
> Log line (JSON): `{the row, serialized}`
>
> Decide whether this line is ordinary background noise or worth escalating as possibly part of a broader, multi-organization attack pattern (for example: a living-off-the-land technique, unusual process ancestry, or beaconing-like outbound behavior).
>
> Respond with ONLY a JSON object, no other text: `{"flag": true or false, "reason": "<one short sentence>"}`

**Extract prompt** — sent only for a flagged row:

> You are extracting a SHAREABLE signature from a flagged security log line, to be sent to an external cross-organization correlation service.
>
> CRITICAL RULES:
> - NEVER include a company name, hostname, username, raw IP address, or raw domain name in any field.
> - The "indicator" field should be the representative suspicious token itself (e.g. a domain-like string) — do not hash it, the caller will.
> - If you cannot produce a compliant signature without leaking identifying detail, respond with `{"error": "cannot redact safely"}` instead of the schema.
>
> Log line (JSON): `{the row, serialized}`
>
> Respond with ONLY a JSON object matching this schema, no other text: `{the schema from §4.5, as text}`

### 4.5 Signature shape (what the model must produce, pre-hash)

| Field | Type | Notes |
|---|---|---|
| `technique` | string | short label, ideally a MITRE ATT&CK id such as `T1059.001` |
| `indicator` | string | representative suspicious token (e.g. a domain-like string); **not yet hashed** at this point — the agent's own code hashes it after the model responds |
| `window_start` | string | ISO 8601 timestamp |
| `window_end` | string | ISO 8601 timestamp |
| `confidence` | number | 0.0–1.0 |

What actually gets sent to the server additionally includes `org_id` (string) and has `indicator` replaced with its hashed form (renamed conceptually to "indicator_hash" on the wire — see §5.3 for the server-side field name).

### 4.6 Run commands (one terminal per org)

```
cd orgs/org_a && uv sync && uv run flwr run . supergrid --stream
cd orgs/org_b && uv sync && uv run flwr run . supergrid --stream
cd orgs/org_c && uv sync && uv run flwr run . supergrid --stream
```

Start `server/` first, then `client/`, so there's somewhere for the signature POSTs to land before any org process runs.

---

## 5. Specification: the server (FastAPI)

### 5.1 Responsibility

Sole owner of all shared state (every signature received, every match record, every approval decision). Runs the matching logic. Exposes the HTTP contract both the org agents and the client depend on. Nothing here calls a model — everything in this component is deterministic.

### 5.2 Tech requirement

Python, FastAPI, an ASGI server (uvicorn) to run it, an in-memory store (a database is not needed for a single demo run — module-level state that resets when the process restarts is the expected behavior, not a bug). CORS must be configured to allow requests from the client's dev origin (`http://localhost:3000`).

### 5.3 Data model

**Signature record** (created on `POST /api/signatures`, immutable afterward):

| Field | Type | Set by |
|---|---|---|
| `id` | string | server, on creation — any collision-resistant unique string |
| `org_id` | string | caller (the org agent) |
| `technique` | string | caller |
| `indicator_hash` | string | caller (already hashed before it reached the server) |
| `window_start` | string (ISO 8601) | caller |
| `window_end` | string (ISO 8601) | caller |
| `confidence` | number, 0–1 | caller |
| `received_at` | string (ISO 8601) | server, on creation |

**Match record** (created or extended by the matching logic, mutated by approval/local-action endpoints):

| Field | Type | Notes |
|---|---|---|
| `id` | string | server-assigned on creation |
| `signature_ids` | list of strings | every signature that contributed to this match |
| `org_ids` | list of strings | every distinct org involved |
| `technique` | string | the shared technique label |
| `indicator_hash` | string or null | set if the match was found via identical indicator hashes; null if it was found via technique+time-window overlap instead |
| `window_start` / `window_end` | string (ISO 8601) | **added during implementation, not in the original design pass** — the earliest `window_start` and latest `window_end` among all contributing signatures. §6.4's Approval screen requires showing "the time window" of a match, but the original Match record had nowhere to hold one; this closes that gap. Recomputed (min/max) whenever a match is extended in §5.5 step 5. |
| `confidence` | number, 0–1 | the highest confidence among contributing signatures |
| `status` | one of `pending`, `approved`, `rejected`, `resolved` | see §5.5 state machine |
| `created_at` | string (ISO 8601) | set on creation |
| `approved_at` | string (ISO 8601), optional | set only when approved |
| `local_actions` | map of org_id → one of `pending`, `approved`, `rejected` | empty until the match is approved; one entry per org in `org_ids` once approved |

### 5.4 Endpoint contracts

**`POST /api/signatures`**
Request body: `org_id`, `technique`, `indicator` (already hashed by the sender), `window_start`, `window_end`, `confidence` — all required; `confidence` must validate as a number between 0 and 1 inclusive, reject the request otherwise. On success: create the Signature record (server assigns `id` and `received_at`), append it to the store, then run it through the matching algorithm (§5.5) against every previously stored signature. Respond `201` with `{ "signature_id": <id>, "match_id": <id or null> }` — null if no match was created or extended by this submission.

**`GET /api/signatures`**
No body. Returns every stored Signature record, in the order received. Used by the Correlator screen to plot all known signatures.

**`GET /api/matches`**
Optional query parameter `status`. Returns every Match record, or only those with the given status if the parameter is present.

**`GET /api/matches/{id}`**
Returns the single Match record with that id, or a `404` if none exists.

**`POST /api/matches/{id}/approve`**
Only valid when the match's current status is `pending`; if it is not, respond `409` and make no change. On success: set `status` to `approved`, set `approved_at` to the current time, and populate `local_actions` with one entry per org in `org_ids`, each initialized to `pending`. Return the updated Match record.

**`POST /api/matches/{id}/reject`**
Only valid when the match's current status is `pending`; otherwise `409`, no change. On success: set `status` to `rejected`. This is terminal — a rejected match is never revisited by later logic.

**`POST /api/matches/{id}/local-action/{org_id}`**
Only valid when the match's current status is `approved` and `org_id` is one of the orgs in its `org_ids`; otherwise `404`/`409` as appropriate. Request body: a `decision` field, either `approved` or `rejected`. On success: set `local_actions[org_id]` to that decision. Afterward, check: if every entry in `local_actions` is now `approved`, set the match's overall `status` to `resolved`. A single org rejecting its local action does **not** revert the match's overall status — it stays `approved` with that one org's decision visibly recorded as `rejected`, since one org declining its own follow-up action has no bearing on whether the other orgs still choose to act on the same disclosed alert.

**`GET /api/orgs/{org_id}/status`**
Returns a small summary: `org_id`, `signature_count` (how many signatures that org has submitted), `pending_match_count` (how many currently-pending matches involve that org). Used by the Mission Control screen's status dots.

**`GET /api/orgs/{org_id}/log`** *(optional convenience endpoint)*
Returns the raw rows of that org's own mock log file, for the Org Node screen to display "what stayed local." Only needed if the client isn't reading the mock CSV files directly off the same filesystem — see §6.4.

### 5.5 Matching algorithm — precise rule, described exactly

Given a newly received signature **S**:

1. Compare S against every previously stored signature from a *different* org. Call one such signature **T** a "partner" of S if either: (a) S and T have identical `indicator_hash` values — this is the strong case, since it means the same underlying attacker infrastructure was seen independently by two orgs — or (b) S and T share the same `technique` string *and* their time windows overlap once T's window is padded by a fixed tolerance (60 minutes) on both ends.
2. Collect every partner of S found this way into a set.
3. If the set of distinct `org_id`s among {S} plus its partners has fewer than 2 members, stop — no match, nothing is created or changed.
4. Compute a confidence value as the maximum `confidence` among S and all its partners. If that value is below a threshold (0.5), stop — no match.
5. Check whether a Match record already exists with status `pending`, the same `technique` as S, and whose existing `org_ids` (plus S's own `org_id`) would cover the same or a subset of the org set found in step 2. If so, **extend** it: add S's id to `signature_ids`, add S's `org_id` to `org_ids` if not already present, and raise the match's `confidence` to the higher of its current value and the one just computed. Return that match.
6. Otherwise, **create** a new Match record: a fresh id, `signature_ids` containing S and every partner's id, `org_ids` containing every distinct org involved, the shared `technique`, `indicator_hash` set to S's hash if any partner shared that same hash (otherwise null), the computed `confidence`, `status` set to `pending`, `created_at` set to now, and `local_actions` left empty. Return the new match.

This whole procedure runs once, synchronously, as part of handling `POST /api/signatures` — it is not a background job.

### 5.6 State machine summary

`pending` → (`approve`) → `approved` → (every org's local action becomes `approved`) → `resolved`
`pending` → (`reject`) → `rejected` *(terminal)*

No other transitions exist. A match is never automatically approved or automatically resolved except by the two rules above.

### 5.7 Run command

```
cd server && uv sync && uv run uvicorn server.main:app --reload --port 8000
```

---

## 6. Specification: the client (Next.js)

### 6.1 Responsibility

Display the state the server owns, and let a human trigger the two approval gates. The client holds no state of its own beyond what it polls from the server, and performs no matching or decision-making logic itself.

### 6.2 Tech requirement

Next.js, App Router, TypeScript. No API routes inside the client app — every piece of dynamic data comes from the server over plain HTTP. One environment variable, `NEXT_PUBLIC_API_BASE_URL`, pointing at `http://localhost:8000`.

### 6.3 Data fetching pattern

Poll the relevant server endpoint(s) on an interval of 1.5–2 seconds per page while it's open. This is a demo, not a production dashboard — polling is sufficient, no WebSocket or server-sent-events layer is needed.

### 6.4 Pages — one per screen, each with an exact content and interaction spec

**`/` — Mission Control.** Three cards, one per org (`org_a`, `org_b`, `org_c`), each polling that org's `GET /api/orgs/{id}/status`. Each card shows a status dot: green if `pending_match_count` is 0 and the org has submitted at least one signature recently (i.e., quietly running), amber if `pending_match_count` > 0 (something awaiting a human decision), and a neutral/idle state if no signatures yet. Acceptance: opening this page while the three org processes are running shows the dots changing live as signatures come in and a match appears.

**`/org/[id]` — Org Node.** Shows two things side by side for the given org: (a) its own raw mock log rows — sourced either by reading that org's CSV file directly (since it lives in the same repository checkout) or via the optional `GET /api/orgs/{id}/log` convenience endpoint — styled visually as locked/contained (dashed border, a lock icon, the "stays local" green from §6.5); and (b) the signatures that org has actually submitted, pulled from `GET /api/signatures` filtered to that `org_id`, styled as open/normal. Acceptance: an observer can see plainly that far more raw log content exists than ever left the box on the right.

**`/correlator`.** Pulls every signature via `GET /api/signatures` and plots them on a simple time axis, positioned by `window_start`/`window_end` and grouped/colored by `org_id`. Any signature that is part of a currently pending or approved match should be visually distinguished (e.g., an overlay band across the overlapping time range) so the moment of correlation is visible without reading raw data. Acceptance: once `org_a` and `org_b`'s campaign signatures have both been submitted, this page visibly shows them overlapping.

**`/approvals/[id]` — Human Approval.** Pulls one Match via `GET /api/matches/{id}` and displays exactly and only: the `technique`, the `indicator_hash`, the time window, and the list of `org_ids` involved — nothing else, since nothing else exists in a Match record to show, and that's the point (this is literally the full disclosure a human is approving). Two buttons: Approve (calls `POST /api/matches/{id}/approve`) and Reject (calls `POST /api/matches/{id}/reject`). Acceptance: clicking Approve here is reflected within one poll cycle on `/resolution` and on Mission Control.

**`/resolution`.** Lists every Match with status `approved` or `resolved`. For each, shows every org in `org_ids` with its current `local_actions` entry, and — for any org whose entry is still `pending` — a button that simulates that org's own analyst approving (or rejecting) its local follow-up action, calling `POST /api/matches/{id}/local-action/{org_id}`. Once every org's entry is `approved`, the match visibly reflects `resolved` status. Acceptance: a match can be walked from `approved` to `resolved` entirely from this screen.

**`/architecture`.** A static page for judges: one short paragraph explaining the mechanism (local reasoning → deterministic correlation → human approval, twice), plus a simple diagram showing that same three-step flow, and an explicit statement that this is built on Flower Agent. No dynamic data on this page.

### 6.5 Visual language (apply consistently across every page above)

- **Green** (`#3f7a57` in light mode, `#6fae84` in dark mode) — stays local / contained. Used for raw-log panels and idle status dots.
- **Amber** (`#b5701a` light, `#e0973a` dark) — held for a human decision. Used for pending-match indicators and the Approval screen's framing.
- **Brick red** (`#9c4436` light, `#d08072` dark) — has crossed an org boundary. Used once a match has been approved and disclosed.

### 6.6 Run command

```
cd client && npm install && npm run dev
```

---

## 7. Mock log data — exact content, required for the rehearsed demo path

Each org's mock log is a small table with columns `timestamp, source_process, event_type, detail`.

**`orgs/org_a/data/mock_log.csv`**
```
timestamp,source_process,event_type,detail
2026-08-26T09:02:11Z,chrome.exe,network_connection,"outbound TCP 443 to cdn-assets-fastly.net, normal browsing"
2026-08-26T09:07:44Z,outlook.exe,file_access,"opened attachment invoice_3382.pdf"
2026-08-26T09:14:02Z,powershell.exe,network_connection,"outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"
2026-08-26T09:14:55Z,powershell.exe,process_create,"spawned from winword.exe, base64-encoded command line, unusual parent chain"
2026-08-26T09:20:10Z,svchost.exe,network_connection,"outbound TCP 443 to windowsupdate.microsoft.com, routine"
2026-08-26T09:31:00Z,teams.exe,network_connection,"outbound TCP 443 to teams.microsoft.com, routine"
2026-08-26T09:44:20Z,explorer.exe,file_access,"opened shared_drive/Q3_budget.xlsx"
2026-08-26T10:02:15Z,backup_agent.exe,network_connection,"outbound TCP 443 to backup-vendor.com, scheduled job"
```

**`orgs/org_b/data/mock_log.csv`**
```
timestamp,source_process,event_type,detail
2026-08-26T09:10:00Z,outlook.exe,file_access,"opened attachment Q3_renewal.pdf"
2026-08-26T09:22:18Z,powershell.exe,network_connection,"outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"
2026-08-26T09:23:05Z,powershell.exe,process_create,"spawned from winword.exe, base64-encoded command line, unusual parent chain"
2026-08-26T09:35:40Z,chrome.exe,network_connection,"outbound TCP 443 to news-aggregator.com, browsing"
2026-08-26T09:58:00Z,svchost.exe,network_connection,"outbound TCP 443 to windowsupdate.microsoft.com, routine"
2026-08-26T10:15:30Z,slack.exe,network_connection,"outbound TCP 443 to slack.com, routine"
```

**`orgs/org_c/data/mock_log.csv`** — deliberately clean for the baseline run:
```
timestamp,source_process,event_type,detail
2026-08-26T09:05:00Z,outlook.exe,file_access,"opened attachment agenda.pdf"
2026-08-26T09:18:30Z,chrome.exe,network_connection,"outbound TCP 443 to news-site.com, browsing"
2026-08-26T09:40:12Z,svchost.exe,network_connection,"outbound TCP 443 to windowsupdate.microsoft.com, routine"
2026-08-26T10:05:00Z,slack.exe,network_connection,"outbound TCP 443 to slack.com, routine"
```

**Why this specific data:** the string `secure-update-delivery.net` appears verbatim in both `org_a` and `org_b`'s campaign rows — the same rented attacker infrastructure hitting two victims. Each org hashes it independently with the same function, so the resulting `indicator_hash` values are identical without either org ever seeing the other's log. That identical-hash match is the strongest signal the matching algorithm can use (§5.5 rule 1a), and it's why this specific pair of rows makes the demo's central moment work reliably rather than depending on a fuzzier technique-plus-timing coincidence.

**Optional "org C joins late" flourish** — append this row to `orgs/org_c/data/mock_log.csv` and re-run its process live during the demo:
```
2026-08-26T09:16:40Z,powershell.exe,network_connection,"outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"
```

---

## 8. End-to-end walkthrough

1. `server/` (port 8000) and `client/` (port 3000) are both running.
2. `org_a`'s process starts, reads its own log, flags two rows, extracts and hashes two signatures, submits both. No match yet — only one org has reported.
3. `org_b`'s process does the same. Its campaign-row signature shares an `indicator_hash` with one of `org_a`'s. The matching algorithm creates a new `pending` Match with `org_ids: ["org_a", "org_b"]`.
4. The Correlator screen shows the overlap; Mission Control shows a pending-match indicator for both orgs.
5. A human opens the Approval screen for that match, reviews exactly what would be disclosed, clicks Approve. The match becomes `approved`, with both orgs' local actions seeded as `pending`.
6. The Resolution screen shows both pending local-action buttons; clicking both moves the match to `resolved`.
7. *(Optional live flourish)* — `org_c`'s log gets the extra row appended and its process re-run; its signature joins the existing match via the same shared hash, and `org_ids` grows to three on an already-open dashboard.

---

## 9. Definition of done

**MVP — must work, rehearsed, no flakiness:**
- All three org processes genuinely call the model to classify and extract, per §4.3–4.4 — not simulated.
- The server's matching logic genuinely implements §5.5 and correctly produces the `org_a`/`org_b` match from the seeded data in §7.
- Approve and the local-action endpoints are real state mutations per §5.4/§5.6, not decorative buttons.
- Mission Control, Org Node, and the Approval screen are built and styled per §6.4–6.5.

**Stretch — cut without guilt if short on time:**
- Correlator, Resolution, and Architecture screens fully built rather than narrated over terminal output.
- A real SuperGrid federation deploy instead of three local processes.
- The "org C joins late" flourish.
- The optional `GET /api/orgs/{id}/log` endpoint (skip it and just read the CSV directly from the client instead).

**Not stretch — mandatory submission items (confirmed on the day, not in the original brief):**
- The project published as a Flower Hub app.
- A GitHub repository link.
- Team details (team name, members, email addresses) and a short project description.
- Selected track stated explicitly: Track 2 — Infrastructure.

---

## 10. Demo script

Demo slot is **3–5 minutes**, followed by judges' questions — tighter than the walkthrough below reads; rehearse it against a timer, not just read through once.

1. Reset: fresh terminals, discard any live edits made to the mock CSVs during the previous rehearsal, restart `server` then `client`.
2. Start all three org processes visibly, side by side — the visual proof of isolation is part of the pitch.
3. Narrate: "each of these only ever reads its own log file — the only network call any of them makes is one submission of a stripped signature to our server."
4. Show Mission Control, then Correlator, as the match appears once `org_b` finishes.
5. Open the Approval screen, read out loud exactly what's about to be disclosed, click Approve.
6. Show Resolution updating as both local actions are approved.
7. *(If doing the flourish)* — append the extra row to `org_c`'s log, re-run its process live, watch the match grow to three orgs on an already-open dashboard.
8. Close on the Architecture page: "three companies, three private log files, one shared attack caught — and a human said yes twice before anything moved."

Keep the narration anchored to the six things judges are actually scoring (§12) rather than a generic feature tour — say the words "safety and oversight" and "use of Flower" somewhere in the pitch, don't make the judges infer it.

---

## 11. Team split (reference — this run is solo; see the note at the top of this file)

- **Person A** — `orgs/org_a`, built and verified end to end against the live SDK, then the same pattern applied to `org_b`/`org_c`.
- **Person B** — `server/`, entirely: the data model, the matching algorithm, every endpoint. The most central piece; same language as the org agents, so this person can also unblock Person A.
- **Person C** — every page under `client/`, using §6.4–6.5 as the exact spec for what each must show. Pure frontend work, no Python required.
- **Person D** (if present) — demo rehearsal, README, repo hygiene, Flower Hub publishing, and floating to whichever piece is blocked.

---

## 12. Submission & judging (confirmed on the day — treat as authoritative over anything earlier)

**Track:** Track 2 — Infrastructure, the flexible "define your own problem and solution" track. Confirmed by organizers as the successor to the pre-event "Open Exploration" framing. Permits single- or multi-agent projects, run on SuperGrid or a local SuperLink, with optional access to AMD-hosted models (see the track note at the top of this file).

**What must be submitted before demos**, per the official event post:
1. Team details — team name, members, email addresses.
2. Selected track — "Track 2: Infrastructure."
3. A short project description.
4. The project published as a **Flower Hub app**.
5. A GitHub repository link.

**Judging criteria** — six dimensions, explicitly named, none of them "agent performance" alone:
- **Impact** — the value and usefulness of the solution.
- **Innovation** — the originality of the approach.
- **Use of Flower** — how effectively the project uses Flower Agent and SuperGrid.
- **Technical execution** — whether the project works and is well built.
- **Demo and delivery** — how clearly and effectively it's presented.
- **Safety and oversight** — whether the project is transparent, reliable, and appropriately supervised.

This project's whole premise maps directly onto "Safety and oversight" (the two human-approval gates are the mechanism, not decoration) and "Impact" (a real, researched cross-org information-sharing problem — see the separate rationale doc). Make sure the 3–5 minute demo actually says this rather than leaving judges to connect the dots themselves.
