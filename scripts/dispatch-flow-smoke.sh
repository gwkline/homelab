#!/bin/sh
# End-to-end proof of the dispatcher issue -> Job flow (issue #30).
#
# Proves behaviorally, against the live cluster — never from manifest
# rendering alone:
#   1. the dispatch-watcher CronJob pod is specified to run as ServiceAccount
#      `dispatcher`, any live watcher pod does too, and that identity holds
#      exactly the RBAC deploy/dispatcher/base/rbac.yaml grants (Job
#      create/get in sandbox — the watcher's calls; nothing else; secrets
#      denied)
#   2. one open `run-agent` issue makes the watcher list it and submit
#      exactly one runnable sandbox Job
#   3. the dispatched Job reaches Complete and its logs carry the issue
#      number
#   4. a second watcher invocation reports the existing dispatch ("already
#      dispatched") and creates nothing
#
# The GitHub API is the only mocked link: a smoke Job — same ServiceAccount,
# image, and app=dispatch-watcher netpol label as the CronJob pod — runs the
# real examples/dispatch-watcher.mjs with a stand-in `gh` serving the
# documented disposable fixture issue #424242
# (scripts/dispatch-flow/fixture-issues.json). kubectl, RBAC, Job creation,
# pod execution and logs are all real, so no manifest render is trusted and
# no real issue work is triggered.
#
# Usage:
#   ./scripts/dispatch-flow-smoke.sh
#   DISPATCH_FLOW_KEEP=1 ./scripts/dispatch-flow-smoke.sh  # keep artifacts
#   DISPATCH_FLOW_TIMEOUT=960   # host-side wait, seconds
#   DISPATCH_FLOW_JOB_WAIT=480  # dispatched-Job completion wait, seconds
#
# Requirements: kubectl with cluster-admin (RBAC probes impersonate the
# dispatcher identity); deploy/dispatcher/base applied (its rbac.yaml ships
# the purpose-specific dispatcher Role — no hermes/base dependency since #26;
# the netpol comes with the dispatcher kustomization); the loop-agent image
# pullable in the cluster.
# On failure prints RBAC checks, watcher logs and dispatched-Job events, and
# keeps the artifacts for inspection:
#   kubectl delete job dispatch-flow-smoke dispatched-issue-424242 \
#     configmap dispatch-flow-smoke -n sandbox --ignore-not-found
set -eu

NS=sandbox
CRONJOB=dispatch-watcher
SMOKE=dispatch-flow-smoke
ISSUE=424242
JOB="dispatched-issue-${ISSUE}"
AS_DISPATCHER="system:serviceaccount:agents:dispatcher"
IMAGE="ghcr.io/gwkline/homelab/loop-agent"
WATCHER_REPO="${DISPATCH_FLOW_REPO:-gwkline/homelab}"
JOB_WAIT="${DISPATCH_FLOW_JOB_WAIT:-480}"
OUTER_WAIT="${DISPATCH_FLOW_TIMEOUT:-$((JOB_WAIT + 480))}"

cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# can <verb> <resource> <expected yes|no> — one impersonated RBAC probe.
can() {
  can_got="$(kubectl auth can-i "$1" "$2" -n "$NS" --as="$AS_DISPATCHER" 2>&1 || true)"
  printf '  can-i %-8s %-13s -> %s (expect %s)\n' "$1" "$2" "$can_got" "$3"
  [ "$can_got" = "$3" ] || CAN_FAIL=1
}

# Every RBAC probe for the dispatcher identity; non-zero on drift.
# Positives are the watcher's exact calls (examples/dispatch-watcher.mjs:
# `kubectl get job` + `kubectl apply` of a new Job); everything else is a
# negative probe — the dispatcher Role grants nothing else (#26).
rbac_checks() {
  CAN_FAIL=0
  can create jobs.batch yes
  can get jobs.batch yes
  can list jobs.batch no
  can patch jobs.batch no
  can delete jobs.batch no
  can get cronjobs.batch no
  can patch cronjobs.batch no
  can delete cronjobs.batch no
  can get pods no
  can get pods/log no
  can create secrets no
  can list secrets no
  [ "$CAN_FAIL" -eq 0 ]
}

