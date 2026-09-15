#!/bin/sh
# shellcheck shell=sh
#
# Operator smoke test for the pinned CloudNativePG install (issue #49).
#
#   cnpg-smoke.sh up    install/verify the pinned operator, then create a
#                       minimal one-instance PostgreSQL Cluster in a
#                       throwaway namespace and connect with psql
#   cnpg-smoke.sh down  delete the Cluster, verify the operator's cleanup
#                       (pods/PVCs/Services gone with it), delete the
#                       namespace and re-verify the operator is healthy
#   cnpg-smoke.sh all   up then down — the full #49 verification
#
# Designed for a disposable cluster (issue #49 verification: "install on a
# disposable cluster"): it applies only deploy/cnpg/base (idempotent) and
# everything else lives in the throwaway cnpg-smoke namespace, so running it
# against the homelab cluster is also safe. Requires kubectl with a working
# KUBECONFIG; curl is optional (skips the live /metrics probe when absent).
set -eu

cd "$(dirname "$0")/.." || exit 1

NS=cnpg-smoke
CLUSTER=pg-smoke
POD="$CLUSTER-1"
TIMEOUT_POD=900s
TIMEOUT_CLEANUP=300s
# Same digest-pinned PostgreSQL 18 operand as deploy/postgres/base/
# cluster-image-catalog.yaml — the smoke proves the operator, not the
# extension payload (that is pg-smoke.sh's job, issue #52).
PG_IMAGE=ghcr.io/cloudnative-pg/postgresql:18.6-202608310817-minimal-trixie@sha256:5c389b0268d9e637ca55efa41a7fafa3996332b5ea3c6099d0861c5f31acb00e

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  if [ "$1" = "$2" ]; then
    printf 'PASS: %s\n' "$3"
  else
    printf 'FAIL: %s (got "%s", want "%s")\n' "$3" "$1" "$2" >&2
    exit 1
  fi
}

usage() {
  printf 'usage: %s up|down|all\n' "$0" >&2
  exit 2
}

# Idempotent operator install: one server-side apply carries CRDs, RBAC and
# the controller (deploy/cnpg/README.md). Re-running is the recovery path.
install_operator() {
  printf '==> applying deploy/cnpg/base (idempotent, server-side)\n'
  kubectl apply --server-side -k deploy/cnpg/base
  kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io \
    --timeout=180s
  kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager \
    --timeout="$TIMEOUT_POD"
}

# The running controller must be the digest pin from the kustomization —
# the whole point of #49 is that the operator's bytes are immutable.
check_pinned_image() {
  pin="$(awk '/digest:/ { print $2 }' deploy/cnpg/base/kustomization.yaml | head -n 1)"
  [ -n "$pin" ] || fail 'cannot read the operator digest pin from deploy/cnpg/base/kustomization.yaml'
  running="$(kubectl -n cnpg-system get deploy cnpg-controller-manager \
    -o jsonpath='{.spec.template.spec.containers[0].image}')"
  case "$running" in
    *"$pin")
      printf 'PASS: operator runs the pinned digest (%s)\n' "$pin"
      ;;
    *)
      fail "operator image $running does not end in the pinned digest $pin"
      ;;
  esac
}

# Metrics discoverability (ADR-003 stack scrapes via these standard
# annotations): the pod template must carry them and declare port 8080.
check_metrics_discoverable() {
  scrape="$(kubectl -n cnpg-system get deploy cnpg-controller-manager \
    -o jsonpath='{.spec.template.metadata.annotations.prometheus\.io/scrape}')"
  assert_eq "$scrape" "true" "operator pod annotated for metrics discovery (prometheus.io/scrape)"
  port="$(kubectl -n cnpg-system get deploy cnpg-controller-manager \
    -o jsonpath='{.spec.template.spec.containers[0].ports[?(@.name=="metrics")].containerPort}')"
  assert_eq "$port" "8080" "operator declares the metrics container port 8080"
}

# Optional live probe: the metrics endpoint really serves Prometheus text.
check_metrics_endpoint() {
  command -v curl >/dev/null 2>&1 || {
    printf 'SKIP: live /metrics probe (curl not installed)\n'
    return 0
  }
  kubectl -n cnpg-system port-forward deploy/cnpg-controller-manager 18080:8080 \
    >/dev/null 2>&1 &
  pf=$!
  i=0
  ok=0
  while [ "$i" -lt 10 ]; do
    if curl -sf --max-time 3 http://127.0.0.1:18080/metrics | grep -q '^cnpg_'; then
      ok=1
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  kill "$pf" 2>/dev/null || true
  wait "$pf" 2>/dev/null || true
  [ "$ok" -eq 1 ] || fail 'operator /metrics on 8080 did not serve cnpg_ metrics'
  printf 'PASS: operator /metrics serves cnpg_ metrics on port 8080\n'
}

