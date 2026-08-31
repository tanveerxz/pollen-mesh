# Pollen Mesh — full specification for Claude Code

**Track: Track 2 — Infrastructure (the "define your own problem" track, confirmed on the day as the successor to the pre-event "Open Exploration" framing).** Nothing about the architecture below changes for this — Track 2 explicitly permits a multi-agent project running on SuperGrid or a local SuperLink. The one open decision Track 2 grants: stick with SuperGrid's managed model access (simpler, assumed throughout this spec), or stand up a local SuperLink against one of the AMD-hosted models (Qwen3.5 397B, Kimi-K2.7-Code, GLM-5.2, MiniMax-M3) if the default model's JSON-following on the classify/extract steps turns out unreliable in testing — Kimi-K2.7-Code is the natural fallback for that, being tuned for strict structured output.

**Team of two.** The §11 team split below was written for up to four people; with two, the core-build roles it describes (`org_a`→`org_b`/`org_c`, `server/`, `client/`) are already done as of 2026-08-26 — see §0b for the org agents, all verified working end to end for real against the live SDK. What's left is closer to Person D's role: demo rehearsal, README, repo hygiene, Flower Hub publishing, plus whatever polish/stretch work (§9) there's time for. See §11 for how that's split between the two of you.

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

## 0b. Verified via a real end-to-end Track 2 run (2026-08-26, `orgs/org_a` and `orgs/org_b` both live)

The `supergrid`/`flwr login` path above turned out not to be how Track 2 actually works. What's confirmed by an actual successful run — real model calls, real cross-org hash match created on the server — supersedes §0 wherever they conflict:

- **No `flwr login` needed at all.** `flwr run .` with no SUPERLINK argument defaults to a connection named `local` (`DEFAULT_FLOWER_CONFIG_TOML` in `flwr/cli/constant.py`), which auto-launches a local SuperLink (`flower-superlink.exe --insecure --simulation ...`) on demand. This is what a bare `flwr login` was doing when it appeared to hang — it was silently starting that same local SuperLink, not prompting for anything. Track 2's model access route is: local SuperLink + a per-model `FLWR_MODEL_API_KEY` / `FLWR_MODEL_API_ENDPOINT` pair, **not** SuperGrid's managed/OAuth path.
- **The local SuperLink is a persistent daemon that outlives the CLI command.** It keeps running in the background after `flwr run` exits, and every subsequent `flwr run` reuses it — including whatever environment variables were set when it first started. Changing `FLWR_MODEL_API_KEY`/`FLWR_MODEL_API_ENDPOINT` in your shell and re-running does **nothing** until you kill the existing `flower-superlink.exe` (and its `flower-superexec.exe` children) so a fresh one spawns and inherits the new values. Symptom if you forget this: identical errors across attempts that should differ.
- **Track 2's shared model endpoints are four separate raw URLs, not a routing key on Flower's own gateway.** `FLWR_MODEL_API_KEY` alone is not sufficient — `FLWR_MODEL_API_ENDPOINT` must point at the specific model's own address, or every request silently falls back to Flower's own `https://api.flower.ai/v1/responses` and gets `401 Unsupported API key version` for literally any key value (confirmed: this happens even with the two real, organizer-issued keys). The four confirmed pairs:

  | Model | `FLWR_MODEL_API_ENDPOINT` | `model` field to send | `FLWR_MODEL_API_KEY` |
  |---|---|---|---|
  | Qwen3.5 397B | `http://129.212.182.232:8001/v1/responses` | `/models/Qwen3.5-397B-A17B-FP8` | any non-empty string — this endpoint doesn't check it |
  | Kimi-K2.7-Code | `http://134.199.193.245:8001/v1/responses` | `/models/Kimi-K2.7-Code` | any non-empty string — this endpoint doesn't check it |
  | GLM-5.2 | `http://129.212.179.194:8001/v1/responses` | `glm-5.2-fp8` | organizer-issued key (Slack) |
  | MiniMax-M3 | `http://165.245.135.52:8001/v1/responses` | `minimax-m3` | organizer-issued key (Slack) |

  Note the `model` field is the **Model ID** column, not the display name — sending `"Kimi-K2.7-Code"` instead of `"/models/Kimi-K2.7-Code"` is a different, likely-invalid value as far as that server is concerned. `orgs/*/pyproject.toml` default to Kimi via `agent.model = "/models/Kimi-K2.7-Code"` (recommended in the track note at the top of this file, and it needs no real key).
