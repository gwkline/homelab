#!/bin/sh
# Timed cluster bring-up for the recovery drill (docs/rebuild-runbook.md
# steps 3.2-3.8). Run after bootstrap/bootstrap.sh server has a Ready node.
#
# Usage: ./scripts/recovery-drill.sh [--from <unix-epoch>]
#   --from  drill start time, so the total includes node bootstrap
# Needs kubectl + helm, KUBECONFIG for the new cluster, and the 1Password
# service-account token (OP_SERVICE_ACCOUNT_TOKEN, or pasted at the prompt).
set -eu

# renovate: datasource=helm depName=tailscale-operator registryUrl=https://pkgs.tailscale.com/helmcharts
TS_CHART_VERSION=1.102.3
# renovate: datasource=helm depName=policy-controller registryUrl=https://sigstore.github.io/helm-charts
POLICY_CHART_VERSION=0.10.7

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
command -v helm >/dev/null 2>&1 || fail "helm not found"

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
stage eso
kubectl apply --server-side -k deploy/eso/base
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/clustersecretstores.external-secrets.io \
  --timeout=180s
kubectl -n external-secrets rollout status deploy/external-secrets-webhook --timeout="$POD_TIMEOUT"
kubectl -n external-secrets rollout status deploy/external-secrets --timeout="$POD_TIMEOUT"
end_stage

# ---------------------------------------------------------------------------
stage secrets
kubectl apply -k deploy/namespaces
./scripts/create-onepassword-service-account.sh
end_stage

# ---------------------------------------------------------------------------
# Admission webhook must serve before any homelab pod is admitted (ADR-004).
stage image-policy
helm repo add sigstore https://sigstore.github.io/helm-charts >/dev/null 2>&1 || true
helm upgrade --install policy-controller sigstore/policy-controller \
  --namespace cosign-system --create-namespace \
  --version "$POLICY_CHART_VERSION"
kubectl -n cosign-system rollout status deploy/policy-controller-webhook --timeout="$PROXY_TIMEOUT"
end_stage

# ---------------------------------------------------------------------------
stage cnpg
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io \
  --timeout=180s
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager \
  --timeout="$POD_TIMEOUT"
end_stage

# ---------------------------------------------------------------------------
stage workloads
kubectl apply -k clusters/home
kubectl -n agents wait --for=condition=Ready externalsecret/github-token --timeout=120s ||
  echo "WARN: github-token not synced yet (1Password item github-readonly present?)" >&2
end_stage

# ---------------------------------------------------------------------------
# After the core set, which syncs Secret operator-oauth from 1Password.
stage operator
helm repo add tailscale https://pkgs.tailscale.com/helmcharts >/dev/null 2>&1 || true
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --version "$TS_CHART_VERSION" \
  -f deploy/tailscale/values.yaml
kubectl -n tailscale rollout status deploy/operator --timeout="$PROXY_TIMEOUT"
# values.yaml makes this the default; no proxy starts until it exists.
kubectl apply -f deploy/tailscale/proxyclass.yaml
# Every operator namespace exists now: default-deny their ingress (3.7).
kubectl apply -k deploy/operator-policies/base
end_stage

# ---------------------------------------------------------------------------
stage pods
kubectl -n agents rollout status statefulset/t3code --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status statefulset/hermes --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status deploy/panel --timeout="$POD_TIMEOUT"
kubectl -n agents rollout status deploy/homepage --timeout="$POD_TIMEOUT"
end_stage

# ---------------------------------------------------------------------------
stage https
for _ing in "t3code-0" "panel"; do
  _tries=0
  while :; do
    _host=$(kubectl get ingress "$_ing" -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null) || true
    [ -n "$_host" ] && break
    _tries=$((_tries + 1))
    [ "$_tries" -lt 20 ] || fail "ingress agents/${_ing} never got a tailnet hostname"
    sleep 15
  done
  _code=$(curl -s -m 30 -o /dev/null -w "%{http_code}" "https://${_host}/") || true
  case "$_code" in
    2?? | 3??) echo "https://${_host}/ -> ${_code}" ;;
    *) fail "https://${_host}/ -> ${_code}" ;;
  esac
done
end_stage

# ---------------------------------------------------------------------------
# rebuild-check wants a recent deployer success; the first run lands within
# five minutes of the core set.
stage deployer
_tries=0
until [ -n "$(kubectl -n agents get cronjob deployer -o jsonpath='{.status.lastSuccessfulTime}' 2>/dev/null)" ]; do
  _tries=$((_tries + 1))
  [ "$_tries" -lt 48 ] || fail "deployer has not succeeded within 12 minutes: kubectl -n agents get pods -l app=deployer"
  sleep 15
done
end_stage

# ---------------------------------------------------------------------------
# Cluster phase only: the hermes gateway needs the manual portal login (3.10).
stage smoke
./scripts/rebuild-check.sh --phase cluster
end_stage

# ---------------------------------------------------------------------------
_total=0
while read -r _name _secs; do
  _total=$((_total + _secs))
  printf '%-12s %6ss\n' "$_name" "$_secs"
done <"$RESULT_FILE"
printf '%-12s %6ss\n' "TOTAL" "$_total"

printf '\nRTO (cluster phase): %ss\n' "$_total"
if [ -n "$FROM" ]; then
  printf 'RTO (from drill start): %ss\n' "$(($(date +%s) - FROM))"
fi

echo 'Record the run in docs/rebuild-runbook.md "Drill log", including every manual step.' >&2
