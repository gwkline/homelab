#!/bin/sh
# shellcheck shell=sh
#
# Panel end-to-end test against a real Kubernetes API (issue #27).
#
# Proves, through the panel's real identity — the agents/panel ServiceAccount,
# the projected cluster CA, and the sandbox RoleBindings — that a deployed
# panel can:
#   1. GET  /api/state  -> list seeded Jobs and CronJobs
#   2. POST /api/jobs   -> create a Job carrying the expected command and the
#                          locked-down container fields from server/jobs.ts
#   3. reach the created Job's terminal state (Complete) in the cluster
#   4. keep rejecting invalid command / issue inputs (400)
#
# TLS and RBAC failures abort with targeted diagnostics: the pod runs the
# in-cluster config path (real CA, rejectUnauthorized on — PANEL_K8S_BASE is
# asserted absent so the test cannot silently downgrade to plaintext), and a
# SubjectAccessReview preflight proves the ServiceAccount's verbs before the
# round-trip.
#
# Usage:
#   ./scripts/panel-e2e-k8s.sh --kind     # disposable kind cluster, self-contained
#   ./scripts/panel-e2e-k8s.sh            # against the current kubectl context
#
# Requirements: kubectl, curl, node; --kind additionally needs docker + kind.
# The current context must point at a DISPOSABLE cluster (kind/k3d/k3s): the
# run creates the real panel RBAC, a panel-e2e Deployment, a placeholder
# github-token Secret when none exists, and seeded Jobs/CronJobs — all deleted
# again on success.
#
# Knobs (env):
#   PANEL_E2E_PANEL_IMAGE   panel image (default: built from apps/panel/Dockerfile)
#   PANEL_E2E_LOOP_IMAGE    image for the launched Job (default: the published
#                           loop-agent; --kind builds a LOOP_COMMAND-compatible
#                           shim instead so no multi-GB pull is needed)
#   PANEL_E2E_PORT          local port-forward port (default 3987)
#   PANEL_E2E_JOB_TIMEOUT   seconds to wait for the Job terminal state (240)
#   PANEL_E2E_CLUSTER       kind cluster name (panel-e2e)
#   PANEL_E2E_ASSUME_DISPOSABLE=1   skip the non-kind safety prompt
#
# Reusable by #16 (API-level manifest validation): the SubjectAccessReview
# preflight and the copy-the-real-RBAC-then-round-trip flow are the pattern.
# See docs/panel-e2e.md for the full walkthrough.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

KIND_MODE=0
KEEP_CLUSTER=0
CLUSTER="${PANEL_E2E_CLUSTER:-panel-e2e}"
PANEL_IMAGE="${PANEL_E2E_PANEL_IMAGE:-}"
LOOP_IMAGE="${PANEL_E2E_LOOP_IMAGE:-ghcr.io/gwkline/homelab/loop-agent:latest}"
API_PORT="${PANEL_E2E_PORT:-3987}"
JOB_WAIT="${PANEL_E2E_JOB_TIMEOUT:-240}"
DEPLOY_NAME="panel-e2e"
SEED_JOB="panel-e2e-seed"
SEED_CRON="panel-e2e-cron"
SEED_SCHEDULE="30 5 * * *"
ISSUE="27"
REPO="gwkline/homelab"

TMP=""
KCFG=""
PF_PID=""
CODE=0
CREATED_SECRET=0
CLEANED=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'PASS: %s\n' "$1"
}

note() {
  printf '==> %s\n' "$1"
}

usage() {
  cat <<'USAGE'
usage: scripts/panel-e2e-k8s.sh [--kind] [--keep]

  --kind   create a disposable kind cluster for the run (docker + kind required)
  --keep   with --kind: keep the cluster after the run for debugging

Requires kubectl, curl, node (plus docker for the image build). See
docs/panel-e2e.md for env knobs and what the test proves.
USAGE
}

require() {
  # $1 binary, $2 install hint
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "missing dependency: $1 ($2)"
  fi
}

cleanup() {
  if [ "$CLEANED" -eq 1 ]; then
    return 0
  fi
  CLEANED=1
  if [ -n "$PF_PID" ]; then
    kill "$PF_PID" 2>/dev/null || :
    wait "$PF_PID" 2>/dev/null || :
  fi
  if [ "$KIND_MODE" -eq 1 ] && [ "$KEEP_CLUSTER" -eq 0 ] && [ -n "$KCFG" ]; then
    kind delete cluster --name "$CLUSTER" --kubeconfig "$KCFG" >/dev/null 2>&1 || :
  fi
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}

