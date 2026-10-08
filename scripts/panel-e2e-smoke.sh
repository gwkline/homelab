#!/bin/sh
# Panel e2e against a real Kubernetes API (docs/panel-e2e.md). Runs the panel
# as its production ServiceAccount and RBAC in the kind cluster panel-e2e
# (created if missing), then drives /api/state, /api/cluster, /api/cronjobs
# and /api/jobs through a port-forward.
#
# kubectl only ever sees a private kubeconfig exported from kind, and nothing
# runs until its context is kind-panel-e2e: the caller's current context is
# never read or changed.
#
# Usage:
#   ./scripts/panel-e2e-smoke.sh
#   PANEL_E2E_KEEP=1 ./scripts/panel-e2e-smoke.sh   # keep fixtures + cluster
set -eu

NS_SANDBOX=sandbox
NS_AGENTS=agents
PANEL_POD=panel-e2e
AUTH_SECRET=panel-e2e-auth
SEED_JOB=panel-e2e-seed
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
KIND_CONTEXT="kind-${KIND_CLUSTER}"
KIND_CREATED=""
# Set once kubectl is proven to point at the kind cluster. Cleanup and
# diagnostics run no kubectl before that.
ON_KIND=""
PF_PID=""
# Empty until kind writes it, so a stray kubectl call fails rather than
# reaching whatever cluster the caller's kubeconfig points at.
KUBE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/panel-e2e-kube.XXXXXX")"
KUBECONFIG="${KUBE_DIR}/config"
export KUBECONFIG

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# can <verb> <resource> <expected yes|no> [namespace, or * for all] — one
# impersonated RBAC probe as the panel's ServiceAccount.
can() {
  can_ns="${4:-$NS_SANDBOX}"
  if [ "$can_ns" = "*" ]; then
    can_got="$(kubectl auth can-i "$1" "$2" --all-namespaces --as="$AS_PANEL" 2>&1 || true)"
  else
    can_got="$(kubectl auth can-i "$1" "$2" -n "$can_ns" --as="$AS_PANEL" 2>&1 || true)"
  fi
  printf '  can-i %-8s %-13s (%s) -> %s (expect %s)\n' "$1" "$2" "$can_ns" "$can_got" "$3"
  [ "$can_got" = "$3" ] || CAN_FAIL=1
}

# What the routes need from deploy/panel/base/rbac.yaml and
# cluster-reader.yaml is granted, and the deliberate denials (no CronJob
# create, no Job watch, no single-object node reads, no secrets) hold.
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
  can list nodes yes "*"
  can list pods yes "*"
  can get nodes no "*"
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
  if [ -n "$ON_KIND" ] && [ "$rc" -ne 0 ]; then
    dump_diagnostics
  fi
  if [ "${PANEL_E2E_KEEP:-0}" = "1" ]; then
    echo "==> PANEL_E2E_KEEP=1 — kept fixtures and kind cluster ${KIND_CLUSTER}"
    echo "    KUBECONFIG=${KUBECONFIG} kubectl get pods -A"
    return
  fi
  if [ -n "$ON_KIND" ]; then
    # In a cluster this run found running, delete only what it created.
    kubectl delete pod "$PANEL_POD" -n "$NS_AGENTS" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete secret "$AUTH_SECRET" -n "$NS_AGENTS" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete job "$SEED_JOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete cronjob "$SEED_CRONJOB" -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
  fi
  if [ -n "$KIND_CREATED" ]; then
    echo "==> deleting kind cluster ${KIND_CLUSTER}"
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1 || true
  fi
  rm -rf "$KUBE_DIR"
}
trap cleanup EXIT INT TERM

echo "==> [1/7] preconditions"
for tool in docker kind kubectl node curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool not found"
done
[ -f "$RUNNER_DOCKERFILE" ] || fail "$RUNNER_DOCKERFILE missing"

echo "==> [2/7] building images (panel backend + fixture runner)"
docker build -f apps/panel/Dockerfile -t "$PANEL_IMG" . ||
  fail "panel image build failed"
docker build -f "$RUNNER_DOCKERFILE" -t "$RUNNER_IMG" "$RUNNER_DIR" ||
  fail "runner image build failed"

echo "==> [3/7] kind cluster ${KIND_CLUSTER}"
if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "  reusing existing kind cluster ${KIND_CLUSTER}"
else
  kind create cluster --name "$KIND_CLUSTER" --wait 180s >/dev/null 2>&1 ||
    fail "kind create cluster failed"
  KIND_CREATED=1
fi
kind export kubeconfig --name "$KIND_CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 ||
  fail "kind export kubeconfig failed"
context="$(kubectl config current-context 2>/dev/null || true)"
[ "$context" = "$KIND_CONTEXT" ] ||
  fail "kubectl context is '${context}', not ${KIND_CONTEXT}; refusing to run"
ON_KIND=1
echo "  ok: kubectl pinned to ${KIND_CONTEXT} (${KUBECONFIG})"
kind load docker-image "$PANEL_IMG" "$RUNNER_IMG" --name "$KIND_CLUSTER" ||
  fail "kind load docker-image failed"

echo "==> [4/7] namespaces, the panel's RBAC from deploy/panel/base, seeded sandbox fixtures"
kubectl create namespace "$NS_AGENTS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl create namespace "$NS_SANDBOX" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# The shipped manifests, so the probes below test what production runs.
kubectl apply -f deploy/panel/base/rbac.yaml -f deploy/panel/base/cluster-reader.yaml >/dev/null

if rbac_checks; then
  echo "  ok: panel RBAC from deploy/panel/base grants what the routes need (secrets denied)"
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
# A one-run machine caller, shaped like Secret panel-auth.
PANEL_E2E_TOKEN="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
kubectl create secret generic "$AUTH_SECRET" -n "$NS_AGENTS" \
  --from-literal=tokens="e2e=${PANEL_E2E_TOKEN}" --from-literal=users= \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
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
        - name: PANEL_AUTH_DIR
          value: /secrets-panel-auth
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
      volumeMounts:
        - name: panel-auth
          mountPath: /secrets-panel-auth
          readOnly: true
  volumes:
    - name: panel-auth
      secret:
        secretName: ${AUTH_SECRET}
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
export PANEL_E2E_TOKEN
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
echo "  - GET /api/cluster listed nodes and pods cluster-wide"
echo "  - PATCH /api/cronjobs and DELETE /api/jobs changed the live objects with a bearer token, and refused without one"
echo "  - POST /api/jobs is gone: 404, nothing created"
