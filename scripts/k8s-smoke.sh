#!/bin/sh
# API-server smoke test for the rendered cluster manifests (issue #16).
#
# `kubectl kustomize` only renders YAML — it cannot see cross-resource or
# runtime failures. This script submits the repository's normal manifest set
# (the recovery-drill apply order plus the self-contained observability and
# utility stacks) to a REAL Kubernetes API server and asserts:
#
#   1. the cluster runs the production k3s pin (bootstrap/bootstrap.sh is the
#      single source of truth for the version — CI installs exactly that pin,
#      so manifest semantics stay compatible with production),
#   2. every manifest is admitted: the API server rejects what rendering
#      cannot see — malformed RoleBindings (unknown roleRef targets,
#      wrong-scope refs, ClusterRoleBinding subjects without a namespace),
#   3. the RBAC graph resolves after apply: every ServiceAccount subject of
#      every RoleBinding/ClusterRoleBinding exists, every roleRef target
#      exists, and every workload's serviceAccountName resolves to a
#      ServiceAccount in the same namespace (admission does NOT check any of
#      these — they are exactly the audit's "missing same-namespace
#      ServiceAccounts" class),
#   4. expected ServiceAccount permissions hold, positive AND negative
#      (kubectl auth can-i as the automation identities: panel and dispatcher
#      may create sandbox Jobs but read no secrets; hermes stays read-only;
#      chaos-monkey deletes pods only in agents+sandbox; auto-deploy patches
#      only agents workloads),
#   5. at least one admitted pod actually runs (the cross-resource runtime
#      class rendering can never catch): a purpose-built least-privilege
#      sandbox Job (smoke-probe) completes, and one core workload (headlamp)
#      rolls out Ready.
#
# External integrations are skipped with explicit reasons (EXCLUSIONS below)
# — never silently ignored. On any failure the script dumps Kubernetes
# events, pod status, and pod logs for the affected namespaces.
#
# Usage:
#   sh scripts/k8s-smoke.sh [--create-cluster]
#     --create-cluster  install a disposable k3s at the production pin first
#                       (the CI path; needs sudo). Otherwise $KUBECONFIG (or
#                       kubectl's default) must already point at a cluster —
#                       use a throwaway cluster, the test mutates it.
#   KUBECTL=...       override the client binary (offline tests use a stub).
#
# Budget: well under five minutes (k3s install ~60s, applies ~30s, waits ~90s).
set -eu

# --------------------------------------------------------------------------
# Setup
KUBECTL=${KUBECTL:-kubectl}
CREATE_CLUSTER=0
if [ $# -gt 0 ]; then
  case "$1" in
    --create-cluster) CREATE_CLUSTER=1 ;;
    *) echo "usage: $0 [--create-cluster]" >&2; exit 2 ;;
  esac
fi

REPO_ROOT=$(cd "$(dirname "$0")/.." || exit 1)
cd "$REPO_ROOT" || exit 1

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

TAB=$(printf '\t')
ERRORS="$WORK/errors"
: >"$ERRORS"

# Production k3s pin — single source of truth: bootstrap/bootstrap.sh.
PROD_PIN=$(sed -n 's/.*K3S_VERSION:-\([^}"]*\).*/\1/p' bootstrap/bootstrap.sh | head -n 1)
[ -n "$PROD_PIN" ] || { echo "FAIL: cannot read the K3S_VERSION pin from bootstrap/bootstrap.sh" >&2; exit 1; }

# Vendor-managed namespaces: not part of the repo's manifest surface, and
# k3s keeps them self-consistent.
skip_system_ns() {
  case "$1" in
    kube-system | kube-public | kube-node-lease) return 0 ;;
    *) return 1 ;;
  esac
}

dump_diagnostics() {
  echo "---- Kubernetes events (most recent last) ----"
  "$KUBECTL" get events -A --sort-by=.lastTimestamp 2>/dev/null | tail -n 80 || true
  echo "---- pods across the cluster ----"
  "$KUBECTL" get pods -A -o wide 2>/dev/null || true
  for _ns in "$@"; do
    echo "---- pod logs in namespace $_ns ----"
      # shellcheck disable=SC2046 — pod names are single-line tokens
    for _pod in $("$KUBECTL" get pods -n "$_ns" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true); do
      echo "== $_ns/$_pod =="
      "$KUBECTL" logs -n "$_ns" "$_pod" --all-containers --tail=40 2>/dev/null || true
    done
  done
}

