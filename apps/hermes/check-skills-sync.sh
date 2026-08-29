#!/bin/sh
# Print a loud warning if the last skills sync didn't produce a healthy state.
# Called from run-hermes.sh before the gateway starts. Never fails the pod.
PY=/opt/hermes/.venv/bin/python3
command -v "$PY" >/dev/null 2>&1 || PY=python3
command -v "$PY" >/dev/null 2>&1 || { echo "WARNING: skills-sync check: no python available"; exit 0; }
STATUS="${HERMES_HOME:-/data/hermes}/skills-sync/status.json"
[ -f "$STATUS" ] || { echo "WARNING: skills-sync: no status file — skills were never synced this pod's lifetime"; exit 0; }
"$PY" - "$STATUS" <<'PYEOF'
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"WARNING: skills-sync: unreadable status: {e}")
    sys.exit(0)
if s.get("ok"):
    print(f"skills-sync: OK ref={s.get('ref')} commit={str(s.get('commit'))[:7]} at {s.get('time')}")
else:
    print(f"WARNING: skills-sync STALE — last sync FAILED at {s.get('time')}: {s.get('error', '')[:300]}")
PYEOF
