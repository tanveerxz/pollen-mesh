# Pollen Mesh

**Three companies, three private log files, one shared attack caught — and a human
said yes twice before anything moved.**

Pollen Mesh is a privacy-preserving, cross-organization threat correlation system
built on [Flower Agent](https://flower.ai) for the Collaborative Agent Hackathon
(Cambridge, 26 August 2026) — **Track 2: Infrastructure**.

The metaphor: a bee carrying pollen between flowers that never touch.

## The problem

When a coordinated attack hits several companies at once, each security team sees
only its own sliver — one odd process chain here, one strange outbound connection
there. Individually it looks like noise; only comparing notes across companies makes
the pattern obvious. But companies won't hand each other raw security logs: they
compete, and they're bound by confidentiality and data-protection law. Existing
sharing circles (ISACs, MISP) work, but a human writes up each indicator by hand and
waits days for someone to notice the overlap — against an attack spreading in hours.

## The mechanism

1. **Local reasoning.** Each org runs its own isolated Flower `AgentApp` that reads
   *only its own* log. A live model triages each line (reasoning-first, majority-recall
   voting) and labels escalations with a MITRE ATT&CK technique id. The indicator is
   extracted **deterministically in code** — never by the model — so two orgs hit by
   the same infrastructure are guaranteed to produce the same hash, and no safety
   filter can refuse the extraction. A deterministic guard-rail re-checks every field
   for identifying content, the agent's own code one-way-hashes the indicator, and
   the **only** outbound call the process ever makes is one HTTP POST of that
   stripped signature.
2. **Deterministic correlation.** A FastAPI server (no LLM anywhere in it) matches
   signatures across orgs: identical indicator hashes — the same attacker
   infrastructure seen independently by two victims — or the same technique in
   overlapping time windows. A match above threshold is held **pending**.
3. **Human approval, twice.** Nothing is disclosed until a human reviews *exactly*
   what would be shared (technique, hash, window, orgs — that's the entire record)
   and clicks Approve. Each org then has its own second gate before acting locally.
   `pending → approved → resolved`, or `pending → rejected`, and no other transitions
   exist.

## Repo layout

```text
├── orgs/            three isolated Flower AgentApps (org_a, org_b, org_c),
│                    each with its own dependency environment and its own local log
├── server/          FastAPI — owns all state, deterministic matching, both approval
│                    gates, the attack-scenario console, and the agent runner
├── client/          Next.js dashboard — mission control, per-org views, correlator,
│                    the two human gates, and the live attack console
├── shared/          signature.md — the canonical shape of the one thing that crosses
│                    a boundary
└── CLAUDE.md        the full build specification and live-verified SDK notes
```

## Running it

```bash
# 1. Server (port 8000)
cd server && uv sync && uv run uvicorn server.main:app --reload --port 8000

# 2. Dashboard (port 3000)
cd client && npm install && npm run dev

# 3. Org agents — no flwr login, no API key. `flwr run .` auto-launches a local
#    SuperLink, and the default model (Kimi-K2.7-Code) accepts any key.
#    Easiest: press "Run agents" in the dashboard (the server shells out to the
#    exact same command). Or by hand, one terminal per org:
cd orgs/org_a && uv sync && uv run flwr run . --stream
cd orgs/org_b && uv sync && uv run flwr run . --stream
cd orgs/org_c && uv sync && uv run flwr run . --stream
```

Model access is a per-model endpoint pair (`FLWR_MODEL_API_ENDPOINT` /
`FLWR_MODEL_API_KEY`); sensible Kimi defaults are baked in, so nothing needs
configuring. See CLAUDE.md §0b for the full model table (GLM-5.2 / MiniMax-M3 need
organizer-issued keys) and for the one real gotcha: the local SuperLink daemon keeps
the environment it first started with — kill `flower-superlink` before switching
models.

Server state is in-memory by design; `POST /api/demo/reset` (or the dashboard's
Reset button) clears it and rewinds every org's log to its pristine baseline.

### The attack console

Rather than pre-staged log files, the dashboard can **launch an attack live**: the
server appends real telemetry rows to the targeted orgs' own logs, and from that
moment the ordinary pipeline applies — each agent still has to find the needle in
its own telemetry. Four scenarios ship, including a deliberately isolated one that
must produce *no* match (the mesh doesn't invent correlations). `real` mode leaves
detection entirely to the live agents; `demo` mode substitutes a deterministic
rule-based detector for the LLM triage step only (clearly badged `simulated` in the
UI), with correlation always computed by the real matching algorithm.

## What's real vs. simulated

**Real:** the per-org LLM triage, the deterministic cross-org matching, the
approval-gated state machine, and the network boundary itself (only signatures
cross, provably, via one HTTP call per finding).

**Simulated for one day's scope:** the three orgs run as three isolated local
processes rather than three physically separate federation members (the privacy
boundary is still logically real — no shared memory or files), and the second-gate
"local action" is a recorded decision, not wired to a real firewall/SIEM.

Nothing about the *output* is staged: matches, approvals, and every state transition
are computed live. Seeding the input data is fair; scripting the outcome never is.

## Tests

Each org ships tests for every deterministic piece the cross-org match depends on
(indicator extraction and hashing, the privacy guard-rail, the MITRE technique gate,
and response parsing against a captured live model response):

```bash
cd orgs/org_a && uv run --no-sync --with pytest pytest
```

## Safety and oversight

The two human gates are the product, not decoration: agents reason locally,
disclosure requires explicit human approval of the exact payload, and local
follow-up action requires a second, per-org human approval. Remove them and there is
no defensible system left.

## License

Apache-2.0