# SQL runs as the operator-created app user over TCP+SCRAM inside the pod —
# same credential-workflow shape as scripts/pg-smoke.sh.
psql_exec() {
  kubectl exec -i -n "$NS" "$POD" -- env PGPASSWORD="$PASSWORD" \
    psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U app -d app "$@"
}

cmd_up() {
  command -v kubectl >/dev/null 2>&1 || fail 'kubectl not found'
  kubectl get nodes >/dev/null 2>&1 || fail 'cluster unreachable — point KUBECONFIG at a (disposable) cluster'

  install_operator
  check_pinned_image
  check_metrics_discoverable

  printf '==> creating namespace %s and minimal Cluster %s\n' "$NS" "$CLUSTER"
  kubectl apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $NS
  labels:
    # Same restricted posture as the database namespace (deploy/namespaces.yaml):
    # CNPG's default pod security context passes it (deploy/postgres/README.md).
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
EOF
  kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: $CLUSTER
  namespace: $NS
spec:
  instances: 1
  imageName: $PG_IMAGE
  enableSuperuserAccess: false
  storage:
    size: 1Gi
    storageClass: local-path
  resources:
    requests:
      cpu: 250m
      memory: 512Mi
    limits:
      # Memory ceiling only — no CPU limit (deploy/postgres/base/cluster.yaml).
      memory: 1Gi
EOF

  printf '==> waiting for %s to become Ready (first init pulls the operand)...\n' "$CLUSTER"
  kubectl wait -n "$NS" "cluster/$CLUSTER" --for=condition=Ready --timeout="$TIMEOUT_POD"
  phase="$(kubectl get cluster -n "$NS" "$CLUSTER" -o jsonpath='{.status.phase}')"
  assert_eq "$phase" "Cluster in healthy state" "cluster reports healthy phase"

  PASSWORD="$(kubectl get secret -n "$NS" "$CLUSTER-app" \
    -o jsonpath='{.data.password}' | base64 -d)"
  [ -n "$PASSWORD" ] || fail "secret $CLUSTER-app has no password key"

  psql_exec <<'SQL' >/dev/null
CREATE TABLE smoke (id int PRIMARY KEY, note text);
INSERT INTO smoke VALUES (1, 'cnpg operator smoke');
SQL
  got="$(psql_exec -At -c 'SELECT note FROM smoke WHERE id = 1;')"
  assert_eq "$got" "cnpg operator smoke" "psql round-trip through the operator-created cluster"
  version="$(psql_exec -At -c 'SHOW server_version;')"
  case "$version" in
    18*) printf 'PASS: PostgreSQL 18 operand serves the smoke table (%s)\n' "$version" ;;
    *) fail "expected a PostgreSQL 18 operand, got $version" ;;
  esac

  check_metrics_endpoint
  printf 'UP COMPLETE: delete with: %s down\n' "$0"
}

cmd_down() {
  kubectl get cluster -n "$NS" "$CLUSTER" >/dev/null 2>&1 ||
    fail "cluster $NS/$CLUSTER not found — run '$0 up' first"

  printf '==> deleting %s (the operator drains and removes its pods/PVCs)\n' "$CLUSTER"
  kubectl delete cluster -n "$NS" "$CLUSTER" --wait=true --timeout="$TIMEOUT_CLEANUP"

  left="$(kubectl get pods,pvc,svc -n "$NS" -o name 2>/dev/null || true)"
  [ -z "$left" ] || {
    printf '%s\n' "$left" >&2
    fail "leftover objects in $NS after the Cluster delete — cleanup was not clean"
  }
  printf 'PASS: operator removed every Cluster-owned pod/PVC/Service\n'

  kubectl delete namespace "$NS" --wait=true --timeout="$TIMEOUT_CLEANUP"
  if kubectl get namespace "$NS" >/dev/null 2>&1; then
    fail "namespace $NS still exists after delete"
  fi
  printf 'PASS: namespace %s deleted, nothing orphaned\n' "$NS"

  # The operator must come through the churn healthy (no crash loops).
  kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager \
    --timeout=120s
  printf 'ALL CNPG OPERATOR SMOKE CHECKS PASSED\n'
}

[ "$#" -eq 1 ] || usage
case "$1" in
  up) cmd_up ;;
  down) cmd_down ;;
  all) cmd_up && cmd_down ;;
  *) usage ;;
esac
