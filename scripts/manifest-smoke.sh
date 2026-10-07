#!/bin/sh
# Manifest smoke test against a real API server (issue #16).
#
# `kubectl kustomize` renders YAML; it cannot catch RoleBindings whose roleRef
# points nowhere, ServiceAccounts referenced from another namespace, or pods
# the scheduler/PSA/token-projection reject. This script submits the rendered
# normal manifest set (clusters/home/base, minus explicitly skipped externals)
# to a disposable kind cluster pinned to the production Kubernetes version
# (k3s v1.36.4+k3s1, docs/rebuild-runbook.md), then proves at runtime:
#   - every (Cluster)RoleBinding roleRef resolves to an existing role
#   - every referenced ServiceAccount exists (bindings + pod templates)
#   - key ServiceAccount permissions match the RBAC intent (auth can-i)
#   - a purpose-built sandbox Job runs: token mounted, container exits 0
#   - core public-image Deployments become Available
#
# External integrations are skipped with explicit reasons (SKIP lines):
# ESO/1Password, tailscale operator, policy-controller (cosign), CNPG
# operator, private GHCR images, GitHub.
#
# Usage:
#   ./scripts/manifest-smoke.sh
#   SMOKE_REUSE=1 ./scripts/manifest-smoke.sh   # use the current kubectl context
#   SMOKE_KEEP=1 ./scripts/manifest-smoke.sh    # keep the cluster on failure
set -eu

cd "$(dirname "$0")/.."

# Pinned to the production Kubernetes minor (k3s v1.36.4+k3s1); digest is the
# kind v0.33.0 release-notes entry for v1.36.4.
KIND_NODE="${SMOKE_KIND_NODE:-kindest/node:v1.36.4@sha256:099e049362a1526b2db71494e1947aae99bd16290d7c895f2b7ea312e3cbfaed}"
KUBE_MINOR="1.36"
KIND_CLUSTER="${SMOKE_KIND_CLUSTER:-manifest-smoke}"
WAIT_DEPLOY="${SMOKE_WAIT_DEPLOY:-kube-state-metrics,homepage,headlamp}"
DEPLOY_WAIT="${SMOKE_DEPLOY_WAIT:-300s}"
JOB_WAIT="${SMOKE_JOB_WAIT:-180s}"
# Namespaces the rendered set creates or lands in (deploy/namespaces,
# deploy/tailscale/namespace.yaml); objects anywhere else are out of scope.
MANAGED_NS="agents sandbox work database tailscale"

KUBECONFIG_PATH="${TMPDIR:-/tmp}/manifest-smoke-kubeconfig"
KIND_CREATED=""
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/manifest-smoke.XXXXXX")"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

dump_diagnostics() {
  echo "----- events (last 60) -----" >&2
  kubectl get events -A --sort-by=.lastTimestamp 2>/dev/null | tail -60 >&2 || true
  echo "----- pods not Running/Completed -----" >&2
  kubectl get pods -A -o wide 2>/dev/null |
    awk 'NR == 1 || ($4 != "Running" && $4 != "Completed")' >&2 || true
  echo "----- smoke canary Job -----" >&2
  kubectl describe job manifest-smoke-canary -n sandbox >&2 || true
  kubectl get pods -n sandbox -l app=manifest-smoke-canary -o wide >&2 || true
  kubectl logs -n sandbox -l app=manifest-smoke-canary --tail=-1 >&2 || true
  echo "----- watched deployments -----" >&2
  kubectl get deployments -n agents -o wide >&2 || true
}

cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    dump_diagnostics
  fi
  if [ "${SMOKE_KEEP:-0}" = "1" ]; then
    echo "==> SMOKE_KEEP=1 — kept the cluster"
  elif [ -n "$KIND_CREATED" ]; then
    echo "==> deleting disposable kind cluster ${KIND_CLUSTER}"
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1 || true
  fi
  rm -f "$KUBECONFIG_PATH"
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

