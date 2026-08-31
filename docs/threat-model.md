# Threat model

Pollen Mesh claims organisations can find shared attackers *without sharing raw
security data*. This document states exactly what that buys, and exactly where it
stops. Everything here is verifiable from the code.

## What actually leaves an organisation

One HTTP POST, containing four fields:

```json
{
  "org_id": "acme-corp",
  "technique": "T1059.001",
  "indicator": "12f23ed9d97811dd",
  "window_start": "2026-08-26T09:14:02Z",
  "window_end": "2026-08-26T09:14:55Z",
  "confidence": 0.9
}
```

No log lines, no hostnames, no usernames, no IP addresses, no filenames. The agent's
entire outbound surface is that one call plus its model calls — verifiable with
`grep -nE "requests\.|urllib|httpx|socket" agent.py`, which returns exactly one POST.

There is **no agent-to-agent channel**. Flower provides no cross-AgentApp calling
mechanism and we did not add one. Two orgs discover a shared attacker without
exchanging a single message: they independently compute the same value, and a third
party notices the values are equal.

## The mistake we made first, and why it mattered

The original implementation used a bare digest:

```python
indicator = sha256(normalize(domain))[:16]
```

That is **not** private. The preimage space is "domains" — small and enumerable. The
value published in our own README fell immediately:

```
candidates tried : 121
elapsed          : 0.00s
RECOVERED        : secure-update-delivery.net
```

121 guesses from an 18-word list. Anyone holding the correlator's database — including
whoever operates it — could have reversed every indicator in it. Hashing is not
encryption; against a small input space it is barely obfuscation.

## The fix: a consortium-keyed HMAC

```python
indicator = HMAC-SHA256(consortium_key, normalize(domain))[:16]
```

Members share the key. **The correlator never receives it.** Equal indicators still
produce equal values, so matching is unchanged — but the search space is now the key,
not the domain list.

Re-running the attack that previously worked:

| Attack | Candidates | Result |
|---|---|---|
| Unkeyed `sha256` (the break above) | 34,992 | no match |
| HMAC with guessed/default keys | 279,936 | no match |

The property this gives you, stated precisely:

> **The correlator can determine that two organisations saw the same indicator without
> being able to determine what that indicator was.**

Set `POLLEN_CONSORTIUM_KEY`. The built-in default is public and exists only so
`git clone && run` works — with it, values *are* reversible, by design.

Regression-guarded by `test_hash_is_keyed_not_a_bare_digest`, which fails if anyone
reverts to an unkeyed digest.

## What this does NOT protect against

Stated plainly, because a partial guarantee presented as a total one is worse than none.

**A malicious consortium member.** They hold the key, so they can enumerate the space
and reverse any value they see. HMAC stops outsiders, not insiders. Private set
intersection is the honest next step and is not implemented.

**Metadata at the correlator.** Even unable to read indicators, the correlator learns:
which organisations correlate with which, how often, when, the MITRE technique labels,
time windows, and confidence scores. That is a real relationship graph. If the
correlator is untrusted, this is not nothing.

**Where inference runs.** Triage sends each log line to whatever
`FLWR_MODEL_API_ENDPOINT` is configured. "Analysed locally" means *no other
organisation* sees your telemetry — it does **not** mean inference is on-device unless
you point it at a local model. This is the same trust decision as any hosted LLM, and
it is yours to make.

**Membership.** The system reveals to other members that you were hit by something they
were also hit by. That is the entire point, but it is still disclosure — which is why
the two human approval gates exist and why nothing crosses a boundary automatically.

## Correlation: what it can and cannot spot

Matching is exact equality on a normalised indicator. Measured against the same attacker
infrastructure as it realistically varies between two organisations:

| Variant | Matches? |
|---|---|
| `secure-update-delivery.net` | yes |
| `https://secure-update-delivery.net/` | yes (scheme and trailing punctuation normalised) |
| `www.secure-update-delivery.net` | **no** |
| `cdn.secure-update-delivery.net` | **no** |
| `secure-update-delivery.com` (TLD rotation) | **no** |
| `secure-updates-delivery.net` (typosquat) | **no** |

So the claim "identifies related threats across companies" is true for **exactly shared
infrastructure**, which is a real and common case — attackers reuse infrastructure — and
false for most rotation. Subdomain collapsing (eTLD+1) is planned and fixes the first two
rows. Rotation and typosquats need fuzzy matching, which is fundamentally incompatible
with "equal hashes or nothing"; that is future work, not a solved problem.

The secondary rule — same technique within a padded time window — is deliberately weak
and will produce false positives at volume. It exists so a match is still possible when
no indicator is shared, and every match it produces still requires human approval.

## Trust boundaries

| Party | Sees | Cannot see |
|---|---|---|
| An org's own agent | its own raw log | any other org's anything |
| The correlator | keyed indicators, techniques, windows, org ids | raw logs, real indicators |
| Another member | an approved disclosure's four fields | your logs, your other signatures |
| An outsider | nothing (with auth enabled) | everything |
| Model provider | log lines sent for triage | anything not sent to it |

The correlator's raw-log endpoints (`/api/orgs/{id}/log`, `/api/orgs/{id}/hunt`) are
**demo-mode only** and refuse real orgs with `403`. They exist because in demo mode the
server also plays the part of the three demo orgs' own machines. The real retro-hunt runs
in the agent (`hunt_own_log`), on the org's own machine — a correlator that greps your
raw logs is precisely what this system exists to avoid.

## Human oversight

Two gates, both required, neither bypassable:

1. **Disclosure.** A match is created `pending` and does nothing until a human approves
   the exact four fields shown. Rejection is terminal.
2. **Action.** Each organisation separately decides whether to act. One declining does
   not undo another's decision.

No code path discloses or acts automatically. Correlation itself is deterministic — no
model decides what matches — so every match is reproducible and explainable.
