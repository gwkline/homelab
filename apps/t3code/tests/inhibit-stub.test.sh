#!/usr/bin/env bash
# Regression tests for the systemd-inhibit stub shipped in the t3code
# image (apps/t3code/systemd-inhibit-stub.sh). The T3 runtime spawns
# systemd-inhibit to hold a sleep-inhibit lock; a missing binary shut
# the workspace down in an exit-75 loop.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STUB="$SCRIPT_DIR/../systemd-inhibit-stub.sh"
pass=0
fail=0

# 1. Command form: options then a command -> command runs, output passes.
out="$("$STUB" --what=sleep --why=keep-awake /bin/echo ok 2>/dev/null)"
if [ "$out" = "ok" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: command form runs the command" >&2
fi

# 2. Exit status passthrough for a failing command.
"$STUB" --what=sleep /bin/sh -c 'exit 42' 2>/dev/null
rc=$?
if [ "$rc" -eq 42 ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: command exit status passes through" >&2
fi

# 3. Misread option value (not a real command) must NOT die: the stub
#    falls back to holding the lock. Liveness proven with a kill probe.
"$STUB" --who some-value >/dev/null 2>&1 &
pid=$!
sleep 0.4
if kill -0 "$pid" 2>/dev/null; then
  pass=$((pass + 1))
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
else
  fail=$((fail + 1))
  echo "FAIL: misread value holds instead of dying" >&2
fi

# 4. No-arg form holds the lock until signaled (same liveness proof).
"$STUB" >/dev/null 2>&1 &
pid=$!
sleep 0.4
if kill -0 "$pid" 2>/dev/null; then
  pass=$((pass + 1))
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
else
  fail=$((fail + 1))
  echo "FAIL: no-arg form holds until signaled" >&2
fi

echo "inhibit-stub: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
