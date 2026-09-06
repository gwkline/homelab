#!/bin/sh
# shellcheck shell=sh
#
# Disposable-cluster proof for the pinned CloudNativePG operator (issue #49):
#
#   1. install the operator exactly as production does (idempotent kustomize
#      apply --server-side -k deploy/cnpg/base — no Flux, no Helm),
#   2. create a minimal one-instance PostgreSQL Cluster,
#   3. connect with psql over TCP+SCRAM and run a real query,
#   4. delete the Cluster and verify the cleanup behavior: pods and PVCs are
#      garbage-collected with the Cluster object, the namespace deletes, and
#      the operator stays healthy.
#
# Safe to re-run: the smoke namespace is recreated from scratch each run and
# the operator apply is a no-op when already installed.
#
# Requires: kubectl pointed at a DISPOSABLE cluster (a fresh k3s box, a kind
# cluster, or any scratch cluster) and openssl. The Cluster is deleted on
# exit; never point this at the production database namespace. See
# deploy/cnpg/README.md for install, sizing and upgrade docs.
set -eu

NS=cnpg-smoke
CLUSTER=pg-smoke
ROLE=smoke_owner
SECRET=pg-smoke-owner
POD="$CLUSTER-1"
CLUSTER_TIMEOUT=600s

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'usage: %s (no arguments — installs the operator, smokes one temp Cluster, cleans up)\n' "$0" >&2
  exit 2
}

# Poll until `kubectl get $kind $name -n $NS` stops succeeding.
wait_gone() {
  _kind=$1
  _name=$2
  i=0
  while [ "$i" -lt 60 ]; do
    if ! kubectl get "$_kind" "$_name" -n "$NS" >/dev/null 2>&1; then
      printf 'PASS: %s/%s deleted cleanly\n' "$_kind" "$_name"
      return 0
    fi
    i=$((i + 1))
    sleep 5
  done
  fail "$_kind/$_name still present 300s after Cluster deletion"
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
command -v openssl >/dev/null 2>&1 || fail "openssl not found"
kubectl get nodes >/dev/null 2>&1 ||
  fail "cluster unreachable — point KUBECONFIG at a disposable cluster"
[ "$#" -eq 0 ] || usage

# ---------------------------------------------------------------------------
printf '==> 1. install the pinned operator (issue #49, idempotent)\n'
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io \
  --timeout=120s || fail "clusters.postgresql.cnpg.io CRD never Established"
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager \
  --timeout=300s || fail "cnpg-controller-manager never became Ready"
ENDPOINTS="$(kubectl -n cnpg-system get endpointslices \
  -l kubernetes.io/service-name=cnpg-metrics \
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}' 2>/dev/null || true)"
[ -n "$ENDPOINTS" ] &&
  printf 'PASS: cnpg-metrics scrape endpoint at %s:8080\n' "$ENDPOINTS" ||
  fail "cnpg-metrics Service has no ready endpoints (operator metrics not discoverable)"

# ---------------------------------------------------------------------------
printf '==> 2. create the minimal one-instance Cluster\n'
kubectl delete ns "$NS" --ignore-not-found --wait=true
kubectl create ns "$NS"
kubectl label ns "$NS" \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest
kubectl -n "$NS" create secret generic "$SECRET" \
  --type=kubernetes.io/basic-auth \
  --from-literal=username="$ROLE" \
  --from-literal=password="$(openssl rand -base64 24)"
# No imageName: the Cluster uses the operator release's compiled-in default
# operand, so the pinned operator pin is also what pins this image.
kubectl -n "$NS" apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $CLUSTER
spec:
  instances: 1
  enableSuperuserAccess: false
  storage:
    size: 1Gi
  managed:
    roles:
      - name: $ROLE
        login: true
        passwordSecret:
          name: $SECRET
EOF
kubectl -n "$NS" wait --for=condition=Ready "cluster/$CLUSTER" \
  --timeout="$CLUSTER_TIMEOUT" ||
  fail "$CLUSTER never reached Ready (webhook blocked? check deploy/cnpg/base/netpol.yaml)"

# ---------------------------------------------------------------------------
printf '==> 3. connect with psql over TCP+SCRAM\n'
PASSWORD="$(kubectl -n "$NS" get secret "$SECRET" \
  -o jsonpath='{.data.password}' | base64 -d)"
[ -n "$PASSWORD" ] || fail "secret $SECRET has no password key"
VERSION="$(kubectl exec -n "$NS" "$POD" -- \
  env PGPASSWORD="$PASSWORD" psql -X -tA -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U "$ROLE" -d postgres \
  -c 'SELECT version();')" ||
  fail "psql connection to $POD failed"
case "$VERSION" in
  *PostgreSQL*) printf 'PASS: psql connected — %s\n' "$VERSION" ;;
  *) fail "unexpected psql output: $VERSION" ;;
esac

# ---------------------------------------------------------------------------
printf '==> 4. delete the Cluster and verify cleanup behavior\n'
kubectl -n "$NS" delete cluster "$CLUSTER" --wait=true --timeout=300s ||
  fail "Cluster $CLUSTER deletion timed out"
wait_gone pod "$POD"
wait_gone pvc "$POD" # storageResourceClaim PVCs are owned by the Cluster
leftover="$(kubectl get pods,pvc -n "$NS" -o name || true)"
[ -z "$leftover" ] || fail "leftover resources after Cluster deletion: $leftover"
kubectl delete ns "$NS" --wait=true
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager \
  --timeout=120s || fail "operator unhealthy after smoke cleanup"
printf 'ALL CNPG SMOKE CHECKS PASSED\n'
