#!/bin/sh
# Panel e2e against a real Kubernetes API (docs/panel-e2e.md). Runs the panel
# as its production ServiceAccount and RBAC in a disposable kind cluster (or
# the current context), then drives /api/state, /api/cronjobs and /api/jobs
# through a port-forward.
#
# Usage:
#   ./scripts/panel-e2e-smoke.sh
#   PANEL_E2E_KEEP=1  ./scripts/panel-e2e-smoke.sh   # keep fixtures + cluster
#   PANEL_E2E_REUSE=1 ./scripts/panel-e2e-smoke.sh   # use current kubectl context
set -eu

NS_SANDBOX=sandbox
NS_AGENTS=agents
PANEL_POD=panel-e2e
SEED_JOB=panel-e2e-seed
# E2e-only fixture names: they must never collide with production objects in
# a reused cluster (the cleanup below deletes the seed fixtures).
SEED_CRONJOB=panel-e2e-seed-cronjob
PF_PORT="${PANEL_E2E_PORT:-3933}"
PANEL_IMG="${PANEL_E2E_PANEL_IMAGE:-panel-e2e:local}"
RUNNER_IMG="${PANEL_E2E_RUNNER_IMAGE:-panel-e2e-runner:local}"
RUNNER_DOCKERFILE=apps/panel/tests/integration/runner.Dockerfile
RUNNER_DIR=apps/panel/tests/integration
WAIT="${PANEL_E2E_TIMEOUT:-600}"
AS_PANEL="system:serviceaccount:${NS_AGENTS}:panel"

cd "$(dirname "$0")/.."

KIND_CLUSTER=panel-e2e
KIND_CREATED=""
PF_PID=""

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# can <verb> <resource> <expected yes|no> [namespace] — one impersonated RBAC
# probe against the production grants in deploy/panel/base/rbac.yaml.
can() {
  can_ns="${4:-$NS_SANDBOX}"
  can_got="$(kubectl auth can-i "$1" "$2" -n "$can_ns" --as="$AS_PANEL" 2>&1 || true)"
  printf '  can-i %-8s %-13s (%s) -> %s (expect %s)\n' "$1" "$2" "$can_ns" "$can_got" "$3"
  [ "$can_got" = "$3" ] || CAN_FAIL=1
}

# Parity with deploy/panel/base/rbac.yaml: everything the production Role
# grants must be granted here, and the deliberate denials (no CronJob
# create/delete, no Job watch, no pod/log reads, no secrets anywhere)
# must stay denied.
rbac_checks() {
  CAN_FAIL=0
  can create jobs yes
  can list jobs yes
  can delete jobs yes
  can watch jobs no
  can get cronjobs yes
  can list cronjobs yes
  can patch cronjobs yes
  can create cronjobs no
  can list secrets no
  can get services yes "$NS_AGENTS"
  can get ingresses.networking.k8s.io/panel yes "$NS_AGENTS"
  can list ingresses.networking.k8s.io no "$NS_AGENTS"
  [ "$CAN_FAIL" -eq 0 ]
}

# On failure: panel pod state/logs, RBAC probes, and sandbox events —
# everything needed without re-running the flow.
dump_diagnostics() {
  echo "----- panel pod (agents/panel-e2e) -----" >&2
  kubectl describe pod "$PANEL_POD" -n "$NS_AGENTS" >&2 || true
  kubectl logs "$PANEL_POD" -n "$NS_AGENTS" --tail=-1 >&2 || true
  echo "----- RBAC as ${AS_PANEL} -----" >&2
  rbac_checks >&2 || true
  echo "----- sandbox jobs + events -----" >&2
  kubectl get jobs -n "$NS_SANDBOX" -o wide >&2 || true
  kubectl get events -n "$NS_SANDBOX" --sort-by=.lastTimestamp 2>/dev/null | tail -n 20 >&2 || true
}

cleanup() {
  rc=$?
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null || true
  fi
  if [ "$rc" -ne 0 ]; then
    dump_diagnostics
  fi
  if [ "${PANEL_E2E_KEEP:-0}" = "1" ]; then
    echo "==> PANEL_E2E_KEEP=1 — kept fixtures in ${NS_SANDBOX} and the cluster"
  else
    # Delete only what this run created: the panel pod (the kind cluster
    # teardown below removes it wholesale, but PANEL_E2E_REUSE=1 against a
    # real cluster must not leave the stand-in pod behind) and the seeded
    # fixtures — nothing cluster-wide.
    kubectl delete pod "$PANEL_POD" -n "$NS_AGENTS" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete job "$SEED_JOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete cronjob "$SEED_CRONJOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
  fi
  if [ -n "$KIND_CREATED" ]; then
    echo "==> deleting disposable kind cluster ${KIND_CLUSTER}"
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1 || true
    if [ -n "${KUBECONFIG:-}" ]; then
      rm -f "$KUBECONFIG"
    fi
  fi
}
trap cleanup EXIT INT TERM