- **Kimi (and likely the other reasoning-tuned models) emit a `reasoning` output item before the `message` item.** `response["output"]` is a list; the first element can be `{"type": "reasoning", "content": [{"type": "reasoning_text", "text": "..."}]}` — plain prose, not JSON. Naively taking the first `content[].text` found anywhere in `output` grabs the reasoning trace and fails to parse as JSON. Must filter for `item["type"] == "message"` specifically before reading its `content[].text`. See `_extract_structured_output` in `orgs/org_a/org_a/agent.py`.
- **`.csv` cannot be packaged into a FAB.** The FAB builder's include list is a hard, non-overridable allowlist — `**/*.py`, `**/*.toml`, `**/*.md`, `**/*.yaml`, `**/*.yml`, `**/*.json`, `**/*.jsonl`, `/LICENSE` (`FAB_INCLUDE_PATTERNS` in `flwr/common/constant.py`) — and `[tool.flwr.app] fab-include` in pyproject.toml can only *narrow* which files are considered, never add an extension outside that list back in. §7's mock logs are therefore shipped as `.jsonl` (one JSON object per line, same fields) instead of `.csv` — a direct instance of §3 rule 4 ("the installed SDK overrules this document"). The server's optional `GET /api/orgs/{id}/log` and the client's Org Node page both read `.jsonl` accordingly.
- **`[tool.flwr.app] publisher` is a required field**, undocumented anywhere in the original spec pass. Missing it fails `pyproject.toml` validation outright. Each org's pyproject.toml sets `publisher = "pollen-mesh"`.
- **Windows console encoding will crash a run that reaches a live model.** Model output routinely contains characters (arrows, em dashes, curly quotes) that Windows' legacy per-locale codepage (`cp1252` here) can't encode, and an uncaught `print()` of one kills the whole AgentApp task with `UnicodeEncodeError` — this is not hypothetical, it happened on the very first real classify call. Two independent fixes, both needed: (1) inside the agent, `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` before any `print()`, so the task process itself never crashes; (2) `PYTHONIOENCODING=utf-8` set in the shell before `uv run flwr run . --stream`, so the *CLI's own* log-streaming display (a separate process) doesn't silently stop rendering mid-run — this happened too, and it looks like the run just stopped, when in fact the SuperLink's own log confirms it kept processing every row to completion server-side the whole time. Set `PYTHONIOENCODING=utf-8` before every `flwr run` in §4.6 and during the live demo.
- **Run config overrides for testing:** `--run-config "agent.server_url='http://localhost:PORT/api/signatures'"` (note the inner single-quotes around the string value) reliably overrides a `[tool.flwr.app.config.agent]` key from the CLI without editing pyproject.toml — useful for pointing at a non-default server port during rehearsal.

### 0c. Handoff checklist — org agents (Shritesh)

**Not a from-scratch task — the commit you have already contains all three org agents fully built and verified working end to end**, including a real cross-org match created from real model calls (§0b). `orgs/org_a/org_a/agent.py`, `org_b`, `org_c` are functionally identical (all three read `agent.org_id` etc. generically from run config); each has its own `pyproject.toml` and its own `data/mock_log.jsonl`. Nothing here needs rewriting from scratch — your job is to get it running on your machine, then make it *strong*, not to re-architect it. Don't touch `client/` — that's the other half of the team.

