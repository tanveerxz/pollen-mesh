#!/usr/bin/env bash
# The local SuperLink is a persistent daemon that outlives `flwr run` and keeps
# the environment it first started with. Changing FLWR_MODEL_API_ENDPOINT or
# FLWR_MODEL_API_KEY does nothing until it is restarted — the symptom is
# identical errors across attempts that should differ (CLAUDE.md §0b).
set -u
killed=0
for name in flower-superexec flower-superlink; do
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //IM "$name.exe" >/dev/null 2>&1 && { echo "killed $name"; killed=1; }
  else
    pkill -f "$name" >/dev/null 2>&1 && { echo "killed $name"; killed=1; }
  fi
done
[ "$killed" = 1 ] || echo "no SuperLink running"
echo "next 'flwr run' will start a fresh one and inherit your current environment"