# Map a panel error message (the k8s upstream error is surfaced verbatim by
# the API routes) to a diagnostic class: tls, rbac, or other.
classify_api_error() {
  # $1 error message
  case "$1" in
    *certificate*|*CERTIFICATE*|*x509*|*X509*|*self-signed*|*CERT*|*TLS*|*SSL*)
      printf 'tls'
      ;;
    *Forbidden*|*forbidden*|*cannot\ list*|*cannot\ get*|*cannot\ create*|*Unauthorized*|*unauthorized*|*RBAC*|*rbac*|*403*|*401*)
      printf 'rbac'
      ;;
    *)
      printf 'other'
      ;;
  esac
}

# Extract the {error} message the panel API wrote into $BODY.
error_of() {
  node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(typeof j.error === "string" ? j.error : JSON.stringify(j));
' < "$BODY"
}

# Fail with a TLS-vs-RBAC diagnosis for a failed panel round-trip.
diagnose() {
  # $1 route, for the message
  msg=$(error_of)
  cls=$(classify_api_error "$msg")
  if [ "$cls" = "tls" ]; then
    fail "TLS trust failure on $1: the panel could not verify the cluster CA ($msg). The pod must run in-cluster with its projected ServiceAccount volume (/var/run/secrets/kubernetes.io/serviceaccount/ca.crt) and PANEL_K8S_BASE must stay unset — the override disables CA verification."
  fi
  if [ "$cls" = "rbac" ]; then
    fail "RBAC failure on $1: the panel ServiceAccount was rejected ($msg). Apply deploy/hermes/base/rbac.yaml (the loop-manager Role) and deploy/panel/base/rbac.yaml (the panel-loop-manager binding), then re-run."
  fi
  fail "$1 failed: $msg"
}

# Assert the panel ServiceAccount can $1 $2 in $3 via SubjectAccessReview.
rbac_or_die() {
  # $1 verb, $2 resource, $3 namespace
  out=$(kubectl auth can-i "$1" "$2" -n "$3" --as=system:serviceaccount:agents:panel 2>&1) || {
    fail "RBAC preflight: SubjectAccessReview failed ($out) — the kubeconfig in use must be allowed to create authorization.k8s.io reviews"
  }
  if [ "$out" != "yes" ]; then
    fail "RBAC preflight: ServiceAccount agents/panel cannot $1 $2 in $3 — apply deploy/hermes/base/rbac.yaml (loop-manager Role) and deploy/panel/base/rbac.yaml (panel-loop-manager binding)"
  fi
  pass "RBAC: agents/panel can $1 $2 in $3"
}

# Pull the loop-agent stand-in image: honors the LOOP_COMMAND contract without
# the multi-GB loop-agent build (kind mode default).
build_loop_shim() {
  dir="$TMP/loop-shim"
  mkdir -p "$dir"
  cat > "$dir/run-loop" <<'LOOPSHIM'
#!/bin/sh
# Minimal stand-in for apps/loop-agent/run-loop.sh: runs $LOOP_COMMAND and
# propagates its exit status, skipping the GitHub clone step.
set -eu
: "${LOOP_COMMAND:?LOOP_COMMAND is required}"
echo "[loop] starting: ${LOOP_COMMAND}"
sh -c "${LOOP_COMMAND}"
LOOPSHIM
  chmod 755 "$dir/run-loop"
  cat > "$dir/Dockerfile" <<'LOOPDOCKER'
FROM node:24-bookworm-slim
COPY run-loop /usr/local/bin/run-loop
ENTRYPOINT ["/usr/local/bin/run-loop"]
LOOPDOCKER
  docker build -q -t panel-e2e-loop:e2e "$dir" >/dev/null
  LOOP_IMAGE="panel-e2e-loop:e2e"
}

load_if_local() {
  # $1 image ref — push into the kind node when it exists in the local store
  if docker image inspect "$1" >/dev/null 2>&1; then
    note "loading $1 into kind"
    kind load docker-image "$1" --name "$CLUSTER"
  else
    note "$1 is not in the local docker store; assuming the cluster can pull it"
  fi
}