# On failure: watcher logs, dispatched-Job events, RBAC checks (acceptance
# criteria) — everything an operator needs without re-running the flow.
dump_diagnostics() {
  echo "----- RBAC as ${AS_DISPATCHER} -----" >&2
  rbac_checks >&2 || true
  echo "----- smoke Job ${SMOKE}: describe + pod logs (watcher output) -----" >&2
  kubectl describe job "$SMOKE" -n "$NS" >&2 || true
  kubectl get pods -n "$NS" -l "job-name=${SMOKE}" -o name 2>/dev/null |
    while IFS= read -r diag_pod; do
      [ -n "$diag_pod" ] || continue
      kubectl logs -n "$NS" "$diag_pod" --tail=-1 >&2 || true
    done
  echo "----- dispatched Job ${JOB}: describe, events, pod logs -----" >&2
  kubectl describe job "$JOB" -n "$NS" >&2 || true
  kubectl get events -n "$NS" --field-selector "involvedObject.name=${JOB}" >&2 || true
  kubectl get pods -n "$NS" -l "job-name=${JOB}" -o name 2>/dev/null |
    while IFS= read -r diag_pod; do
      [ -n "$diag_pod" ] || continue
      kubectl logs -n "$NS" "$diag_pod" --tail=-1 >&2 || true
    done
  echo "----- artifacts kept; clean up with -----" >&2
  echo "  kubectl delete job ${SMOKE} ${JOB} configmap ${SMOKE} -n ${NS} --ignore-not-found" >&2
}

echo "==> [1/5] dispatcher CronJob pod identity + RBAC"
command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
kubectl get namespace "$NS" >/dev/null 2>&1 ||
  fail "cluster unreachable or namespace '${NS}' missing"

cj_sa="$(kubectl get cronjob "$CRONJOB" -n "$NS" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.serviceAccountName}')"
[ "$cj_sa" = "dispatcher" ] ||
  fail "CronJob ${CRONJOB} pod template runs as ServiceAccount '${cj_sa}' (want dispatcher)"

cj_label="$(kubectl get cronjob "$CRONJOB" -n "$NS" \
  -o jsonpath='{.spec.jobTemplate.spec.template.metadata.labels.app}')"
[ "$cj_label" = "dispatch-watcher" ] ||
  fail "CronJob pod label app='${cj_label}' (want dispatch-watcher — netpol allow-dispatcher-k8s-api selects it)"

cj_mount="$(kubectl get cronjob "$CRONJOB" -n "$NS" \
  -o jsonpath='{.spec.jobTemplate.spec.template.spec.automountServiceAccountToken}')"
[ "$cj_mount" = "true" ] ||
  fail "CronJob pod template must automount the ServiceAccount token (in-pod kubectl needs it)"
echo "  ok: CronJob pod template: ServiceAccount=dispatcher, app=dispatch-watcher, token mounted"

live_sa="$(kubectl get pods -n "$NS" -l app=dispatch-watcher \
  -o jsonpath='{.items[0].spec.serviceAccountName}' 2>/dev/null || true)"
if [ -n "$live_sa" ]; then
  [ "$live_sa" = "dispatcher" ] ||
    fail "live dispatch-watcher pod runs as ServiceAccount '${live_sa}' (want dispatcher)"
  echo "  ok: live dispatch-watcher pod runs as ServiceAccount dispatcher"
else
  echo "  note: no live dispatch-watcher pod yet (schedule has not fired since apply);"
  echo "        identity is exercised below by running the flow as that ServiceAccount"
fi

if rbac_checks; then
  echo "  ok: dispatcher RBAC matches deploy/dispatcher/base/rbac.yaml (watcher verbs only; secrets denied)"
else
  dump_diagnostics
  fail "dispatcher RBAC drift (see probes above)"
fi

echo "==> [2/5] clearing stale smoke artifacts (idempotent reruns)"
kubectl delete job "$SMOKE" -n "$NS" --ignore-not-found >/dev/null
kubectl delete job "$JOB" -n "$NS" --ignore-not-found >/dev/null
kubectl delete configmap "$SMOKE" -n "$NS" --ignore-not-found >/dev/null

echo "==> [3/5] packaging fixture + real watcher into ConfigMap ${SMOKE}"
[ -f "examples/dispatch-watcher.mjs" ] || fail "examples/dispatch-watcher.mjs missing"
[ -f "scripts/dispatch-flow/fixture-issues.json" ] ||
  fail "scripts/dispatch-flow/fixture-issues.json missing"
[ -f "scripts/dispatch-flow/mock-gh.sh" ] || fail "scripts/dispatch-flow/mock-gh.sh missing"
[ -f "scripts/dispatch-flow/runner.sh" ] || fail "scripts/dispatch-flow/runner.sh missing"
kubectl create configmap "$SMOKE" -n "$NS" \
  --from-file=dispatch-watcher.mjs=examples/dispatch-watcher.mjs \
  --from-file=issues.json=scripts/dispatch-flow/fixture-issues.json \
  --from-file=gh=scripts/dispatch-flow/mock-gh.sh \
  --from-file=runner.sh=scripts/dispatch-flow/runner.sh >/dev/null

