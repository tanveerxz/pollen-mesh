# Pollen Mesh

**Three companies, three private log files, one shared attack caught, and a human
said yes twice before anything moved.**

Pollen Mesh is a privacy-preserving, cross-organization threat correlation system
built on [Flower Agent](https://flower.ai). Runner-up in **Track 2: Infrastructure**
at the Collaborative Agent Hackathon (Cambridge, 26 August 2026).

The metaphor: a bee carrying pollen between flowers that never touch.

The per-organization agent is published on Flower Hub as
[`tanveer/pollen-mesh-agent`](https://flower.ai).

## The problem

When a coordinated attack hits several companies at once, each security team sees
only its own sliver: one odd process chain here, one strange outbound connection
there. Individually it looks like noise; only comparing notes across companies makes
the pattern obvious. But companies won't hand each other raw security logs. They
compete, and they're bound by confidentiality and data-protection law. Existing
sharing circles (ISACs, MISP) work, but a human writes up each indicator by hand and
waits days for someone to notice the overlap, against an attack spreading in hours.

## The mechanism

1. **Local reasoning.** Each org runs its own isolated Flower `AgentApp` that reads
   *only its own* log. A live model triages each line (reasoning-first, recall-biased
   voting) and labels escalations with a MITRE ATT&CK technique id. The indicator is
   extracted **deterministically in code**, never by the model, so two orgs hit by
   the same infrastructure are guaranteed to produce the same hash, and no model
   safety filter can refuse the extraction. A deterministic guard-rail re-checks every
   field for identifying content, the agent's own code hashes the indicator under a
   consortium key, and the **only** outbound call the process ever makes is one HTTP
   POST of that stripped signature.
2. **Deterministic correlation.** A FastAPI server (no LLM anywhere in it) matches
   signatures across orgs: identical indicator hashes, meaning the same attacker
   infrastructure seen independently by two victims, or the same technique in
   overlapping time windows. A match above threshold is held **pending**.
3. **Human approval, twice.** Nothing is disclosed until a human reviews *exactly*
   what would be shared (technique, hash, window, orgs, and that is the entire record)
   and clicks Approve. Each org then has its own second gate before acting locally.
   `pending → approved → resolved`, or `pending → rejected`, and no other transitions
   exist.

## Why the indicator is keyed, not just hashed

A bare `sha256(domain)` is **not** private. Domains are a small, enumerable space.
An earlier version of this project published `39b83e8cf8e2dd93`, and it was recovered
in **121 guesses** from an 18-word list. Anyone holding the correlator's database,
including whoever operates it, could have reversed every indicator in it.

The indicator is now keyed with a secret shared by consortium members:

```
indicator = HMAC-SHA256(consortium_key, normalized_indicator)[:16]
```

Members hold the key. **The correlator never receives it.** Equal indicators still
produce equal values, so matching is unchanged, but the correlator can match without
being able to learn what it matched, and an outsider cannot enumerate at all.

Set `POLLEN_CONSORTIUM_KEY` to your own secret. The built-in default is public so
`git clone && run` works; with it, values *are* reversible, by design.

**This stops outsiders, not insiders.** A malicious member holds the key and can
brute-force. See [`docs/threat-model.md`](docs/threat-model.md) for what the
correlator still learns (the org-relationship graph, techniques, timings), where
inference runs, and the limits of exact matching.

## Repo layout

```text
├── pollen-mesh-agent/  the canonical agent, published to Flower Hub
├── orgs/               three demo orgs (org_a, org_b, org_c), each the same
│                       agent in its own project with its own local log
├── server/             FastAPI: owns all state, deterministic matching, both
│                       approval gates, the attack console, and the agent runner
├── client/             Next.js dashboard: guided demo, mission control, per-org
│                       views, correlator, and the two human gates
├── docs/               threat-model.md: what this does and does not protect
├── scripts/            demo-env.sh (model config), sync_agent.py, kill-superlink.sh
├── shared/             signature.md: the canonical shape of the one thing that
│                       crosses a boundary
└── CLAUDE.md           the full build specification and live-verified SDK notes
```

`pollen-mesh-agent/` is the single source of truth for agent code.
`scripts/sync_agent.py --check` fails if the three demo copies have drifted.

## Running it

```bash
# 1. Model access. Put a key in .env.local (gitignored):
#      VENICE_API_KEY=...        preferred, no prompt retention
#      OPENROUTER_API_KEY=...    fallback
source scripts/demo-env.sh

# 2. Server (port 8000)
cd server && uv sync && uv run uvicorn server.main:app --port 8000

# 3. Dashboard (port 3000)
cd client && npm install && npm run dev

# 4. Org agents. Easiest: press "Run agents" in the dashboard, which shells out
#    to the exact same command. Or by hand, one terminal per org:
cd orgs/org_a && uv sync && uv run flwr run . --stream
```

Then open <http://localhost:3000/demo> for the guided walkthrough.

**Model access needs a key.** The AMD-hosted endpoints provided for the hackathon
were withdrawn after the event, so `agent.model` now defaults to GLM-5.2 and
`scripts/demo-env.sh` points `FLWR_MODEL_API_ENDPOINT` at whichever provider you
have a key for. Any endpoint speaking the Open-Responses API works. Note that some
ignore `text.format` JSON schema, and some drop the `instructions` field entirely,
so the agent sends its schema both ways and parses replies leniently.

Two gotchas worth knowing before they cost you an hour:

- The local SuperLink is a **persistent daemon that keeps the environment it first
  started with**. Changing model settings does nothing until you run
  `scripts/kill-superlink.sh`.
- The **first `flwr run` after a reboot can time out** starting the SuperLink. It is
  a cold-start timeout, not a real failure. Run it again.

State is persisted to a SQLite snapshot (`server/.pollen-state.db`, gitignored), so
a crash mid-demo does not lose approved matches. `POST /api/demo/reset` clears it,
rewinds every org's log to its pristine baseline, and drops the agents' watermarks.

### Reading real telemetry

The demo orgs read mock JSONL, but the agent is not limited to it. `agent.log_source`
takes `jsonl:<path>`, `file:<path>`, or `winevent:<channel>` for the live Windows
Event Log:

```bash
flwr run . --run-config 'agent.log_source="winevent:Windows PowerShell"'
```

The classic `Windows PowerShell` channel records full command lines, is enabled by
default, and is readable without admin. Command lines arrive base64-encoded via
`-EncodedCommand`, and the agent decodes them before triage, so an indicator an
attacker obfuscated still correlates with the same indicator seen in the clear
elsewhere. Usernames and machine names are redacted before any line reaches a model.

Verified end to end: a benign encoded PowerShell command run on a laptop appeared in
the real Event Log seconds later, was decoded, and hashed to the same value the demo
orgs produce, so a real machine correlates with the demo mesh.

### The attack console

Rather than pre-staged log files, the dashboard can **launch an attack live**: the
server appends real telemetry rows to the targeted orgs' own logs, and from that
moment the ordinary pipeline applies, so each agent still has to find the needle in
its own telemetry. Four scenarios ship, including a deliberately isolated one that
must produce *no* match (the mesh doesn't invent correlations). `real` mode leaves
detection entirely to the live agents; `demo` mode substitutes a deterministic
rule-based detector for the LLM triage step only (clearly badged `simulated` in the
UI), with correlation always computed by the real matching algorithm.

## What's real vs. simulated

**Real:** the per-org LLM triage, the deterministic cross-org matching, the
approval-gated state machine, real log ingestion including the live Windows Event
Log, and the network boundary itself (only signatures cross, provably, via one HTTP
call per finding).

**Simulated for the demo:** the three demo orgs run as three isolated local processes
rather than three physically separate federation members. The privacy boundary is
still logically real, with no shared memory or files, and a genuinely external org
running its own agent joins the same mesh over HTTP. The second-gate "local action"
is a recorded decision, not wired to a real firewall or SIEM.

Nothing about the *output* is staged: matches, approvals, and every state transition
are computed live. Seeding the input data is fair; scripting the outcome never is.

## Tests

158 tests, covering every deterministic piece the cross-org match depends on:
indicator normalization and keyed hashing, deterministic extraction, the privacy
guard-rail, the MITRE technique gate, response parsing against a captured live model
response, base64 decoding and identity redaction, the full matching engine, both
approval gates, and crash persistence.

```bash
cd orgs/org_a && uv run --with pytest pytest tests/     # 103
cd server     && uv run --with pytest --with httpx pytest tests/   # 55
python scripts/sync_agent.py --check                    # agent copies in sync
```

Regression guards worth knowing about: one test fails if `_hash_indicator` ever
reverts to an unkeyed digest, and another asserts the matching engine never grows a
dependency on raw telemetry.

## Safety and oversight

The two human gates are the product, not decoration: agents reason locally,
disclosure requires explicit human approval of the exact payload, and local
follow-up action requires a second, per-org human approval. Remove them and there is
no defensible system left.

## License

MIT. See [`LICENSE`](LICENSE).