# $1 method, $2 path, $3 json body file ("-" = none); sets CODE, writes $BODY.
http() {
  if [ "$3" = "-" ]; then
    CODE=$(curl -sS -o "$BODY" -w '%{http_code}' -X "$1" "http://127.0.0.1:${API_PORT}$2") || {
      fail "request failed: $1 $2 (is the port-forward alive?)"
    }
  else
    CODE=$(curl -sS -o "$BODY" -w '%{http_code}' -X "$1" \
      -H 'content-type: application/json' --data-binary @"$3" \
      "http://127.0.0.1:${API_PORT}$2") || {
      fail "request failed: $1 $2 (is the port-forward alive?)"
    }
  fi
}

assert_code() {
  # $1 want, $2 what
  if [ "$CODE" != "$1" ]; then
    fail "$2: HTTP $CODE, want $1 (body: $(cat "$BODY" 2>/dev/null))"
  fi
}

require_state_entry() {
  # $1 = /api/state JSON file, $2 = seed job name, $3 = seed cron name, $4 = schedule
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const jobs = Array.isArray(j.jobs) ? j.jobs : [];
const crons = Array.isArray(j.cronjobs) ? j.cronjobs : [];
const job = jobs.find((x) => x && x.name === process.argv[2]);
if (!job) {
  console.error("GET /api/state lists no Job " + process.argv[2] + " (jobs: " + jobs.map((x) => x && x.name).join(", ") + ")");
  process.exit(1);
}
if (job.status !== "pending") {
  console.error("GET /api/state reports seeded Job as " + job.status + ", want pending");
  process.exit(1);
}
const cron = crons.find((x) => x && x.name === process.argv[3]);
if (!cron) {
  console.error("GET /api/state lists no CronJob " + process.argv[3]);
  process.exit(1);
}
if (cron.schedule !== process.argv[4] || cron.suspended !== true) {
  console.error("GET /api/state reports CronJob " + process.argv[3] + " schedule=" + cron.schedule + " suspended=" + cron.suspended + ", want " + process.argv[4] + "/true");
  process.exit(1);
}
' "$1" "$2" "$3" "$4"
}

require_created_job_in_state() {
  # $1 = /api/state JSON file, $2 = created job name
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const name = process.argv[2];
const job = (j.jobs || []).find((x) => x && x.name === name);
if (!job) {
  console.error("/api/state does not list the created Job " + name);
  process.exit(1);
}
if (job.status !== "complete") {
  console.error("/api/state reports " + name + " as " + job.status + ", want complete");
  process.exit(1);
}
' "$1" "$2"
}

require_job_manifest() {
  # $1 = Job JSON file, $2 = command, $3 = image, $4 = issue
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const wantCmd = process.argv[2];
const wantImage = process.argv[3];
const wantIssue = process.argv[4];
const problems = [];
const need = (ok, msg) => {
  if (!ok) { problems.push(msg); }
};
const pod = (j.spec && j.spec.template && j.spec.template.spec) || {};
const c = (pod.containers || [])[0];
need(j.metadata && j.metadata.namespace === "sandbox", "namespace is sandbox");
need(j.metadata && j.metadata.labels && j.metadata.labels["app.kubernetes.io/managed-by"] === "panel", "label managed-by=panel");
need(j.spec && j.spec.backoffLimit === 1, "backoffLimit is 1");
need(j.spec && j.spec.ttlSecondsAfterFinished === 604800, "ttlSecondsAfterFinished is 604800");
need(pod.automountServiceAccountToken === false, "pod automountServiceAccountToken is false");
need(pod.restartPolicy === "Never", "restartPolicy is Never");
need(!!(pod.securityContext && pod.securityContext.seccompProfile && pod.securityContext.seccompProfile.type === "RuntimeDefault"), "pod seccompProfile RuntimeDefault");
need(!!c, "Job has a container");
if (c) {
  need(c.image === wantImage, "container image is " + c.image + ", want " + wantImage);
  const env = {};
  (c.env || []).forEach((e) => { env[e.name] = e.value; });
  need(env.LOOP_COMMAND === wantCmd, "LOOP_COMMAND is " + JSON.stringify(env.LOOP_COMMAND) + ", want " + JSON.stringify(wantCmd));
  need(env.WATCHER_ISSUE === wantIssue, "WATCHER_ISSUE is " + env.WATCHER_ISSUE + ", want " + wantIssue);
  need(env.WATCHER_REPO === "gwkline/homelab", "WATCHER_REPO is " + env.WATCHER_REPO);
  need(env.GITHUB_TOKEN_FILE === "/secrets/token", "GITHUB_TOKEN_FILE is /secrets/token");
  const sc = c.securityContext || {};
  need(sc.runAsNonRoot === true, "runAsNonRoot is true");
  need(sc.runAsUser === 1000, "runAsUser is " + sc.runAsUser + ", want 1000");
  need(sc.allowPrivilegeEscalation === false, "allowPrivilegeEscalation is false");
  need(!!(sc.capabilities && Array.isArray(sc.capabilities.drop) && sc.capabilities.drop.join(",") === "ALL"), "capabilities.drop is ALL");
  const res = c.resources || {};
  need(!!(res.requests && res.requests.cpu === "500m" && res.requests.memory === "1Gi"), "requests cpu=500m memory=1Gi");
  need(!!(res.limits && res.limits.memory === "4Gi"), "limits memory=4Gi");
}
if (problems.length) {
  console.error("created Job manifest does not match server/jobs.ts:");
  problems.forEach((p) => console.error("  - " + p));
  process.exit(1);
}
' "$1" "$2" "$3" "$4"
}

