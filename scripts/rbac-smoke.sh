#!/bin/sh
# RBAC conformance smoke (issue #26): one purpose-scoped Role per principal.
# Proves, against the live cluster, that each ServiceAccount holds exactly
# the permissions its documented workflow needs — positive AND negative
# kubectl auth can-i assertions per identity, in the same style as the
# dispatch-flow smoke (scripts/dispatch-flow-smoke.sh):
#   hermes     — read-only self-visibility + cluster health; no write path
#                anywhere (factory orchestration goes through Executor, #82);
#                CronJob mutation is not required and not granted
#   panel      — sandbox run surface (Jobs create/list/delete, CronJobs
#                get/list/patch for the schedules card), Service gets in
#                agents, cluster-wide node/pod lists; no CronJob
#                create/delete, no pod/log reads, no secrets
#   dispatcher — Job get + create in sandbox only (dispatch-watcher flow)
# No principal may patch or delete CronJobs unless its documented workflow
# requires it — only the panel does, asserted as a positive below; the
# others are asserted as negatives.
#
# Usage: ./scripts/rbac-smoke.sh
# Requirements: kubectl with cluster-admin (probes impersonate the Service-
# Accounts); deploy/hermes/base, deploy/panel/base and deploy/dispatcher/base
# applied.
set -eu

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

AS_HERMES="system:serviceaccount:agents:hermes"
AS_PANEL="system:serviceaccount:agents:panel"
AS_DISPATCHER="system:serviceaccount:sandbox:dispatcher"

CAN_FAIL=0

# check <as> <namespace|-> <verb> <resource> <expect yes|no>
# "-" as the namespace means a cluster-scoped probe.
check() {
  can_as="$1"
  can_ns="$2"
  can_what="$3 $4"
  expect="$5"
  if [ "$can_ns" = "-" ]; then
    can_got="$(kubectl auth can-i "$3" "$4" --as="$can_as" 2>&1 || true)"
  else
    can_got="$(kubectl auth can-i "$3" "$4" -n "$can_ns" --as="$can_as" 2>&1 || true)"
  fi
  printf '  %-10s %-8s can-i %-22s -> %s (expect %s)\n' \
    "${can_as##*:}" "${can_ns#-}" "$can_what" "$can_got" "$expect"
  [ "$can_got" = "$expect" ] || CAN_FAIL=1
}

section() {
  echo ""
  echo "== $1"
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
kubectl get namespace agents >/dev/null 2>&1 ||
  fail "cluster unreachable or namespace 'agents' missing"
for sa in "hermes agents" "panel agents" "dispatcher sandbox"; do
  sa_name=${sa% *}
  sa_ns=${sa#* }
  kubectl get serviceaccount "$sa_name" -n "$sa_ns" >/dev/null 2>&1 ||
    fail "ServiceAccount ${sa_name}/${sa_ns} missing (apply the matching deploy/*/base)"
done

section "hermes (read-only: self-visibility + cluster health, no write path)"
check "$AS_HERMES" agents get pods yes
check "$AS_HERMES" agents get pods/log yes
check "$AS_HERMES" agents get services yes
check "$AS_HERMES" agents get statefulsets.apps yes
check "$AS_HERMES" agents get jobs.batch yes
check "$AS_HERMES" agents get cronjobs.batch yes
check "$AS_HERMES" agents get configmaps yes
check "$AS_HERMES" agents create jobs.batch no
check "$AS_HERMES" agents create cronjobs.batch no
check "$AS_HERMES" agents patch cronjobs.batch no
check "$AS_HERMES" agents delete cronjobs.batch no
check "$AS_HERMES" agents get secrets no
check "$AS_HERMES" agents list secrets no
check "$AS_HERMES" sandbox create jobs.batch no
check "$AS_HERMES" sandbox get pods no
check "$AS_HERMES" - get nodes yes
check "$AS_HERMES" - list nodes yes
check "$AS_HERMES" - create nodes no

section "panel (sandbox run surface)"
check "$AS_PANEL" sandbox create jobs.batch yes
check "$AS_PANEL" sandbox list jobs.batch yes
check "$AS_PANEL" sandbox delete jobs.batch yes
check "$AS_PANEL" sandbox get jobs.batch no
check "$AS_PANEL" sandbox patch jobs.batch no
check "$AS_PANEL" sandbox get cronjobs.batch yes
check "$AS_PANEL" sandbox list cronjobs.batch yes
check "$AS_PANEL" sandbox patch cronjobs.batch yes
check "$AS_PANEL" sandbox create cronjobs.batch no
check "$AS_PANEL" sandbox delete cronjobs.batch no
check "$AS_PANEL" sandbox get pods no
check "$AS_PANEL" sandbox get pods/log no
check "$AS_PANEL" sandbox get secrets no
section "panel (agents: dev tools health Service reads)"
check "$AS_PANEL" agents get services yes
check "$AS_PANEL" agents list services no
check "$AS_PANEL" agents get secrets no
section "panel (cluster view: node + pod lists)"
check "$AS_PANEL" - list nodes yes
check "$AS_PANEL" - list pods yes
check "$AS_PANEL" - get nodes no
check "$AS_PANEL" - create nodes no

section "dispatcher (watcher flow: Job get + create in sandbox, nothing else)"
check "$AS_DISPATCHER" sandbox get jobs.batch yes
check "$AS_DISPATCHER" sandbox create jobs.batch yes
check "$AS_DISPATCHER" sandbox list jobs.batch no
check "$AS_DISPATCHER" sandbox patch jobs.batch no
check "$AS_DISPATCHER" sandbox delete jobs.batch no
check "$AS_DISPATCHER" sandbox get cronjobs.batch no
check "$AS_DISPATCHER" sandbox patch cronjobs.batch no
check "$AS_DISPATCHER" sandbox delete cronjobs.batch no
check "$AS_DISPATCHER" sandbox get pods no
check "$AS_DISPATCHER" sandbox get pods/log no
check "$AS_DISPATCHER" sandbox create secrets no
check "$AS_DISPATCHER" sandbox list secrets no
check "$AS_DISPATCHER" agents get pods no

echo ""
if [ "$CAN_FAIL" -eq 0 ]; then
  echo "PASS: RBAC matches the purpose-scoped grants for hermes, panel, dispatcher (issue #26)"
else
  fail "RBAC drift detected (see probes above)"
fi
