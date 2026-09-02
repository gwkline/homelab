#!/bin/sh
# Timed driver for the bare-machine fast-recovery drill (issue #34).
#
# Runs every documented cluster bring-up stage in order, times each stage,
# and prints the recovery-time table for the drill log in
# docs/rebuild-runbook.md ("Drill log"). It exercises the same scripts and
# Kubernetes manifests the runbook documents — no hidden state, no manual
# fixes: if a stage fails, the drill fails and the fix must become a
# runbook step or a follow-up issue before the next attempt.
#
# Node bootstrap (OS install through `bootstrap/bootstrap.sh server` up to a
# Ready node) is interactive and cannot be scripted; record its wall time and
# pass the drill-start timestamp with --from so the printed total covers the
# whole drill. Without --from the script reports the cluster phase only.
#
# Required environment — documented external sources only (see
# docs/rebuild-runbook.md); nothing is read from an old cluster:
#   KUBECONFIG                kubeconfig of the fresh cluster (node Ready)
#   TS_CLIENT_ID              Tailscale OAuth client id (deploy/tailscale/README.md)
#   TS_CLIENT_SECRET          Tailscale OAuth client secret (same source)
#   OP_SERVICE_ACCOUNT_TOKEN  1Password service-account token (homelab vault)
#
# Usage: ./scripts/recovery-drill.sh [--from <unix-epoch>]
set -eu

# Pinned Tailscale operator chart version: the PROXY_TAGS workaround in
# deploy/tailscale/README.md and scripts/rebuild-check.sh section 7 are
# tested against it. k3s itself is pinned at bootstrap time (bootstrap.sh).
TS_CHART_VERSION=1.102.3

POD_TIMEOUT=600s
PROXY_TIMEOUT=480s

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

usage() {
  echo "usage: $0 [--from <unix-epoch>]" >&2
  exit 2
}

FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      [ $# -ge 2 ] || usage
      case "$2" in
        '' | *[!0-9]*) usage ;;
      esac
      FROM="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