echo "==> [1/7] preconditions"
command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
command -v node >/dev/null 2>&1 || fail "node not found (drives the e2e suite)"
command -v curl >/dev/null 2>&1 || fail "curl not found"
[ -f "$RUNNER_DOCKERFILE" ] || fail "$RUNNER_DOCKERFILE missing"

if [ "${PANEL_E2E_REUSE:-0}" = "1" ]; then
  kubectl get namespace kube-system >/dev/null 2>&1 ||
    fail "PANEL_E2E_REUSE=1 but kubectl cannot reach a cluster"
  echo "  reusing current kubectl context"
else
  command -v docker >/dev/null 2>&1 || fail "docker not found (or set PANEL_E2E_REUSE=1)"
  command -v kind >/dev/null 2>&1 || fail "kind not found (or set PANEL_E2E_REUSE=1)"
fi

echo "==> [2/7] building images (panel backend + fixture runner)"
if [ "${PANEL_E2E_REUSE:-0}" != "1" ]; then
  docker build -f apps/panel/Dockerfile -t "$PANEL_IMG" . ||
    fail "panel image build failed"
  docker build -f "$RUNNER_DOCKERFILE" -t "$RUNNER_IMG" "$RUNNER_DIR" ||
    fail "runner image build failed"
else
  echo "  PANEL_E2E_REUSE=1: skipping builds, expecting pullable images"
  echo "  panel=$PANEL_IMG runner=$RUNNER_IMG"
fi

echo "==> [3/7] disposable cluster (kind/${KIND_CLUSTER})"
if [ "${PANEL_E2E_REUSE:-0}" != "1" ]; then
  if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    echo "  reusing existing kind cluster ${KIND_CLUSTER}"
  else
    export KUBECONFIG="${TMPDIR:-/tmp}/panel-e2e-kubeconfig"
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1 || true
    kind create cluster --name "$KIND_CLUSTER" --wait 180s >/dev/null 2>&1 ||
      fail "kind create cluster failed"
    KIND_CREATED=1
  fi
  kind load docker-image "$PANEL_IMG" "$RUNNER_IMG" --name "$KIND_CLUSTER" ||
    fail "kind load docker-image failed"
else
  echo "  PANEL_E2E_REUSE=1: images must already be pullable in the cluster"
fi