cleanup_k8s_objects() {
  note "cleaning up e2e objects (created Job, seeds, panel-e2e Deployment)"
  kubectl -n sandbox delete job "$JOB_NAME" --ignore-not-found >/dev/null
  kubectl -n sandbox delete jobs,cronjobs -l panel-e2e=true --ignore-not-found >/dev/null
  kubectl -n agents delete deployment "$DEPLOY_NAME" --ignore-not-found >/dev/null
  if [ "$CREATED_SECRET" -eq 1 ]; then
    kubectl -n agents delete secret github-token --ignore-not-found >/dev/null
  fi
}

# ── flags ──
while [ "$#" -gt 0 ]; do
  case "$1" in
    --kind) KIND_MODE=1 ;;
    --keep) KEEP_CLUSTER=1 ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require kubectl "kubernetes CLI (dl.k8s.io)"
require curl "http client"
require node "used to parse the panel JSON responses"

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

TMP=$(mktemp -d "${TMPDIR:-/tmp}/panel-e2e.XXXXXX")
BODY="$TMP/body.json"
REQ="$TMP/req.json"
JOB_JSON="$TMP/job.json"

if [ "$KIND_MODE" -eq 1 ]; then
  require kind "kind cluster manager (kind.sigs.k8s.io)"
  require docker "image builds + kind node runtime"
  KCFG="$TMP/kubeconfig"
  KUBECONFIG="$KCFG"
  export KUBECONFIG
  note "creating disposable kind cluster ${CLUSTER} (isolated KUBECONFIG)"
  kind create cluster --name "$CLUSTER" --kubeconfig "$KCFG" --wait 180s
else
  ctx=$(kubectl config current-context 2>/dev/null || printf '?')
  note "using current kubectl context: ${ctx}"
  if [ "${PANEL_E2E_ASSUME_DISPOSABLE:-0}" != "1" ]; then
    printf 'This test must run against a DISPOSABLE cluster (kind/k3d/k3s); it creates RBAC, a %s Deployment and sandbox Jobs.\n' "$DEPLOY_NAME"
    printf 'Continue against %s? [y/N] ' "$ctx"
    read -r reply || fail "aborted (non-interactive; set PANEL_E2E_ASSUME_DISPOSABLE=1 to skip this prompt)"
    case "$reply" in
      y|Y|yes|YES) : ;;
      *) fail "aborted" ;;
    esac
  fi
fi

if [ -z "$PANEL_IMAGE" ]; then
  require docker "building the panel image (or set PANEL_E2E_PANEL_IMAGE)"
  PANEL_IMAGE="ghcr.io/gwkline/homelab/panel:e2e"
  note "building panel image ${PANEL_IMAGE} from apps/panel/Dockerfile"
  docker build -f apps/panel/Dockerfile -t "$PANEL_IMAGE" "$REPO_ROOT"
fi
if [ "$KIND_MODE" -eq 1 ] && [ -z "${PANEL_E2E_LOOP_IMAGE:-}" ]; then
  note "building LOOP_COMMAND-compatible loop shim (set PANEL_E2E_LOOP_IMAGE to use the real loop-agent image)"
  build_loop_shim
fi
note "panel image: ${PANEL_IMAGE}"
note "launched Job image: ${LOOP_IMAGE}"

