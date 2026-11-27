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
check() {
  if eval "$2"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1" >&2
  fi
}

# 1. Command form: options then a command -> command runs, status passes through.
out=$("$STUB" --what=sleep --why=keep-awake /bin/echo ok 2>/dev/null)
check "command form runs the command" '[ "$out" = "ok" ]'

# 2. Exit status passthrough for a failing command.
"$STUB" --what=sleep /bin/sh -c 'exit 42' 2>/dev/null
check "command exit status passes through" '[ "$?" -eq 42 ]'

# 3. Misread option value (not a real command) must NOT die: falls back to holding.
#    A 3-second timeout kill proves the stub stayed alive instead of exiting 127.
timeout_pid=""
"$STUB" --who some-value 2>/dev/null &
timeout_pid=$!
sleep 0.4
if kill -0 "$timeout_pid" 2>/dev/null; then
  kill "$timeout_pid" 2>/dev/null
  wait "$timeout_pid" 2>/dev/null
  check "misread value holds instead of dying" 'true'
else
  check "misread value holds instead of dying" 'false'
fi

# 4. No-arg form holds the lock until signaled (same liveness proof).
"$STUB" >/dev/null 2>&1 &
timeout_pid=$!
sleep 0.4
if kill -0 "$timeout_pid" 2>/dev/null; then
  kill "$timeout_pid" 2>/dev/null
  wait "$timeout_pid" 2>/dev/null
  check "no-arg form holds until signaled" 'true'
else
  check "no-arg form holds until signaled" 'false'
fi

echo "inhibit-stub: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