die() { echo "FAIL: $1" >&2; exit 1; }

die_ns() {
  echo "FAIL: $2" >&2
  dump_diagnostics "$1"
  exit 1
}

record_error() {
  printf '%s\n' "$1" | tee -a "$ERRORS" >&2
}

# --------------------------------------------------------------------------
# Excluded integrations — explicit and audited, never silently ignored.
# These need external systems the smoke cluster deliberately does not run.
EXCLUSIONS="deploy/tailscale|Tailscale SaaS — operator needs OAuth credentials and a live tailnet; no stub without the external chart and secret store
deploy/eso/base|External Secrets Operator — smoke cluster installs no ESO and holds no 1Password vault credentials
deploy/github-tokens/base|ExternalSecrets synced from 1Password (external secret store) — ESO CRDs are absent here
deploy/backup/base|ExternalSecret + restic job keyed to 1Password-synced secrets and B2 (external secret store)
deploy/image-policy/base|ClusterImagePolicy CRD ships with the sigstore policy-controller chart — admission webhook infra is not installed here
deploy/cnpg/base|vendor operator bundle + CRDs (upstream-managed RBAC); its Postgres reconcile is heavy and out of the smoke budget
deploy/postgres/base|CloudNativePG Cluster CRs need the excluded cnpg operator — DB runtime is out of scope for the smoke
deploy/gvisor/base|alternative variant that REPLACES deploy/loop-agent/base and requires the gVisor runtime handler on nodes"

# --------------------------------------------------------------------------
# Stage 0: cluster
if [ "$CREATE_CLUSTER" -eq 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required for --create-cluster"
  echo "==> installing disposable k3s at the production pin $PROD_PIN"
  curl -sfL https://get.k3s.io -o "$WORK/k3s-install.sh" || die "cannot download the k3s installer"
  sudo INSTALL_K3S_VERSION="$PROD_PIN" sh "$WORK/k3s-install.sh" server \
    --disable traefik --write-kubeconfig-mode 644 || die "k3s install failed"
  KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  export KUBECONFIG
  "$KUBECTL" wait --for=condition=ready node --all --timeout=180s || die "k3s node never became Ready"
fi

SERVER_VERSION=$("$KUBECTL" get nodes -o jsonpath='{.items[0].status.nodeInfo.kubeletVersion}' 2>/dev/null || true)
[ -n "$SERVER_VERSION" ] || die "no cluster reachable — pass --create-cluster or export KUBECONFIG"
PIN_BASE=${PROD_PIN%%+*}
case "$SERVER_VERSION" in
  "$PIN_BASE"*) echo "OK cluster version $SERVER_VERSION matches the production pin ($PROD_PIN)" ;;
  *) die "cluster server version '$SERVER_VERSION' does not match the production k3s pin '$PROD_PIN' (bootstrap/bootstrap.sh)" ;;
esac

# --------------------------------------------------------------------------
echo "==> excluded integrations (explicit, auditable — not silently ignored)"
echo "$EXCLUSIONS" | while IFS='|' read -r _path _reason; do
  echo "SKIP $_path — $_reason"
done

# --------------------------------------------------------------------------
# Stage 1: apply the normal manifest set (the API server validates every
# document: schema, namespace existence, and — for RBAC bindings — roleRef
# targets, which is how malformed RoleBindings are caught).
echo "==> applying the normal manifest set"
apply_target() {
  _mode=$1
  _path=$2
  if ! "$KUBECTL" apply "$_mode" "$_path" >/dev/null; then
    die_ns agents "kubectl apply $_mode $_path rejected by the API server (see events + stderr above)"
  fi
  echo "APPLY $_mode $_path"
}
apply_target -f deploy/namespaces.yaml
apply_target -k deploy/policies/base
for _target in \
  deploy/t3code/base \
  deploy/hermes/base \
  deploy/loop-agent/base \
  deploy/homepage/base \
  deploy/panel/base \
  deploy/headlamp/base \
  deploy/dispatcher/base \
  deploy/factory/base \
  deploy/chaos/base \
  deploy/chaos/agents \
  deploy/auto-deploy \
  deploy/grafana/base \
  deploy/loki/base \
  deploy/cloudbeaver/base \
  deploy/executor/base; do
  apply_target -k "$_target"