echo "==> [1/7] preconditions"
command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
if [ "${SMOKE_REUSE:-0}" = "1" ]; then
  kubectl get namespace kube-system >/dev/null 2>&1 ||
    fail "SMOKE_REUSE=1 but kubectl cannot reach a cluster"
  echo "  reusing current kubectl context"
else
  command -v docker >/dev/null 2>&1 || fail "docker not found (or set SMOKE_REUSE=1)"
  command -v kind >/dev/null 2>&1 || fail "kind not found (or set SMOKE_REUSE=1)"
fi

echo "==> [2/7] rendering the normal manifest set"
kubectl kustomize clusters/home/base >"$WORKDIR/root.yaml" ||
  fail "kustomize build: clusters/home/base"
# CRDs vendored in-repo: rendered upstream installs, trimmed to their CRD
# documents. The controllers behind them stay external (SKIP lines below);
# the CRDs alone let the API server schema-validate the CR instances the
# root set submits (ExternalSecret specs, CNPG Cluster specs, ...).
crds_file="$WORKDIR/crds-all.yaml"
: >"$crds_file"
for base in deploy/eso/base deploy/cnpg/base; do
  kubectl kustomize "$base" >"$WORKDIR/src.yaml" || fail "kustomize build: $base"
  awk '
    function flush() {
      if (buf == "") return
      if (k == "CustomResourceDefinition") { kept++; printf "%s", buf } else { dropped++ }
      buf = ""; k = ""
    }
    BEGIN { buf = "" }
    /^---/ { flush(); buf = "---\n"; k = ""; next }
    { buf = buf $0 "\n"; if (k == "" && $0 ~ /^kind:/) { k = $2 } }
    END { flush(); printf "  %s: kept %d CRDs, skipped %d other docs (controller is external)\n", src, kept, dropped > "/dev/stderr" }
  ' src="$base" "$WORKDIR/src.yaml" >>"$crds_file"
done
crd_count="$(grep -c '^kind: CustomResourceDefinition' "$crds_file" || true)"
# drop_docs <kind> <reason>: remove matching documents, one SKIP line each.
drop_docs() {
  awk -v kind="$1" -v reason="$2" '
    function flush() {
      if (buf == "") return
      if (k == kind) {
        skipped++
        printf "SKIP: %s %s — %s\n", kind, nm, reason > "/dev/stderr"
      } else {
        printf "%s", buf
      }
      buf = ""; k = ""; nm = ""
    }
    BEGIN { buf = "" }
    /^---/ { flush(); buf = "---\n"; k = ""; nm = ""; next }
    {
      buf = buf $0 "\n"
      if (k == "" && $0 ~ /^kind:/) { k = $2; gsub(/[[:space:]]/, "", k) }
      if (nm == "" && $0 ~ /^  name:/) { nm = $2; gsub(/[[:space:]]/, "", nm) }
    }
    END { flush() }
  '
}
# policy-controller is helm-installed in production; its CRD is not vendored
# and its webhook (cosign/fulcio/rekor) is external, so the policy instance
# is not submitted here (docs/adr/adr-004-cosign-admission-verification.md).
drop_docs ClusterImagePolicy \
  'policy-controller (cosign) is helm-installed in production; CRD not vendored, webhook external' \
  <"$WORKDIR/root.yaml" >"$WORKDIR/apply.yaml"
docs="$(grep -c '^kind:' "$WORKDIR/apply.yaml" || true)"
echo "  rendered ${docs:-0} objects; ${crd_count:-0} vendored CRDs"

echo "==> [3/7] disposable kind cluster (v${KUBE_MINOR}.x API server, matching production k3s)"
if [ "${SMOKE_REUSE:-0}" != "1" ]; then
  if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    # CI pre-creates the cluster (kind-action); it dies with the runner.
    echo "  reusing pre-created kind cluster ${KIND_CLUSTER}"
  else
    export KUBECONFIG="$KUBECONFIG_PATH"
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1 || true
    kind create cluster --name "$KIND_CLUSTER" --image "$KIND_NODE" --wait 180s >/dev/null 2>&1 ||
      fail "kind create cluster failed"
    KIND_CREATED=1
  fi
