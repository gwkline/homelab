#!/bin/sh
# In-pod runner for the dispatch flow smoke (issue #30). Executes inside the
# smoke Job pod as ServiceAccount `dispatcher` — the same identity, image,
# and netpol label as the dispatch-watcher CronJob pod — and proves against
# the live cluster that:
#   1. the first watcher run lists the fixture issue and dispatches exactly
#      one runnable Job
#   2. that Job reaches Complete and its logs carry the issue number
#   3. a second watcher run reports the existing dispatch and creates nothing
# Required env: SMOKE_ISSUE, SMOKE_JOB, SMOKE_NAMESPACE, SMOKE_WATCHER,
# SMOKE_JOB_WAIT (numeric seconds), WATCHER_REPO. Only the GitHub API is
# mocked (/smoke/gh); every kubectl call below is real.
set -eu

ISSUE="${SMOKE_ISSUE:?SMOKE_ISSUE required}"
JOB="${SMOKE_JOB:?SMOKE_JOB required}"
NS="${SMOKE_NAMESPACE:?SMOKE_NAMESPACE required}"
WATCHER="${SMOKE_WATCHER:?SMOKE_WATCHER required}"
JOB_WAIT="${SMOKE_JOB_WAIT:-480}"

fail() {
  echo "==> FAIL: $1" >&2
  exit 1
}

# The watcher execs `gh`; put the mock first on PATH (executable via the
# ConfigMap defaultMode).
PATH="/smoke:${PATH}"
export PATH

[ -x /smoke/gh ] || fail "/smoke/gh mock not executable (ConfigMap defaultMode 0755)"
command -v node >/dev/null 2>&1 || fail "node not found in image"
command -v kubectl >/dev/null 2>&1 || fail "kubectl not found in image"

# wait_complete <job>: block until the Job completes; fail fast when it lands
# in Failed instead of burning the whole timeout.
wait_complete() {
  wait_job="$1"
  wait_elapsed=0
  while [ "$wait_elapsed" -lt "$JOB_WAIT" ]; do
    wait_done="$(kubectl get job "$wait_job" -n "$NS" \
      -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
    [ "$wait_done" = "True" ] && return 0
    wait_dead="$(kubectl get job "$wait_job" -n "$NS" \
      -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)"
    [ "$wait_dead" = "True" ] && return 1
    sleep 5
    wait_elapsed=$((wait_elapsed + 5))
  done
  return 1
}

echo "==> [1/4] watcher run 1: list fixture issue #${ISSUE}, dispatch ${JOB}"
if ! node "$WATCHER" >/tmp/run1.log 2>&1; then
  cat /tmp/run1.log >&2
  fail "watcher run 1 exited non-zero (GitHub query or kubectl apply failed)"
fi
cat /tmp/run1.log
grep -F "dispatched ${JOB} for #${ISSUE}" /tmp/run1.log >/dev/null ||
  fail "run 1 did not dispatch ${JOB}"
grep -F "open=1 dispatched=1" /tmp/run1.log >/dev/null ||
  fail "run 1 summary is not 'open=1 dispatched=1' (unexpected fixture handling)"
if grep -qF "already dispatched" /tmp/run1.log; then
  fail "run 1 skipped ${JOB} as already dispatched (stale Job survived host cleanup)"
fi

echo "==> [2/4] dispatched Job ${JOB} must reach Complete (max ${JOB_WAIT}s)"
if ! wait_complete "$JOB"; then
  kubectl describe job "$JOB" -n "$NS" >&2 || true
  kubectl get pods -n "$NS" -l "job-name=${JOB}" -o name 2>/dev/null |
    while IFS= read -r dead_pod; do
      [ -n "$dead_pod" ] || continue
      kubectl logs -n "$NS" "$dead_pod" --tail=-1 >&2 || true
    done
  fail "dispatched Job ${JOB} did not reach Complete within ${JOB_WAIT}s"
fi
echo "  Job ${JOB}: Complete"

echo "==> [3/4] dispatched Job logs must include issue ${ISSUE}"
job_logs="$(kubectl logs "job/${JOB}" -n "$NS" --tail=-1 2>/dev/null || true)"
printf '%s\n' "$job_logs"
printf '%s\n' "$job_logs" | grep -F "issue ${ISSUE}: dispatch flow smoke passed" >/dev/null ||
  fail "dispatched Job logs missing 'issue ${ISSUE}: dispatch flow smoke passed'"

echo "==> [4/4] watcher run 2: report the existing dispatch, create nothing"
if ! node "$WATCHER" >/tmp/run2.log 2>&1; then
  cat /tmp/run2.log >&2
  fail "watcher run 2 exited non-zero"
fi
cat /tmp/run2.log
grep -F "skip ${JOB} (already dispatched)" /tmp/run2.log >/dev/null ||
  fail "run 2 did not report ${JOB} as already dispatched"
grep -F "dispatched=0" /tmp/run2.log >/dev/null ||
  fail "run 2 dispatched again — duplicate Job!"
job_count="$(kubectl get jobs -n "$NS" -o name 2>/dev/null | grep -Fxc "job/${JOB}" || true)"
[ "$job_count" = "1" ] ||
  fail "expected exactly 1 Job named ${JOB}, found ${job_count:-none}"

echo "DISPATCH FLOW SMOKE PASS: issue #${ISSUE} -> one Complete Job (${JOB}); second watcher run dispatched nothing"
