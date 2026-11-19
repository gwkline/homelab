#!/bin/bash
# One-time (Gavin's Mac): resolve the opencode-go API key used by the local
# Hermes agent and store it in a mode-600 env file OUTSIDE the repo. The judge
# (evals/judge.py) sources it via eval.py. The key itself is never printed,
# never committed.
set -euo pipefail

GAVIN_VOICE_LOCAL="${GAVIN_VOICE_LOCAL:-/Users/gkline/git-dev/gavin-voice-local}"
OUT="$GAVIN_VOICE_LOCAL/config/.judge_env"

WORKER_PID=$(ps aux | grep -E "python3 -m agent.managed_worker" | grep -v grep | awk '{print $2}' | head -1)
if [ -z "$WORKER_PID" ]; then
  echo "no running agent worker process found; set OPENCODE_GO_API_KEY manually" >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
ps eww "$WORKER_PID" | tr ' ' '\n' | grep -m1 '^OPENCODE_GO_API_KEY=' > "$OUT"
chmod 600 "$OUT"
echo "judge key stored at $OUT ($(wc -c < "$OUT") bytes, mode 600)"
