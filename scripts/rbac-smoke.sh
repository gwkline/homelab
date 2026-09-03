#!/bin/sh
# RBAC smoke for the purpose-per-principal identity split (issue #26).
#
# Every principal that talks to the Kubernetes API owns a purpose-specific
# Role derived from the calls its code actually makes:
#   panel      deploy/panel/base/rbac.yaml + cluster-viewer.yaml
#              (apps/panel/server/k8s.ts is the exhaustive call list)
#   dispatcher deploy/dispatcher/base/rbac.yaml (watcher verbs only; probed
#              live by scripts/dispatch-flow-smoke.sh, which stays the
#              behavioral smoke for that identity)
#   hermes     deploy/hermes/base/rbac.yaml — read-only; factory writes go
#              through the Executor gateway, so no CronJob mutation either
#
# This script runs the positive AND negative `kubectl auth can-i` table for
# the panel and hermes identities. Impersonation needs cluster-admin.
# Read-only: no cluster objects are created or changed.
#
# Usage:
#   ./scripts/rbac-smoke.sh
set -eu

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
kubectl get namespace agents >/dev/null 2>&1 ||
  fail "cluster unreachable or namespace 'agents' missing"

AS_PANEL="system:serviceaccount:agents:panel"
AS_HERMES="system:serviceaccount:agents:hermes"
CAN_FAIL=0

# can <verb> <resource> <yes|no> [namespace] — one impersonated probe against
# the identity currently set in AS. Without a namespace argument the probe
# checks cluster-scoped permissions. Mismatches mark the run failed.
can() {
  verb=$1
  res=$2
  want=$3
  ns=${4:-}
  if [ -n "$ns" ]; then
    got="$(kubectl auth can-i "$verb" "$res" -n "$ns" --as="$AS" 2>&1 || true)"
    printf '  can-i %-6s %-18s -n %-7s -> %s (expect %s)\n' \
      "$verb" "$res" "$ns" "$got" "$want"
  else
    got="$(kubectl auth can-i "$verb" "$res" --as="$AS" 2>&1 || true)"
    printf '  can-i %-6s %-18s %-11s -> %s (expect %s)\n' \
      "$verb" "$res" "(cluster)" "$got" "$want"
  fi
  [ "$got" = "$want" ] || CAN_FAIL=1
}

echo "==> panel RBAC (identity: ${AS_PANEL})"
echo "    sandbox: the Job lifecycle the panel UI drives + CronJob schedule edits"
AS="$AS_PANEL"
can create jobs.batch yes sandbox
can delete jobs.batch yes sandbox
can list jobs.batch yes sandbox
can get jobs.batch no sandbox
can patch jobs.batch no sandbox
can get cronjobs.batch yes sandbox
can list cronjobs.batch yes sandbox
can patch cronjobs.batch yes sandbox
can create cronjobs.batch no sandbox
can delete cronjobs.batch no sandbox
can get pods no sandbox
can get pods/log no sandbox
can create secrets no sandbox
echo "    agents: dev tools health reads (single-Service gets only)"
can get services yes agents
can list services no agents
can get secrets no agents
echo "    cluster: cluster card reads (pods + nodes, list only)"
can list pods yes
can get pods no
can watch pods no
can list nodes yes
can get nodes no
can watch nodes no
can list secrets no

echo "==> hermes RBAC (identity: ${AS_HERMES})"
echo "    agents: read-only self-visibility"
AS="$AS_HERMES"
can get pods yes agents
can get pods/log yes agents
can list cronjobs.batch yes agents
can get configmaps yes agents
can get statefulsets.apps yes agents
can get secrets no agents
can create jobs.batch no agents
can patch cronjobs.batch no agents
can delete cronjobs.batch no agents
echo "    sandbox: no factory access at all (writes go through Executor)"
can get jobs.batch no sandbox
can create jobs.batch no sandbox
can get pods no sandbox
echo "    cluster: health reads only"
can get nodes yes
can list nodes yes
can delete nodes no
can list secrets no

if [ "$CAN_FAIL" -eq 0 ]; then
  echo "PASS: panel + hermes RBAC matches the purpose-specific roles (issue #26)"
  echo "  - panel: sandbox Job create/delete/list + CronJob get/list/patch, agents Service gets, cluster pods/nodes list"
  echo "  - hermes: read-only self-visibility + cluster health; no write verb anywhere"
else
  fail "RBAC drift — compare the probes above with deploy/panel/base and deploy/hermes/base/rbac.yaml"
fi