echo "==> [4/5] launching smoke Job ${SMOKE} in ${NS} (identity: dispatcher)"
MANIFEST=$(cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${SMOKE}
  namespace: ${NS}
  labels:
    app.kubernetes.io/part-of: homelab
spec:
  backoffLimit: 0
  activeDeadlineSeconds: $((JOB_WAIT + 420))
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        # Same label as the CronJob pod template: netpol
        # allow-dispatcher-k8s-api opens the Kubernetes API path for these pods.
        app: dispatch-watcher
    spec:
      # The identity under test — identical to the CronJob pod template.
      serviceAccountName: dispatcher
      automountServiceAccountToken: true
      restartPolicy: Never
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: smoke
          image: ${IMAGE}
          # Overrides the image entrypoint (run-loop): no repo sync needed.
          command: ["sh", "/smoke/runner.sh"]
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          env:
            - name: HOME
              value: /tmp
            - name: SMOKE_ISSUE
              value: "${ISSUE}"
            - name: SMOKE_JOB
              value: "${JOB}"
            - name: SMOKE_NAMESPACE
              value: "${NS}"
            - name: SMOKE_WATCHER
              value: /smoke/dispatch-watcher.mjs
            - name: SMOKE_JOB_WAIT
              value: "${JOB_WAIT}"
            - name: WATCHER_REPO
              value: "${WATCHER_REPO}"
            - name: WATCHER_LABEL
              value: run-agent
            - name: DISPATCH_PREFIX
              value: dispatched
            - name: DISPATCH_COMMAND
              # Runs in the DISPATCHED Job; the watcher injects WATCHER_ISSUE.
              value: |
                echo "issue \${WATCHER_ISSUE}: dispatch flow smoke passed"
          volumeMounts:
            - name: smoke
              mountPath: /smoke
              readOnly: true
          resources:
            requests:
              cpu: "100m"
              memory: 256Mi
            limits:
              memory: 1Gi
      volumes:
        - name: smoke
          configMap:
            name: ${SMOKE}
            defaultMode: 0755 # executable /smoke/gh mock
EOF
)
printf '%s\n' "$MANIFEST" | kubectl apply -f - >/dev/null

echo "==> [5/5] flow under watch: dispatch -> Job Complete -> second run dedupes (max ${OUTER_WAIT}s)"
elapsed=0
smoke_status=timeout
while [ "$elapsed" -lt "$OUTER_WAIT" ]; do
  smoke_done="$(kubectl get job "$SMOKE" -n "$NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)"
  smoke_failed="$(kubectl get job "$SMOKE" -n "$NS" \
    -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)"
  if [ "$smoke_done" = "True" ]; then smoke_status=complete; break; fi
  if [ "$smoke_failed" = "True" ]; then smoke_status=failed; break; fi
  sleep 5
  elapsed=$((elapsed + 5))
done

echo "==> smoke pod logs (watcher runs + in-cluster assertions)"
kubectl logs "job/${SMOKE}" -n "$NS" --tail=-1 || true

if [ "$smoke_status" != "complete" ]; then
  echo "FAIL: smoke Job ${SMOKE} ended '${smoke_status}' — diagnostics follow" >&2
  dump_diagnostics
  exit 1
fi

smoke_logs="$(kubectl logs "job/${SMOKE}" -n "$NS" --tail=-1 || true)"
printf '%s\n' "$smoke_logs" | grep -q "DISPATCH FLOW SMOKE PASS" || {
  echo "FAIL: smoke pod completed without its pass marker — diagnostics follow" >&2
  dump_diagnostics
  exit 1
}

# The in-pod runner cannot read pod logs (the dispatcher identity is limited
# to Job get/create), so the "logs carry the issue number" proof runs here,
# with cluster credentials.
dispatch_logs="$(kubectl logs "job/${JOB}" -n "$NS" --tail=-1 || true)"
printf '%s\n' "$dispatch_logs" | grep -qF "issue ${ISSUE}: dispatch flow smoke passed" || {
  echo "FAIL: dispatched Job ${JOB} logs missing the pass marker — diagnostics follow" >&2
  dump_diagnostics
  exit 1
}

echo "==> PASS confirmed; cleaning up smoke artifacts"
if [ "${DISPATCH_FLOW_KEEP:-0}" = "1" ]; then
  echo "  DISPATCH_FLOW_KEEP=1 — kept job/${SMOKE} job/${JOB} configmap/${SMOKE} in ${NS}"
else
  kubectl delete job "$SMOKE" -n "$NS" --ignore-not-found >/dev/null
  kubectl delete job "$JOB" -n "$NS" --ignore-not-found >/dev/null
  kubectl delete configmap "$SMOKE" -n "$NS" --ignore-not-found >/dev/null
fi

echo "PASS: dispatcher issue -> Job flow proven end to end (issue #30)"
echo "  - CronJob pod identity: ServiceAccount dispatcher (spec + live pods + RBAC probes)"
echo "  - open run-agent issue #${ISSUE} -> Job ${JOB} submitted, Complete, logs carry the issue number"
echo "  - second watcher run reported 'already dispatched', dispatched=0, exactly one Job"