fi
server_version="$(kubectl get --raw /version | sed -n 's/.*"gitVersion": "\([^"]*\)".*/\1/p')"
server_minor="$(printf '%s' "$server_version" | sed -E 's/^v([0-9]+\.[0-9]+).*/\1/')"
[ "$server_minor" = "$KUBE_MINOR" ] ||
  fail "API server is v${server_minor}.x; the pinned node image must be v${KUBE_MINOR}.x (production k3s)"
echo "  cluster up: API server $server_version"

echo "==> [4/7] submitting ${docs:-0} objects + ${crd_count:-0} CRDs to the real API server"
kubectl apply --server-side --field-manager=manifest-smoke -f "$crds_file" >/dev/null ||
  fail "vendored CRD apply failed (see kubectl error above)"
kubectl apply --server-side --field-manager=manifest-smoke -f "$WORKDIR/apply.yaml" >/dev/null ||
  fail "manifest apply failed (see kubectl error above)"
echo "SKIP: ESO controller — only its vendored CRDs are installed, so ExternalSecret/SecretStore specs are schema-validated; the controller and the 1Password sync stay external (no token Secrets exist)"
echo "SKIP: CNPG operator — only its vendored CRDs are installed; postgres pods need the operator and storage, so the Cluster is not waited on"
echo "SKIP: tailscale operator — helm-installed in production against the tailnet; only its rendered Namespace/SecretStore/ExternalSecret are submitted (LoadBalancer Services stay pending)"

echo "==> [5/7] runtime RBAC integrity (roleRef targets + referenced ServiceAccounts)"
graph="$WORKDIR/rbac-graph.tsv"
# SA census first: the check below consumes the file in order.
{
  kubectl get serviceaccounts -A -o jsonpath='{range .items[*]}SA{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}'
  kubectl get roles -A -o jsonpath='{range .items[*]}ROLE{"\t"}{.metadata.namespace}{"\t"}{.metadata.name}{"\n"}{end}'
  kubectl get clusterroles -o jsonpath='{range .items[*]}CROLE{"\t"}{.metadata.name}{"\n"}{end}'
  kubectl get deployments,statefulsets,daemonsets -A -o jsonpath='{range .items[*]}SPEC{"\t"}{.metadata.namespace}{"\t"}{.spec.template.spec.serviceAccountName}{"\n"}{end}'
  kubectl get cronjobs -A -o jsonpath='{range .items[*]}SPEC{"\t"}{.metadata.namespace}{"\t"}{.spec.jobTemplate.spec.template.spec.serviceAccountName}{"\n"}{end}'
  kubectl get rolebindings -A -o jsonpath='{range .items[*]}BIND{"\t"}{.metadata.namespace}{"\t"}{.roleRef.kind}{"\t"}{.roleRef.name}{"\t"}{.metadata.name}{"\n"}{range .subjects[*]}SUBJ{"\t"}{.kind}{"\t"}{.name}{"\t"}{.namespace}{"\n"}{end}{end}'
  kubectl get clusterrolebindings -A -o jsonpath='{range .items[*]}CRB{"\t"}{.roleRef.kind}{"\t"}{.roleRef.name}{"\t"}{.metadata.name}{"\n"}{range .subjects[*]}SUBJ{"\t"}{.kind}{"\t"}{.name}{"\t"}{.namespace}{"\n"}{end}{end}'
} >"$graph"

awk -F'\t' -v managed="$MANAGED_NS" '
  BEGIN {
    n = split(managed, m, " ")
    for (i = 1; i <= n; i++) managed_ns[m[i]] = 1
    errs = 0
    cur_ns = ""
  }
  $1 == "SA" { sa[$2 "\t" $3] = 1; next }
  $1 == "ROLE" { if ($2 in managed_ns) role[$2 "\t" $3] = 1; next }
  $1 == "CROLE" { crole[$2] = 1; next }
  $1 == "SPEC" {
    if (!($2 in managed_ns)) next
    name = ($3 == "" ? "default" : $3)
    if (!(($2 "\t" name) in sa) && !(($2 "\t" name) in seen)) {
      print "  MISSING SA: pod template in " $2 " wants ServiceAccount " name
      seen[$2 "\t" name] = 1
      errs++
    }
    next
  }
  $1 == "BIND" || $1 == "CRB" {
    if ($1 == "BIND") {
      if (!($2 in managed_ns)) { cur_ns = "__skip__"; next }
      cur_ns = $2
      where = $2 "/" $5
      rk = $3; rn = $4
    } else {
      cur_ns = ""
      where = "cluster/" $4
      rk = $2; rn = $3
    }
    if (rk == "Role") {
      if (!((cur_ns "\t" rn) in role)) { print "  BROKEN RoleBinding " where ": roleRef Role " rn " does not exist in namespace " cur_ns; errs++ }
    } else if (rk == "ClusterRole") {
      if (!(rn in crole)) { print "  BROKEN binding " where ": roleRef ClusterRole " rn " does not exist"; errs++ }
    } else {
      print "  BROKEN binding " where ": roleRef kind " rk " (want Role or ClusterRole)"; errs++
    }
    next
  }
  $1 == "SUBJ" && cur_ns != "__skip__" {
    if ($2 != "ServiceAccount") next
    s_ns = $4
    if (s_ns == "") s_ns = cur_ns
    if (s_ns == "") { print "  BROKEN binding " where ": ServiceAccount subject " $3 " has no namespace"; errs++; next }
    if (!(s_ns in managed_ns)) next
    if (!((s_ns "\t" $3) in sa)) { print "  MISSING SA: binding " where " binds ServiceAccount " s_ns "/" $3 " which does not exist"; errs++ }
    next
  }
  END {
    if (errs == 0) print "  ok: every binding roleRef resolves; every referenced ServiceAccount exists"
    exit (errs > 0)
  }
' "$graph" || fail "RBAC integrity check failed (see BROKEN/MISSING lines above)"

echo "==> [6/7] ServiceAccount permission probes (kubectl auth can-i)"
can() {
  # tail -1: the answer is the last line; kubectl prints namespace-scope
  # warnings on stderr for cluster-scoped resources.
  can_got="$(kubectl auth can-i "$2" "$3" ${4:+-n "$4"} --as="system:serviceaccount:$1" 2>&1 || true)"
  can_got="$(printf '%s\n' "$can_got" | tail -n 1)"
  printf '  can-i %-8s %-16s as %-34s -> %s (expect %s)\n' "$2" "$3" "$1" "$can_got" "$5"
  [ "$can_got" = "$5" ] || CAN_FAIL=1
}
CAN_FAIL=0
can "agents:deployer" patch cronjobs agents yes
can "agents:deployer" patch statefulsets work yes
can "agents:deployer" create secrets agents no
can "agents:panel" create jobs sandbox yes
can "agents:panel" list pods "" yes
can "agents:panel" list secrets sandbox no
can "agents:hermes" get nodes "" yes
can "agents:hermes" create pods agents no
can "agents:t3code-readonly" list pods "" yes
can "agents:t3code-readonly" create pods agents no
can "sandbox:factory-orchestrator" create jobs sandbox yes
can "agents:kube-state-metrics" list deployments "" yes
can "agents:victoriametrics" get nodes/proxy "" yes
[ "$CAN_FAIL" -eq 0 ] || fail "permission probes failed (see output above)"

echo "==> [7/7] runtime fixtures"
echo "  applying the sandbox canary Job (purpose-built smoke fixture)"
kubectl apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: ServiceAccount
metadata:
  name: manifest-smoke-canary
  namespace: sandbox
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: manifest-smoke-canary
  namespace: sandbox
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: manifest-smoke-canary
  namespace: sandbox
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: manifest-smoke-canary
subjects:
  - kind: ServiceAccount
    name: manifest-smoke-canary
    namespace: sandbox
---
# Minimal admitted Job: proves the ServiceAccount resolves, the token is
# projected, and a container actually runs and exits 0 in sandbox (PSA
# baseline, default-deny ingress netpol).
apiVersion: batch/v1
kind: Job
metadata:
  labels:
    app: manifest-smoke-canary
  name: manifest-smoke-canary
  namespace: sandbox
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: manifest-smoke-canary
    spec:
      serviceAccountName: manifest-smoke-canary
      automountServiceAccountToken: true
      restartPolicy: Never
      securityContext:
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: canary
          image: busybox:1.36@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
          command:
            - sh
            - -c
            - "test -s /var/run/secrets/kubernetes.io/serviceaccount/namespace && echo smoke-canary-token-mounted"
          resources:
            requests: { cpu: 10m, memory: 16Mi }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
            readOnlyRootFilesystem: true
EOF
echo "  canary permission probes (the fixture binding must grant and deny exactly)"
can "sandbox:manifest-smoke-canary" get pods sandbox yes
can "sandbox:manifest-smoke-canary" list pods sandbox yes
can "sandbox:manifest-smoke-canary" create secrets sandbox no
can "sandbox:manifest-smoke-canary" delete pods sandbox no
[ "$CAN_FAIL" -eq 0 ] || fail "canary permission probes failed (see output above)"

kubectl wait --for=condition=complete job/manifest-smoke-canary -n sandbox --timeout="$JOB_WAIT" >/dev/null 2>&1 ||
  fail "smoke canary Job did not complete within $JOB_WAIT (diagnostics below)"
if kubectl logs -n sandbox -l app=manifest-smoke-canary --tail=-1 2>/dev/null | grep -q 'smoke-canary-token-mounted'; then
  echo "  ok: canary Job completed; the ServiceAccount token was projected into the container"
else
  echo "  note: canary logs unavailable (fake-node runtime?); Job completion is the enforced check"
fi
kubectl delete job manifest-smoke-canary -n sandbox --ignore-not-found >/dev/null

echo "  waiting for core public-image Deployments to become Available (max $DEPLOY_WAIT)"
if [ -n "$WAIT_DEPLOY" ]; then
  deploy_args=""
  # shellcheck disable=SC2086 # the wait list is a word list
  for d in $(echo "$WAIT_DEPLOY" | tr ',' ' '); do
    deploy_args="$deploy_args deploy/$d"
  done
  # shellcheck disable=SC2086 # the wait list is a word list
  if kubectl wait --for=condition=available $deploy_args -n agents --timeout="$DEPLOY_WAIT" >/dev/null 2>&1; then
    echo "  ok: $WAIT_DEPLOY Available"
  else
    kubectl get deployments -n agents -o wide >&2 || true
    fail "core Deployments did not become Available within $DEPLOY_WAIT (diagnostics below)"
  fi
fi

# Private repo images cannot be pulled from CI without registry auth: they are
# submitted and admitted, but never waited on.
private="$(kubectl get deployments,statefulsets -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}' |
  awk -F'\t' '/ghcr\.io\/gwkline\/homelab\// { printf "%s%s", (out ? ", " : ""), $1; out = 1 } END { print "" }')"
echo "SKIP: private GHCR images — admitted but not pullable without registry auth: ${private:-none}"
kubectl get cronjobs -A -o jsonpath='{range .items[*]}{.metadata.namespace}/{.metadata.name}{"\t"}{.spec.jobTemplate.spec.template.spec.containers[0].image}{"\n"}{end}' |
  awk -F'\t' '/ghcr\.io\/gwkline\/homelab\// { print "SKIP: private GHCR images — CronJob " $1 " is admitted but never fired on schedule here" }'

echo "PASS: rendered manifests admitted by a real v${KUBE_MINOR}.x API server; RBAC integrity, permission probes, and the sandbox canary Job all hold"
