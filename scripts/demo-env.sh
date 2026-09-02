#!/usr/bin/env bash
# Source this before running an agent:  source scripts/demo-env.sh
#
# Model access. The AMD-hosted endpoints used at the hackathon were sponsored
# for the event and taken down afterwards (CLAUDE.md §0d). Flower's local
# SuperLink accepts any full Open-Responses endpoint, so the agent points at a
# hosted one — while still running locally, which is what keeps a real machine's
# own Event Log readable.
#
# Put your key in .env.local (gitignored):
#
#     VENICE_API_KEY=...        # preferred, see below
#     OPENROUTER_API_KEY=...    # fallback
#
# Venice is preferred because it does not retain prompts. Triage sends raw log
# lines to whatever endpoint is configured, so the provider's retention policy
# is part of this system's privacy story, not incidental to it — see
# docs/threat-model.md. OpenRouter is a router: it forwards to whichever
# upstream provider it picks, each with its own policy.

_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

set -a
[ -f "$_here/../.env.local" ] && . "$_here/../.env.local"
set +a

if [ -n "$VENICE_API_KEY" ]; then
  export FLWR_MODEL_API_ENDPOINT="https://api.venice.ai/api/v1/responses"
  export FLWR_MODEL_API_KEY="$VENICE_API_KEY"
  # GLM-5.2: ~4.5s per call on Venice and schema-capable. Kimi K2.7 Code is
  # ~17s and Qwen3.5 397B ~36s, which is minutes of dead air in a live demo.
  # minimax-m3-preview is faster still (~2.2s) if you need it.
  export POLLEN_MODEL="${POLLEN_MODEL:-zai-org-glm-5-2}"
  _provider="Venice (no prompt retention)"
elif [ -n "$OPENROUTER_API_KEY" ]; then
  export FLWR_MODEL_API_ENDPOINT="https://openrouter.ai/api/v1/responses"
  export FLWR_MODEL_API_KEY="$OPENROUTER_API_KEY"
  export POLLEN_MODEL="${POLLEN_MODEL:-moonshotai/kimi-k2.7-code}"
  _provider="OpenRouter"
else
  echo "No model key found. Create .env.local (gitignored) with one of:" >&2
  echo "    VENICE_API_KEY=..." >&2
  echo "    OPENROUTER_API_KEY=..." >&2
  return 1 2>/dev/null || exit 1
fi

# Model output contains characters the legacy Windows console codepage cannot
# encode; without this the CLI's own log stream silently stops mid-run.
export PYTHONIOENCODING=utf-8

# --- fast agent startup (demo convenience, opt-out) --------------------------
#
# By default Flower creates a fresh runtime environment per run and installs the
# app's dependencies into it with `uv sync`. That is the right default — it is
# what makes a run reproducible on a machine you do not control — but it costs
# ~46s of dead air per agent, measured with zero model calls, and a demo slot is
# three to five minutes.
#
# With this on, the app runs in the SuperLink's own Python environment instead:
# ~12s. The trade-off is real and worth stating plainly — the app no longer gets
# its own isolated dependency set, so it inherits whatever the SuperLink was
# started with. That is safe HERE because all four projects in this repo declare
# the same dependencies (flwr + requests), and it is verified: an org_a run
# executes correctly through a SuperLink started from org_c's venv.
#
# Set POLLEN_FAST_AGENTS=0 to turn it off and get Flower's normal isolation.
POLLEN_FAST_AGENTS="${POLLEN_FAST_AGENTS:-1}"
if [ "$POLLEN_FAST_AGENTS" = "1" ]; then
  export FLWR_DISABLE_RUNTIME_DEPENDENCY_INSTALLATION=1
  _startup="fast (~12s/run, shared env)"
else
  unset FLWR_DISABLE_RUNTIME_DEPENDENCY_INSTALLATION
  _startup="isolated (~46s/run, uv sync per run)"
fi

echo "provider : $_provider"
echo "endpoint : $FLWR_MODEL_API_ENDPOINT"
echo "model    : $POLLEN_MODEL"
echo "key      : ${FLWR_MODEL_API_KEY:0:10}… (${#FLWR_MODEL_API_KEY} chars)"
echo "startup  : $_startup"
echo
echo "The local SuperLink keeps whatever environment it FIRST started with, so"
echo "changing ANY of the above — including POLLEN_FAST_AGENTS — does nothing"
echo "until it is restarted:"
echo "    scripts/kill-superlink.sh"