done

# --------------------------------------------------------------------------
# Stage 2: RBAC graph — post-apply cross-resource checks that neither
# rendering nor admission covers.
echo "==> RBAC graph checks"

Q_RB='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.roleRef.kind}{"\t"}{.roleRef.name}{"\n"}{end}'
Q_RB_SUBJ='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .subjects[*]}{.kind}{"\t"}{.name}{"\t"}{.namespace}{"\n"}{end}{end}'
Q_CRB='{range .items[*]}{.metadata.name}{"\t"}{.roleRef.kind}{"\t"}{.roleRef.name}{"\n"}{end}'
Q_CRB_SUBJ='{range .items[*]}{.metadata.name}{"\t"}{range .subjects[*]}{.kind}{"\t"}{.name}{"\t"}{.namespace}{"\n"}{end}{end}'
Q_PODLIKE='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.template.spec.serviceAccountName}{"\n"}{end}'
Q_JOBS='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.template.spec.serviceAccountName}{"\n"}{end}'
Q_CRONJOBS='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{.spec.jobTemplate.spec.template.spec.serviceAccountName}{"\n"}{end}'

"$KUBECTL" get rolebindings -A -o jsonpath="$Q_RB" >"$WORK/rb.tsv" 2>/dev/null || die "cannot list rolebindings"
"$KUBECTL" get rolebindings -A -o jsonpath="$Q_RB_SUBJ" >"$WORK/rb-subj.tsv" 2>/dev/null || die "cannot list rolebinding subjects"
"$KUBECTL" get clusterrolebindings -o jsonpath="$Q_CRB" >"$WORK/crb.tsv" 2>/dev/null || die "cannot list clusterrolebindings"
"$KUBECTL" get clusterrolebindings -o jsonpath="$Q_CRB_SUBJ" >"$WORK/crb-subj.tsv" 2>/dev/null || die "cannot list clusterrolebinding subjects"
"$KUBECTL" get deployments,statefulsets,daemonsets -A -o jsonpath="$Q_PODLIKE" >"$WORK/podlike.tsv" 2>/dev/null || die "cannot list workload pod specs"
"$KUBECTL" get jobs -A -o jsonpath="$Q_JOBS" >"$WORK/jobs.tsv" 2>/dev/null || die "cannot list jobs"
"$KUBECTL" get cronjobs -A -o jsonpath="$Q_CRONJOBS" >"$WORK/cronjobs.tsv" 2>/dev/null || die "cannot list cronjobs"

sa_exists() {
  "$KUBECTL" get serviceaccount "$1" -n "$2" >/dev/null 2>&1
}

# roleRef targets: admission rejects unknown ones at apply time; this
# re-check keeps the assertion explicit (and covers wrong-scope refs).
while IFS="$(printf '\t')" read -r b_ns b_name ref_kind ref_name; do
  [ -n "$b_ns" ] || continue
  skip_system_ns "$b_ns" && continue
  case "$ref_kind" in
    Role)
      "$KUBECTL" get role "$ref_name" -n "$b_ns" >/dev/null 2>&1 ||
        record_error "BROKEN RoleBinding $b_ns/$b_name: roleRef Role/$ref_name does not exist in namespace $b_ns"
      ;;
    ClusterRole)
      "$KUBECTL" get clusterrole "$ref_name" >/dev/null 2>&1 ||
        record_error "BROKEN RoleBinding $b_ns/$b_name: roleRef ClusterRole/$ref_name does not exist"
      ;;
    *) record_error "MALFORMED RoleBinding $b_ns/$b_name: unsupported roleRef kind '$ref_kind'" ;;
  esac
done <"$WORK/rb.tsv"