# ── real RBAC: the panel ServiceAccount and its bindings, as deployed ──
note "applying namespaces + panel RBAC from the real manifests"
kubectl apply -f "$REPO_ROOT/deploy/namespaces.yaml"
kubectl apply -f "$REPO_ROOT/deploy/hermes/base/rbac.yaml"
kubectl apply -f "$REPO_ROOT/deploy/panel/base/rbac.yaml"
kubectl apply -f "$REPO_ROOT/deploy/panel/base/nodes-viewer.yaml"
kubectl -n agents get serviceaccount panel >/dev/null 2>&1 || {
  fail "ServiceAccount agents/panel missing after applying deploy/panel/base/rbac.yaml"
}
rbac_or_die create jobs.batch sandbox
rbac_or_die list jobs.batch sandbox
rbac_or_die list cronjobs.batch sandbox

if ! kubectl -n agents get secret github-token >/dev/null 2>&1; then
  kubectl -n agents create secret generic github-token --from-literal=token=panel-e2e-placeholder
  CREATED_SECRET=1
fi

# ── known cluster state the panel must report ──
note "seeding known state in sandbox (suspended Job + CronJob)"
kubectl apply -f - <<'SEEDYAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: panel-e2e-seed
  namespace: sandbox
  labels:
    panel-e2e: "true"
spec:
  suspend: true
  backoffLimit: 1
  template:
    metadata:
      labels:
        app: panel-e2e-seed
    spec:
      restartPolicy: Never
      containers:
        - name: seed
          image: busybox:1.37
          command: ["echo", "seeded (suspended; never runs)"]
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: panel-e2e-cron
  namespace: sandbox
  labels:
    panel-e2e: "true"
spec:
  schedule: "30 5 * * *"
  suspend: true
  jobTemplate:
    spec:
      template:
        metadata:
          labels:
            app: panel-e2e-cron
        spec:
          restartPolicy: Never
          containers:
            - name: seed
              image: busybox:1.37
              command: ["echo", "seeded (suspended; never runs)"]
SEEDYAML

# ── deploy the panel pod: real ServiceAccount, in-cluster config ──
# Mirrors deploy/panel/base/deployment.yaml with three deltas: the e2e name
# (so a real panel Deployment is never touched), the image, and the
# PANEL_LOOP_IMAGE override for the launched Job.
note "deploying ${DEPLOY_NAME} (ServiceAccount agents/panel, cluster CA, no PANEL_K8S_BASE)"
kubectl apply -f - <<DEPLOYEOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${DEPLOY_NAME}
  namespace: agents
  labels:
    app: ${DEPLOY_NAME}
    app.kubernetes.io/part-of: homelab
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${DEPLOY_NAME}
  template:
    metadata:
      labels:
        app: ${DEPLOY_NAME}
    spec:
      serviceAccountName: panel
      automountServiceAccountToken: true
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: panel
          image: ${PANEL_IMAGE}
          env:
            - name: FACTORY_REPO
              value: ${REPO}
            - name: PANEL_LOOP_IMAGE
              value: ${LOOP_IMAGE}
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            capabilities:
              drop: [ALL]
          ports:
            - containerPort: 3000
              name: http
          resources:
            requests:
              cpu: 50m
              memory: 128Mi
            limits:
              memory: 512Mi
          startupProbe:
            httpGet:
              path: /
              port: http
            failureThreshold: 30
            periodSeconds: 5
          readinessProbe:
            httpGet:
              path: /
              port: http
            periodSeconds: 30
DEPLOYEOF

if [ "$KIND_MODE" -eq 1 ]; then
  load_if_local "$PANEL_IMAGE"
  load_if_local "$LOOP_IMAGE"
fi

note "waiting for the ${DEPLOY_NAME} Deployment"
if ! kubectl -n agents rollout status "deployment/${DEPLOY_NAME}" --timeout=300s; then
  kubectl -n agents describe pods -l "app=${DEPLOY_NAME}" 2>&1 >&2 || :
  fail "panel Deployment did not become available — pod events above (image pull? probes?)"
fi

pod_sa=$(kubectl -n agents get deployment "$DEPLOY_NAME" -o jsonpath='{.spec.template.spec.serviceAccountName}')
if [ "$pod_sa" != "panel" ]; then
  fail "panel pod serviceAccountName is '${pod_sa}', want 'panel' (the real ServiceAccount is required)"
