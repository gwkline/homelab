#!/bin/sh
# End-to-end proof of the panel's list-and-launch behavior through the real
# Kubernetes API (issue #27).
#
# The panel is deployed exactly like production: a pod running as the
# ServiceAccount `panel` (namespace agents, mirroring deploy/panel/base),
# bound to the loop-manager Role in sandbox (the same verbs deploy/hermes/
# base/rbac.yaml grants), with the ServiceAccount token mount supplying the
# cluster CA — so the server's in-cluster loadConfig() path, TLS trust, and
# RBAC are all exercised for real. Into a disposable kind cluster (or any
# cluster you already point kubectl at):
#
#   1. seeded sandbox fixtures (a CronJob and a completed Job) are created
#   2. GET /api/state must return them (through the real API, not a mock)
#   3. POST /api/jobs must create a sandbox Job with the requested command
#      and the locked-down container fields
#   4. the created Job must reach a terminal state; its pod runs the command
#   5. invalid command/issue inputs must stay rejected with 400
#
# RBAC is probed with `kubectl auth can-i` as the panel identity before the
# panel starts, and upstream error bodies are printed by the driver, so TLS
# trust or RBAC breakage fails loudly with diagnostics instead of silently.
#
# Usage:
#   ./scripts/panel-e2e-smoke.sh
#   PANEL_E2E_KEEP=1  ./scripts/panel-e2e-smoke.sh   # keep fixtures + cluster
#   PANEL_E2E_REUSE=1 ./scripts/panel-e2e-smoke.sh   # use current kubectl context
#       (k3d/k3s: build the images, make them pullable on the node, then reuse;
#        see docs/panel-e2e.md)
#   PANEL_E2E_TIMEOUT=900                            # whole-run budget, seconds
#   PANEL_E2E_JOB_WAIT=300                           # created-Job terminal wait
set -eu

NS_SANDBOX=sandbox
NS_AGENTS=agents
PANEL_POD=panel-e2e
SEED_JOB=panel-e2e-seed
SEED_CRONJOB=loop-example
PF_PORT="${PANEL_E2E_PORT:-3933}"
PANEL_IMG="${PANEL_E2E_PANEL_IMAGE:-panel-e2e:local}"
RUNNER_IMG="${PANEL_E2E_RUNNER_IMAGE:-panel-e2e-runner:local}"
RUNNER_DOCKERFILE=apps/panel/tests/integration/runner.Dockerfile
RUNNER_DIR=apps/panel/tests/integration
WAIT="${PANEL_E2E_TIMEOUT:-600}"
JOB_WAIT="${PANEL_E2E_JOB_WAIT:-300}"
AS_PANEL="system:serviceaccount:${NS_AGENTS}:panel"

cd "$(dirname "$0")/.."

KIND_CLUSTER=panel-e2e
KIND_CREATED=""
PF_PID=""
CREATED_FILE="$(mktemp "${TMPDIR:-/tmp}/panel-e2e-created.XXXXXX")"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# can <verb> <resource> <expected yes|no> — one impersonated RBAC probe.
can() {
  can_got="$(kubectl auth can-i "$1" "$2" -n "$NS_SANDBOX" --as="$AS_PANEL" 2>&1 || true)"
  printf '  can-i %-8s %-13s -> %s (expect %s)\n' "$1" "$2" "$can_got" "$3"
  [ "$can_got" = "$3" ] || CAN_FAIL=1
}

rbac_checks() {
  CAN_FAIL=0
  can list jobs yes
  can create jobs yes
  can delete jobs yes
  can list cronjobs yes
  can create secrets no
  can list secrets no
  [ "$CAN_FAIL" -eq 0 ]
}

# On failure: panel pod state/logs, RBAC probes, and the created Job's
# events — everything needed without re-running the flow.
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
    kubectl delete job "$SEED_JOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete cronjob "$SEED_CRONJOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    if [ -s "$CREATED_FILE" ]; then
      created_name="$(cat "$CREATED_FILE")"
      kubectl delete job "$created_name" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$CREATED_FILE"
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

echo "==> [2/7] building images (panel backend + job runner stand-in)"
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
# Mirror of deploy/panel/base/rbac.yaml (ServiceAccount + RoleBinding) plus the
# loop-manager Role it binds (defined in deploy/hermes/base/rbac.yaml).
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
  name: loop-manager
  namespace: ${NS_SANDBOX}
rules:
  - apiGroups: ["batch"]
    resources: ["jobs", "cronjobs"]
    verbs: ["create", "get", "list", "watch", "patch", "delete"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: panel-loop-manager
  namespace: ${NS_SANDBOX}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: loop-manager
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
        - name: PANEL_LOOP_IMAGE
          value: ${RUNNER_IMG}
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

PANEL_E2E_URL="http://127.0.0.1:${PF_PORT}" \
PANEL_E2E_NS="$NS_SANDBOX" \
PANEL_E2E_SEED_JOB="$SEED_JOB" \
PANEL_E2E_CRONJOB="$SEED_CRONJOB" \
PANEL_E2E_JOB_WAIT="$JOB_WAIT" \
PANEL_E2E_CREATED_FILE="$CREATED_FILE" \
  node --test apps/panel/tests/integration/panel-e2e.test.mjs

echo "==> [7/7] preserved cluster state: API-visible sandbox + the created Job"
kubectl get jobs,cronjobs -n "$NS_SANDBOX" -o wide
created_name="$(cat "$CREATED_FILE")"
kubectl describe job "$created_name" -n "$NS_SANDBOX" | sed -n '1,/[[:space:]]*Events:/p'
echo "  pod logs (the launched command ran):"
kubectl logs -n "$NS_SANDBOX" "job/${created_name}" --tail=-1 || true

if [ "${PANEL_E2E_KEEP:-0}" = "1" ]; then
  echo "  PANEL_E2E_KEEP=1 — kept fixtures and the created Job for inspection"
fi

echo "PASS: panel list-and-launch proven end to end through the real Kubernetes API (issue #27)"
echo "  - panel pod ran as ServiceAccount panel with the mounted cluster CA (in-cluster loadConfig path)"
echo "  - GET /api/state returned seeded Job ${SEED_JOB} + CronJob ${SEED_CRONJOB}; RBAC probes matched deploy/panel/base"
echo "  - POST /api/jobs created Job ${created_name} (locked-down container), which ran to Complete"
echo "  - invalid command/issue inputs stayed rejected with 400"