# ServiceAccount subjects must resolve (subjects pointing at missing
# ServiceAccounts are admitted silently — the API server never rejects them).
while IFS="$(printf '\t')" read -r b_ns b_name s_kind s_name s_ns; do
  [ -n "$s_kind" ] || continue
  skip_system_ns "$b_ns" && continue
  [ "$s_kind" = "ServiceAccount" ] || continue
  target_ns=${s_ns:-$b_ns}
  [ -n "$target_ns" ] || continue
  "$KUBECTL" get serviceaccount "$s_name" -n "$target_ns" >/dev/null 2>&1 ||
    record_error "BROKEN RoleBinding $b_ns/$b_name: ServiceAccount subject '$s_name' (namespace $target_ns) does not exist"
done <"$WORK/rb-subj.tsv"

# ClusterRoleBindings: roleRef must be a ClusterRole; ServiceAccount subjects
# MUST carry a namespace.
while IFS="$(printf '\t')" read -r b_name ref_kind ref_name; do
  [ -n "$b_name" ] || continue
  case "$ref_kind" in
    ClusterRole)
      "$KUBECTL" get clusterrole "$ref_name" >/dev/null 2>&1 ||
        record_error "BROKEN ClusterRoleBinding $b_name: roleRef ClusterRole/$ref_name does not exist"
      ;;
    *) record_error "MALFORMED ClusterRoleBinding $b_name: roleRef kind must be ClusterRole (got '$ref_kind')" ;;
  esac
done <"$WORK/crb.tsv"

while IFS="$(printf '\t')" read -r b_name s_kind s_name s_ns; do
  [ -n "$s_kind" ] || continue
  [ "$s_kind" = "ServiceAccount" ] || continue
  if [ -z "$s_ns" ]; then
    record_error "MALFORMED ClusterRoleBinding $b_name: ServiceAccount subject '$s_name' has no namespace"
    continue
  fi
  "$KUBECTL" get serviceaccount "$s_name" -n "$s_ns" >/dev/null 2>&1 ||
    record_error "BROKEN ClusterRoleBinding $b_name: ServiceAccount subject '$s_name' (namespace $s_ns) does not exist"
done <"$WORK/crb-subj.tsv"

# Workload podSpecs: serviceAccountName must resolve in the SAME namespace
# (pod admission rejects pods referencing a missing SA — but only once a
# controller tries to create one; assert the graph up front).
check_workload_sas() {
  _file=$1
  _kind=$2
  while IFS="$(printf '\t')" read -r w_ns w_name w_sa; do
    [ -n "$w_ns" ] || continue
    skip_system_ns "$w_ns" && continue
    [ -n "$w_sa" ] || continue
    "$KUBECTL" get serviceaccount "$w_sa" -n "$w_ns" >/dev/null 2>&1 ||
      record_error "BROKEN $_kind $w_ns/$w_name: serviceAccountName '$w_sa' — no such ServiceAccount in namespace $w_ns"
  done <"$_file"
}
check_workload_sas "$WORK/podlike.tsv" "Deployment/StatefulSet/DaemonSet"
check_workload_sas "$WORK/jobs.tsv" "Job"
check_workload_sas "$WORK/cronjobs.tsv" "CronJob"