command -v helm >/dev/null 2>&1 || fail "helm not found (docs/runbook-server-cluster.md section 5)"
[ -n "${TS_CLIENT_ID:-}" ] || fail "TS_CLIENT_ID unset — documented source: deploy/tailscale/README.md"
[ -n "${TS_CLIENT_SECRET:-}" ] || fail "TS_CLIENT_SECRET unset — documented source: deploy/tailscale/README.md"
[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || fail "OP_SERVICE_ACCOUNT_TOKEN unset — documented source: docs/rebuild-runbook.md (secrets)"

cd "$(dirname "$0")/.." || exit 1

kubectl get nodes >/dev/null 2>&1 ||
  fail "cluster unreachable — run bootstrap/bootstrap.sh server first, then export KUBECONFIG"

RESULT_FILE=$(mktemp)
trap 'rm -f "$RESULT_FILE"' EXIT INT TERM
STAGE=""
STAGE_START=0

stage() {
  STAGE=$1
  STAGE_START=$(date +%s)
  printf '==> [%s] start\n' "$STAGE"
}

end_stage() {
  _now=$(date +%s)
  _elapsed=$((_now - STAGE_START))
  printf '%s %s\n' "$STAGE" "$_elapsed" >>"$RESULT_FILE"
  printf '==> [%s] done in %ss\n' "$STAGE" "$_elapsed"
}

# ---------------------------------------------------------------------------
stage operator
helm repo add tailscale https://pkgs.tailscale.com/helmcharts >/dev/null 2>&1 || true
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --version "$TS_CHART_VERSION" \
  --set oauth.clientId="$TS_CLIENT_ID" \
  --set oauth.clientSecret="$TS_CLIENT_SECRET"
kubectl -n tailscale rollout status deploy/operator --timeout="$PROXY_TIMEOUT"
kubectl -n tailscale set env deploy/operator PROXY_TAGS=tag:k8s-operator
kubectl -n tailscale rollout restart deploy/operator
kubectl -n tailscale rollout status deploy/operator --timeout="$PROXY_TIMEOUT"
end_stage

# ---------------------------------------------------------------------------
stage namespaces
kubectl apply -f deploy/namespaces.yaml
kubectl apply -k deploy/policies/base
end_stage

# ---------------------------------------------------------------------------
stage secrets
kubectl -n agents create secret generic onepassword-service-account \
  --from-file=token="$OP_SERVICE_ACCOUNT_TOKEN"
kubectl -n sandbox create secret generic onepassword-service-account \
  --from-file=token="$OP_SERVICE_ACCOUNT_TOKEN"
kubectl apply -k deploy/github-tokens/base
if kubectl get crd externalsecrets.external-secrets.io >/dev/null 2>&1; then
  kubectl -n agents wait --for=condition=Ready externalsecret/github-token --timeout=120s ||
    echo "WARN: github-token not synced yet (1Password item github-readonly present?)" >&2
else
  echo "WARN: External Secrets Operator not installed (issue #38) — github-token stays Pending and private-repo clones fail until it lands" >&2
fi
end_stage

# ---------------------------------------------------------------------------
stage workloads
kubectl apply -k deploy/tailscale
kubectl apply -k deploy/t3code/base
kubectl apply -k deploy/hermes/base
kubectl apply -k deploy/loop-agent/base
kubectl apply -k deploy/homepage/base
kubectl apply -k deploy/panel/base
kubectl apply -k deploy/dispatcher/base
kubectl apply -k deploy/factory/base
end_stage

# ---------------------------------------------------------------------------
stage pods
kubectl -n agents rollout status statefulset/t3code --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status statefulset/hermes --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status deploy/panel --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status deploy/homepage --timeout="$POD_TIMEOUT"
kubectl -n sandbox get cronjob dispatch-watcher >/dev/null ||
  fail "dispatcher cronjob dispatch-watcher missing"
end_stage

# ---------------------------------------------------------------------------
stage https
TAILNET_NAME="${TAILNET_NAME:-}"
if [ -z "$TAILNET_NAME" ]; then
  _lb=$(kubectl get svc t3code-0 -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
  TAILNET_NAME=${_lb#"t3code-0."}
fi
[ -n "$TAILNET_NAME" ] || fail "cannot determine tailnet suffix (set TAILNET_NAME)"

_proxy_tries=0
until ./scripts/serve-https.sh && ./scripts/serve-refresh.sh panel agents; do
  _proxy_tries=$((_proxy_tries + 1))
  [ "$_proxy_tries" -lt 20 ] || fail "tailscale proxy pods never became ready"
  sleep 15
done

for _host in "t3code-0" "panel"; do
  _code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "https://${_host}.${TAILNET_NAME}/")
  case "$_code" in
    2?? | 3??) echo "https://${_host}.${TAILNET_NAME}/ -> ${_code}" ;;
    *) fail "https://${_host}.${TAILNET_NAME}/ -> ${_code}" ;;
  esac
done
end_stage

# ---------------------------------------------------------------------------
stage smoke
./scripts/rebuild-check.sh
end_stage

# ---------------------------------------------------------------------------
_total=0
while read -r _name _secs; do
  _total=$((_total + _secs))
  printf '%-12s %6ss\n' "$_name" "$_secs"
done <"$RESULT_FILE"
printf '%-12s %6ss\n' "TOTAL" "$_total"

printf '\nRTO (cluster phase, this machine): %ss\n' "$_total"
if [ -n "$FROM" ]; then
  printf 'RTO (from recorded drill start):   %ss\n' "$(( $(date +%s) - FROM ))"
fi

cat >&2 <<'EOF'

Record in docs/rebuild-runbook.md "Drill log":
- the RTO line(s) above plus node-bootstrap wall time if --from was not used
- PVC decision: restored from B2 (record observed RPO = newest snapshot age,
  docs/runbook-server-cluster.md section 11) or intentionally recreated
- every manual step you had to do that the runbook does not document —
  each one becomes a runbook step or a follow-up issue before the next run
- the pinned versions used: k3s (bootstrap.sh) and Tailscale operator chart
EOF