**Step 1 — get it running on your machine (do this first, it's quick):**

1. Local SuperLink state and `.flwr` app installs are per-machine, not carried by git — install `uv` and do a fresh local run to prove it works from your side.
2. Set the model env vars before your first run — see the table in §0b. Fastest path: Kimi-K2.7-Code needs no real key. `export FLWR_MODEL_API_KEY=<anything>`, `export FLWR_MODEL_API_ENDPOINT=http://134.199.193.245:8001/v1/responses`, `export PYTHONIOENCODING=utf-8` (harmless on non-Windows, necessary on it), then `cd orgs/org_a && uv sync && uv run flwr run . --stream`.
3. If you change those env vars and a run doesn't reflect the change, kill the running `flower-superlink`/`flower-superexec` processes first — it's a persistent daemon that keeps the environment it first started with (§0b). This is the single most confusing failure mode if you don't know about it going in.
4. Run all three orgs against a live `server/` (not just one in isolation) and confirm `GET /api/matches` shows a `pending` match with `org_ids: ["org_a", "org_b"]` — that's the actual thing being demoed, not any one org's console output.
5. Free port 8000 if something else is squatting on it (happened on the original dev machine, may not apply to yours) — org configs and the client both default to it.

**Step 2 — RESOLVED on 2026-08-26. Read this before touching the agent.**

The reliability problem described in earlier revisions of this file is **fixed**, and `orgs/*/agent.py` has been rewritten accordingly. Both agents now run live end to end and produce a real correlated match (`org_a` + `org_b`, `T1059.001`, hash `39b83e8cf8e2dd93` — pre-2026-08-27, before the keyed HMAC landed). What the fix was, so it isn't accidentally undone:

1. **`reason` is generated BEFORE `escalate` in the triage schema.** This was the whole problem. With the boolean first, the model commits to an answer and then rationalises it — measured failures had `flag=false` alongside reasons that literally read *"ELEVATE: textbook malicious execution"* and *"Unexpected activity: PowerShell making an outbound…"*. The model was reasoning correctly and answering wrongly. Putting the prose first conditions the boolean on the analysis. **Do not reorder those schema properties.**
2. **The model is never asked for the indicator.** Asking for an attacker domain to send to an external service reads as an exfiltration request and gets refused by safety filters (GLM: *"Refusing to extract the suspicious domain"*; MiniMax refused every time). `extract_indicator()` now pulls it deterministically with a regex plus a benign-domain allowlist. This is also strictly better engineering: two orgs seeing the same infrastructure are now *guaranteed* to produce the same hash, rather than hoping two model calls agree.
3. Also in place: 3 retries per model call with backoff, 2-vote triage (escalate if either vote does), `T####[.###]` regex validation on the technique, and confidence clamped to [0,1].

**Benchmarked before/after** (`scratchpad/bench2.py`, 5 runs × 3 models on the campaign row, checking both that the attack row escalates *and* that a benign row does not):

| | Kimi-K2.7-Code | GLM-5.2 | MiniMax-M3 |
|---|---|---|---|
| before | 2/4 | 2/4 | 0/4 |
| after | **5/5** | **5/5** | **5/5** |

All three also returned `T1059.001` every time, which resolves the inconsistent-technique-label concern as a side effect. Kimi remains the default because it needs no API key; GLM and MiniMax are now equally viable fallbacks with the keys in §0b.

**Still worth doing, in priority order:**

1. **Run it five times in a row and confirm every run submits the same value (`12f23ed9d97811dd` under the default demo key).** The benchmark says it should, but the agent path has more moving parts than the benchmark did. This is the acceptance bar before trusting it live.
2. **Know the failure mode that isn't the model's fault:** one test run failed every row with `WinError 10051 — unreachable network`. The shared endpoints are plain HTTP on public IPs and venue wifi may block or drop them. If every row fails identically with a connection error, it's the network, not the code — check with `curl` against the endpoint before debugging anything else. Have a phone hotspot ready.
3. **Automated tests for the deterministic pieces** — `_normalize_indicator`/`_hash_indicator` (confirm `http://X`, `X/`, ` X `, `X.` all hash identically — this is *why* cross-org matching works), `extract_indicator` (benign domains rejected, attacker domain found), `_leaks_identity`, and `_structured_output` against a captured Kimi response with its leading `reasoning` item.
4. **Verify the "org C joins late" flourish** end to end (§7 / `mock_log_flourish_row.jsonl`), or use the attack console's supply-chain scenario, which hits all three orgs and exercises the same three-org path.

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

### 6.4b Attack console (`/attacks`) — added 2026-08-26, not in the original design pass

The original demo path depended on the §7 campaign rows already sitting in each log, which reads as pre-staged. The attack console replaces that with something live: pick a scenario, launch it, and **real rows are appended to the targeted orgs' own `data/mock_log.jsonl` files** by the server. From that moment the ordinary §4.3 pipeline applies unchanged — each org still has to find the attack in its own telemetry.

Server side (`server/server/attacks.py`, endpoints `GET /api/attacks` and `POST /api/attacks/{id}/launch`):

- **Four scenarios**, all verified end to end: `phishing_macro_c2` (org_a + org_b, shares the §7 indicator so it hashes to `12f23ed9d97811dd` under the default demo key), `supply_chain_update` (all three orgs), `cred_harvest_proxy` (org_b + org_c), and `isolated_ransomware_staging` (org_c only). The last one is deliberately a **negative control** — it must produce no match, which demonstrates the mesh doesn't invent correlations. Worth showing judges.
- **Two launch modes.** `real` writes the rows and stops; you then run the Flower agents normally and they do the live model work — this is the honest end-to-end path and nothing shortcuts it. `demo` additionally runs `analyse_row`, a deterministic rule-based detector that stands in for the **LLM triage step only** so the demo takes seconds rather than minutes. It reads the real rows, derives the indicator from the row's own text, and hashes it with a function byte-identical to the agents'; correlation is the real §5.5 algorithm in both modes. Signatures created this way are returned in the launch response and badged `simulated` throughout the UI — they are never presented as agent output. This is §3 rule 1's "seeding synthetic input is fine" applied to one step, not a hardcoded result.
- **Timestamps are launch-relative**, so the correlator timeline reflects when you actually ran it rather than a fixed 2026-08-26T09:xx window.
- **Logs are mutated on disk, and rewound by `POST /api/demo/reset`.** The first time a log is appended to, the server snapshots it to `mock_log.baseline.jsonl` alongside it; reset restores every org from that baseline and clears all in-memory state. Baselines are gitignored. **Shritesh: this is why your log files may have extra rows during testing — hit reset (or the Reset button in the UI) to get back to the pristine §7 content.** Don't commit a mutated `mock_log.jsonl`.

`POST /api/demo/reset` also exists purely for rehearsal (§10 step 1) and is outside §5.4's contract.

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

## 11. Team split (two people, as of 2026-08-26 — original four-role version kept below for reference)

The original plan below assumed up to four people on `org_a`→`org_b`/`org_c`, `server/`, `client/`, and a floating Person D. All three of those core-build roles are done — see §0b for the org agents (verified live), and the earlier build passes for `server/` (fully implemented and tested) and `client/` (all six pages built per §6.4–6.5). What's actually left, split two ways:

- **Person 1** — Flower Hub publishing, README (public-facing, "open-source" per §9's mandatory submission items), GitHub repo setup, team details/track/description for submission, repo hygiene.
- **Person 2** — demo rehearsal against the 3–5 minute timer (§10), walking a match through Approve → Resolution live in the browser to confirm the full loop, and whichever stretch item (§9) there's time for: the "org C joins late" flourish, verifying `org_c`'s own live run, or trying GLM-5.2/MiniMax-M3 with the real organizer keys as a fallback if Kimi's JSON-following gets flaky under demo conditions.

Adjust freely — this is a starting split, not a hard assignment. Original four-role reference:

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

---

## 0d. The shared model endpoints are gone (verified 2026-08-31)

All four Track 2 endpoints in the §0b table are **dead** — every one returns no
response at all:

```
129.212.182.232:8001  Qwen3.5-397B     HTTP 000
134.199.193.245:8001  Kimi-K2.7-Code   HTTP 000
129.212.179.194:8001  GLM-5.2          HTTP 000
165.245.135.52:8001   MiniMax-M3       HTTP 000
```

They were provisioned for the event and withdrawn after it. Anything in this
file that says "Kimi needs no key, just point at that IP" is now historical.
**A live demo needs a model route decided before it starts**, and the stored
`supergrid.flower.ai` credential has expired (`flwr federation list supergrid`
returns "Authentication failed"), so `flwr login` has to be re-run first.

Two consequences already handled in code:

- **The agent preflights the model** before reading any rows. Previously a dead
  endpoint failed each row independently, three retries deep behind a 180-second
  connect timeout — a nine-minute run that produced nothing and never said why.
  It now aborts in one call with a message naming the environment variables and
  the SuperLink's env-caching behaviour.
- **The first `flwr run` after a reboot can time out** with "Failed to start
  local SuperLink within 15s". It is a cold-start timeout, not a real failure —
  the immediate retry succeeded. Warm the SuperLink up once before demoing.

## 0e. Real log ingestion (2026-08-31)

The agent no longer only reads mock JSONL. `agent.log_source` takes
`jsonl:<path>`, `file:<path>`, or `winevent:<channel>`, the last reading the
live Windows Event Log via `Get-WinEvent`.

What makes `winevent` work on a stock machine, verified here:

- The classic **`Windows PowerShell`** channel (events 400/403) records the full
  command line as `HostApplication=`, is enabled by default, and is readable
  **without admin**. Script-block logging (4104) needs a policy that is not set
  on this machine, so it is not depended on.
- Command lines are `-EncodedCommand` base64. `sources.decode_encoded_commands`
  expands them in place before anything reads the text — an indicator hidden in
  base64 would otherwise never correlate with the same indicator seen in the
  clear at another org.
- Local identity is redacted before triage sends the line to a model.

Verified end to end on 2026-08-31: a benign encoded PowerShell command run on
this laptop appeared in the real Event Log seconds later, was decoded, and
hashed to `12f23ed9d97811dd` — the same value the three demo orgs produce, so a
real machine correlates with the demo mesh.

Two bugs the first real-log run exposed, both fixed and regression-tested:

1. **Redaction ate the evidence.** An unanchored `DOMAIN\user` rule turned
   `...\v1.0\powershell.exe` into `...\v1.<domain>\<user>`, destroying the only
   part of the line worth triaging. Every redaction rule is now anchored to an
   explicit context.
2. **`TimeCreated.ToUniversalTime` was extracted as an indicator.** Real logs
   are full of dotted tokens that are not domains. A bare token is now only
   treated as one if its last label is a real TLD and it is not inside a
   filesystem path; URLs are matched first and win outright. Two orgs running
   the same tooling could otherwise have "correlated" on a shared library name.