echo "==> [4/7] namespaces, production-shaped RBAC, seeded sandbox fixtures"
kubectl create namespace "$NS_AGENTS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create namespace "$NS_SANDBOX" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# Exact mirror of deploy/panel/base/rbac.yaml: the panel
# ServiceAccount, the sandbox panel-sandbox-runs Role (create/list/delete
# Jobs, get/list/patch CronJobs), and the agents panel-agents-viewer Role
# (get Services, get the panel Ingress).
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: panel
  namespace: ${NS_AGENTS}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: panel-sandbox-runs
  namespace: ${NS_SANDBOX}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "list", "delete"]
  - apiGroups: ["batch"]
    resources: ["cronjobs"]
    verbs: ["get", "list", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: panel-sandbox-runs
  namespace: ${NS_SANDBOX}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: panel-sandbox-runs
subjects:
  - kind: ServiceAccount
    name: panel
    namespace: ${NS_AGENTS}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: panel-agents-viewer
  namespace: ${NS_AGENTS}
rules:
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    resourceNames: ["panel"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: panel-agents-viewer
  namespace: ${NS_AGENTS}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: panel-agents-viewer
subjects:
  - kind: ServiceAccount
    name: panel
    namespace: ${NS_AGENTS}
EOF

if rbac_checks; then
  echo "  ok: panel RBAC matches deploy/panel/base/rbac.yaml (secrets denied)"
else
  fail "panel RBAC probes failed (see output above)"
fi

# Stand-ins for the live sandbox state the panel reads in production: one
# CronJob (suspended, so it never fires) and one completed Job.
kubectl apply -f - >/dev/null <<EOF
apiVersion: batch/v1
kind: CronJob
metadata:
  labels:
    app: ${SEED_CRONJOB}
  name: ${SEED_CRONJOB}
  namespace: ${NS_SANDBOX}
spec:
  schedule: "0 9 * * *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          automountServiceAccountToken: false
          containers:
            - command: ["/bin/sh", "-c", "true"]
              image: ${RUNNER_IMG}
              name: noop
          restartPolicy: Never
---
apiVersion: batch/v1
kind: Job
metadata:
  labels:
    app: ${SEED_JOB}
  name: ${SEED_JOB}
  namespace: ${NS_SANDBOX}
spec:
  backoffLimit: 1
  template:
    spec:
      automountServiceAccountToken: false
      containers:
        - command: ["/bin/sh", "-c", "echo seeded"]
          image: ${RUNNER_IMG}
          name: seed
      restartPolicy: Never
EOF
kubectl wait --for=condition=complete "job/${SEED_JOB}" -n "$NS_SANDBOX" --timeout=180s >/dev/null ||
  fail "seed Job ${SEED_JOB} did not complete (is ${RUNNER_IMG} loaded in the cluster?)"
echo "  ok: seeded CronJob ${SEED_CRONJOB} + completed Job ${SEED_JOB}"

echo "==> [5/7] deploying panel with its real ServiceAccount + cluster CA"
kubectl delete pod "$PANEL_POD" -n "$NS_AGENTS" --ignore-not-found >/dev/null
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: ${PANEL_POD}
  name: ${PANEL_POD}
  namespace: ${NS_AGENTS}
spec:
  # The identity under test — identical to deploy/panel/base/deployment.yaml.
  serviceAccountName: panel
  automountServiceAccountToken: true
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
    - env:
        - name: PORT
          value: "3000"
      image: ${PANEL_IMG}
      name: panel
      ports:
        - containerPort: 3000
          name: http
      readinessProbe:
        httpGet:
          path: /
          port: http
        periodSeconds: 2
        failureThreshold: 30
      resources:
        requests:
          cpu: 50m
          memory: 128Mi
        limits:
          memory: 512Mi
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
EOF
pod_sa="$(kubectl get pod "$PANEL_POD" -n "$NS_AGENTS" -o jsonpath='{.spec.serviceAccountName}')"
[ "$pod_sa" = "panel" ] ||
  fail "panel pod runs as ServiceAccount '${pod_sa}' (want panel)"
kubectl wait --for=condition=ready "pod/${PANEL_POD}" -n "$NS_AGENTS" --timeout=300s >/dev/null ||
  fail "panel pod did not become ready"
echo "  ok: panel pod Ready as ServiceAccount panel (token + cluster CA mounted)"

echo "==> [6/7] driving the real HTTP API through a port-forward (max ${WAIT}s)"
kubectl port-forward "pod/${PANEL_POD}" "${PF_PORT}:3000" -n "$NS_AGENTS" >/dev/null 2>&1 &
PF_PID=$!
i=0
until curl -sf "http://127.0.0.1:${PF_PORT}/" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "panel did not answer on 127.0.0.1:${PF_PORT}"
  sleep 1
done

# The driver runs under the whole-run budget: a wedged port-forward or
# apiserver turns into a clean timeout (exit 124 -> set -e -> diagnostics)
# instead of a stuck CI job. Hosts without coreutils timeout run unbudgeted.
export PANEL_E2E_URL="http://127.0.0.1:${PF_PORT}"
export PANEL_E2E_NS="$NS_SANDBOX"
export PANEL_E2E_SEED_JOB="$SEED_JOB"
export PANEL_E2E_CRONJOB="$SEED_CRONJOB"
if command -v timeout >/dev/null 2>&1; then
  timeout "$WAIT" node --test apps/panel/tests/integration/panel-e2e.test.mjs
else
  node --test apps/panel/tests/integration/panel-e2e.test.mjs
fi

echo "==> [7/7] sandbox state after the run"
kubectl get jobs,cronjobs -n "$NS_SANDBOX" -o wide

echo "PASS: panel proven end to end through the real Kubernetes API"
echo "  - panel pod ran as ServiceAccount panel with the mounted cluster CA (in-cluster loadConfig path)"
echo "  - GET /api/state returned seeded Job ${SEED_JOB} + CronJob ${SEED_CRONJOB}; RBAC probes matched deploy/panel/base"
echo "  - PATCH /api/cronjobs and DELETE /api/jobs changed the live objects"
echo "  - POST /api/jobs is gone: 404, nothing created"