fi
override=$(kubectl -n agents get deployment "$DEPLOY_NAME" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PANEL_K8S_BASE")].name}')
if [ -n "$override" ]; then
  fail "PANEL_K8S_BASE is set on the panel container — the test must exercise the in-cluster config (real cluster CA + ServiceAccount token), not an override"
fi
pass "panel runs as ServiceAccount agents/panel on the in-cluster config (real CA, rejectUnauthorized on)"

# ── reach the panel over a port-forward (bypasses NetworkPolicy by design) ──
note "port-forwarding the panel to 127.0.0.1:${API_PORT}"
kubectl port-forward -n agents "deployment/${DEPLOY_NAME}" "127.0.0.1:${API_PORT}:3000" >/dev/null 2>&1 &
PF_PID=$!
i=0
while :; do
  if curl -sf "http://127.0.0.1:${API_PORT}/" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    fail "panel did not answer http://127.0.0.1:${API_PORT}/ within 60s"
  fi
  sleep 1
done
pass "panel is serving"

# ── 1. list state through the real API server ──
note "GET /api/state (panel SA + cluster CA against the live API server)"
http GET /api/state -
if [ "$CODE" != "200" ]; then
  diagnose "/api/state"
fi
require_state_entry "$BODY" "$SEED_JOB" "$SEED_CRON" "$SEED_SCHEDULE"
pass "TLS trust verified: GET /api/state returned the seeded Job ${SEED_JOB} + CronJob ${SEED_CRON}"

# ── 2. launch a Job and prove the manifest ──
CMD="echo panel-e2e-ok-$(date +%s)"
printf '{"command":"%s","issue":"%s"}\n' "$CMD" "$ISSUE" > "$REQ"
note "POST /api/jobs (command: ${CMD}, issue: ${ISSUE})"
http POST /api/jobs "$REQ"
if [ "$CODE" != "201" ]; then
  diagnose "/api/jobs"
fi
JOB_NAME=$(node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (typeof j.name !== "string" || !/^panel-/u.test(j.name)) {
  console.error("POST /api/jobs: unexpected response " + JSON.stringify(j));
  process.exit(1);
}
process.stdout.write(j.name);
' < "$BODY")
pass "POST /api/jobs created Job ${JOB_NAME}"

kubectl -n sandbox get job "$JOB_NAME" -o json > "$JOB_JSON"
require_job_manifest "$JOB_JSON" "$CMD" "$LOOP_IMAGE" "$ISSUE"
pass "created Job manifest carries the command + locked-down container fields"

# ── 3. the created Job reaches a terminal state ──
note "waiting for Job ${JOB_NAME} to reach a terminal state (<= ${JOB_WAIT}s)"
if kubectl -n sandbox wait --for=condition=complete "job/${JOB_NAME}" --timeout="${JOB_WAIT}s" >/dev/null 2>&1; then
  pass "created Job reached Complete"
else
  kubectl -n sandbox wait --for=condition=failed "job/${JOB_NAME}" --timeout=10s >/dev/null 2>&1 || :
  kubectl -n sandbox describe "job/${JOB_NAME}" >&2 || :
  kubectl -n sandbox logs "job/${JOB_NAME}" --all-containers --tail=50 >&2 || :
  fail "Job ${JOB_NAME} did not reach Complete within ${JOB_WAIT}s (describe + logs above)"
fi

# ── 4. invalid inputs stay rejected ──
printf '{"command":"   "}\n' > "$REQ"
http POST /api/jobs "$REQ"
assert_code 400 "empty command must be rejected"
printf '{"command":"echo ok","issue":"not-a-number"}\n' > "$REQ"
http POST /api/jobs "$REQ"
assert_code 400 "non-numeric issue must be rejected"
pass "invalid command + issue inputs stay rejected (400)"

# ── evidence: API state + the created Job, preserved in the output ──
http GET /api/state -
assert_code 200 "/api/state after launch"
require_created_job_in_state "$BODY" "$JOB_NAME"
pass "/api/state now reports ${JOB_NAME} as complete"

printf '\n==> evidence: /api/state\n'
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.stdout.write(JSON.stringify(j, null, 2) + "\n");
' "$BODY"
printf '\n==> evidence: created Job %s\n' "$JOB_NAME"
kubectl -n sandbox get job "$JOB_NAME" -o yaml

if [ "$KEEP_CLUSTER" -eq 0 ]; then
  cleanup_k8s_objects
else
  note "--keep: leaving e2e objects in place (deployment ${DEPLOY_NAME}, seeds ${SEED_JOB}/${SEED_CRON}, job ${JOB_NAME})"
fi

printf '\nALL PANEL E2E CHECKS PASSED\n'