# --------------------------------------------------------------------------
# Stage 3: expected ServiceAccount permissions (binding graph end-to-end).
# Positive and negative assertions; ns '-' = cluster-scoped check.
echo "==> ServiceAccount permission assertions (kubectl auth can-i)"
CANI_ROWS='create|jobs|sandbox|system:serviceaccount:agents:panel|yes
create|jobs|sandbox|system:serviceaccount:sandbox:dispatcher|yes
delete|pods|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:sandbox:dispatcher|no
delete|pods|sandbox|system:serviceaccount:sandbox:dispatcher|no
get|nodes|-|system:serviceaccount:agents:hermes|yes
delete|pods|sandbox|system:serviceaccount:agents:hermes|no
get|secrets|agents|system:serviceaccount:agents:hermes|no
delete|pods|sandbox|system:serviceaccount:sandbox:chaos-monkey|yes
delete|pods|agents|system:serviceaccount:sandbox:chaos-monkey|yes
get|secrets|sandbox|system:serviceaccount:sandbox:chaos-monkey|no
delete|pods|kube-system|system:serviceaccount:sandbox:chaos-monkey|no
patch|deployments|agents|system:serviceaccount:agents:auto-deploy|yes
patch|deployments|sandbox|system:serviceaccount:agents:auto-deploy|no
get|secrets|agents|system:serviceaccount:agents:auto-deploy|no'
printf '%s\n' "$CANI_ROWS" >"$WORK/cani.tsv"
while IFS='|' read -r c_verb c_res c_ns c_as c_expect; do
  [ -n "$c_verb" ] || continue
  if [ "$c_ns" = "-" ]; then
    _got=$("$KUBECTL" auth can-i "$c_verb" "$c_res" --as="$c_as" 2>/dev/null || true)
  else
    _got=$("$KUBECTL" auth can-i "$c_verb" "$c_res" -n "$c_ns" --as="$c_as" 2>/dev/null || true)
  fi
  if [ "$_got" != "$c_expect" ]; then
    record_error "RBAC PERMISSION DRIFT: can-i as '$c_as' -> $c_verb $c_res${c_ns:+ in $c_ns} = '${_got:-<error>}', expected '$c_expect'"
  fi
done <"$WORK/cani.tsv"

# --------------------------------------------------------------------------
if [ -s "$ERRORS" ]; then
  echo "==> RBAC/ServiceAccount checks FAILED"
  die_ns sandbox "see the BROKEN/MALFORMED/DRIFT lines above"
fi

# --------------------------------------------------------------------------
# Stage 4: runtime smoke — one admitted Job must actually run, and one core
# workload must roll out Ready (catches controller-created pod failures:
# missing mounts, bad images, netpol deadlocks).
echo "==> runtime smoke fixtures"
cat >"$WORK/smoke.yaml" <<'EOF'
# Purpose-built smoke fixture (issue #16): proves pods are admitted AND run
# in the sandbox, on a least-privilege identity — smoke-probe has NO RBAC
# bindings and no token mount, so a compromised probe reaches nothing.
apiVersion: v1
kind: ServiceAccount
metadata:
  name: smoke-probe
  namespace: sandbox
automountServiceAccountToken: false
---
apiVersion: batch/v1
kind: Job
metadata:
  name: smoke-probe
  namespace: sandbox
  labels:
    app.kubernetes.io/part-of: homelab
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 90
  template:
    metadata:
      labels:
        app: k8s-smoke-probe
    spec:
      restartPolicy: Never
      serviceAccountName: smoke-probe
      containers:
        - name: probe
          image: busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
          command: ["/bin/sh", "-c"]
          args:
            - |
              echo "smoke-probe: pod is running"
              test ! -e /var/run/secrets/kubernetes.io/serviceaccount/token ||
                { echo "smoke-probe: FAIL — token mounted on a token-free SA"; exit 1; }
              echo "smoke-probe: least-privilege posture verified"
EOF
if ! "$KUBECTL" apply -f "$WORK/smoke.yaml" >/dev/null; then
  die_ns sandbox "smoke fixture (SA + Job) rejected by the API server"
fi
if ! "$KUBECTL" wait --for=condition=complete job/smoke-probe -n sandbox --timeout=120s; then
  die_ns sandbox "smoke Job 'smoke-probe' never completed (pod start/runtime failure)"
fi
echo "OK smoke Job completed (pod admitted + ran; SA token correctly absent)"

if ! "$KUBECTL" rollout status deployment/headlamp -n agents --timeout=150s; then
  die_ns agents "headlamp deployment never became Ready"
fi
echo "OK headlamp rollout Ready"

"$KUBECTL" get cronjob dispatch-watcher -n sandbox >/dev/null 2>&1 ||
  die_ns sandbox "dispatcher cronjob dispatch-watcher missing"
"$KUBECTL" get cronjob factory-orchestrator -n sandbox >/dev/null 2>&1 ||
  die_ns sandbox "factory cronjob factory-orchestrator missing"
echo "OK core CronJobs present"

echo "k8s-smoke: PASS — manifests admitted, RBAC/SA graph intact, smoke Job ran"
