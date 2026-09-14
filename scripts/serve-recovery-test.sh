#!/bin/sh
# Acceptance test for the tailscale HTTPS recovery flow (issue #24): proves
# that replacing the t3code-0 pod ends with HTTPS serving again through the
# automatic serve-fixer loop alone. The test itself never invokes a repair
# script (serve-https.sh / serve-refresh.sh) — if it has to, the test fails,
# because a manual repair is exactly what this test exists to rule out.
#
# Run from a machine with tailnet access and an admin kubeconfig (the
# recovery drill's environment), while HTTPS is currently healthy.
#
# What it does:
#   1. records the t3code-0 pod IP and the proxy's serve entry, then
#      verifies https://t3code-0.<tailnet>/ returns 200 (baseline)
#   2. deletes the t3code-0 pod; the StatefulSet replaces it with a new IP
#      (the serve-fixer Deployment stays running — it is the thing under
#      test; if it is not deployed, the operator's own automatic recovery
#      is tested instead)
#   3. waits for a different pod IP, then for BOTH the proxy's serve config
#      pointing the https 443 handler at the new IP AND
#      https://t3code-0.<tailnet>/ returning 200 again — within the
#      documented recovery objective (RECOVERY_OBJECTIVE, default 120s;
#      expected recovery ~30-60s at the fixer's 30s loop period)
#   4. on any failure prints the serve-fixer logs and the proxy's serve
#      status and logs before exiting 1
#
# Exit codes: 0 = recovery proven within the objective; 1 = failure
# (environment, baseline unhealthy, pod IP never changed, or objective
# exceeded) — the diagnostics section says which.
#
# Disruptive: replaces the t3code-0 pod once. Nothing else is modified.
set -u

RECOVERY_OBJECTIVE="${RECOVERY_OBJECTIVE:-120}"
STEP_SECONDS="${STEP_SECONDS:-10}"
TS_NS="tailscale"
SVC_NS="agents"
SVC_NAME="t3code-0"
FIXER_DEPLOY="t3code-serve-fixer"
PORT="3773"
PROXY_SEL="tailscale.com/parent-resource=${SVC_NAME},tailscale.com/parent-resource-ns=${SVC_NS},tailscale.com/parent-resource-type=svc"

discover_proxy() {
  kubectl get pods -n "${TS_NS}" -l "${PROXY_SEL}" --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

# The proxy's serve config must show the https 443 handler backed by the
# given pod IP. Same parse contract as scripts/serve-https.sh: the first
# http://IP:PORT backend printed under the https:// handler line — a
# backend under a leftover http:// handler does not count.
https_backend() {
  kubectl exec -n "${TS_NS}" "${1}" -- tailscale serve status 2>/dev/null |
    sed -n '/^https:\/\//,/^[^[:space:]]/p' |
    grep -oE 'http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' |
    head -1
}

dump_diagnostics() {
  echo
  echo "=== serve-fixer logs (kubectl logs -n ${TS_NS} deploy/${FIXER_DEPLOY}) ==="
  if kubectl -n "${TS_NS}" get "deploy/${FIXER_DEPLOY}" >/dev/null 2>&1; then
    kubectl -n "${TS_NS}" logs "deploy/${FIXER_DEPLOY}" --tail=50 2>&1 || true
  else
    echo "${FIXER_DEPLOY} not found — no fixer is running"
  fi
  PROXY_POD=$(discover_proxy)
  echo "=== proxy serve status (pod ${PROXY_POD:-<none>}) ==="
  if [ -n "${PROXY_POD}" ]; then
    kubectl -n "${TS_NS}" exec "${PROXY_POD}" -- tailscale serve status 2>&1 || true
    echo "=== proxy pod logs (${PROXY_POD}) ==="
    kubectl -n "${TS_NS}" logs "${PROXY_POD}" --tail=50 2>&1 || true
  else
    echo "no running proxy pod matching ${PROXY_SEL}"
  fi
}

die() {
  echo "FAIL: $1" >&2
  dump_diagnostics >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || die "kubectl not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
kubectl get nodes >/dev/null 2>&1 || die "cluster unreachable (set KUBECONFIG)"
kubectl get pod "${SVC_NAME}" -n "${SVC_NS}" >/dev/null 2>&1 ||
  die "pod ${SVC_NAME} not found in ${SVC_NS}"

TAILNET_NAME="${TAILNET_NAME:-}"
if [ -z "${TAILNET_NAME}" ]; then
  _lb=$(kubectl get svc "${SVC_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  TAILNET_NAME=${_lb#"${SVC_NAME}."}
fi
[ -n "${TAILNET_NAME}" ] || die "cannot determine tailnet suffix (set TAILNET_NAME)"
URL="https://${SVC_NAME}.${TAILNET_NAME}/"

# --- 1. baseline: record the current pod IP, require HTTPS 200 -------------
PROXY_POD=$(discover_proxy)
case "${PROXY_POD}" in
  ts-"${SVC_NAME}"-*) : ;;
  *) die "no running proxy pod matching ${PROXY_SEL}" ;;
esac

APP_IP_OLD=$(kubectl get pod "${SVC_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}')
[ -n "${APP_IP_OLD}" ] || die "pod ${SVC_NAME} has no IP yet"
echo "app pod IP: ${APP_IP_OLD}"
echo "serve status before (proxy pod ${PROXY_POD}):"
kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve status 2>/dev/null || true

_code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || true)
[ "${_code}" = "200" ] || die "baseline unhealthy: ${URL} -> ${_code} (need 200 before replacing the pod)"
echo "baseline: ${URL} -> 200"

# --- 2. replace the pod (no repair script runs; the fixer must heal) -------
if kubectl -n "${TS_NS}" get deploy "${FIXER_DEPLOY}" >/dev/null 2>&1; then
  echo "healer under test: ${FIXER_DEPLOY} (running, untouched)"
else
  echo "healer under test: ${FIXER_DEPLOY} not deployed — testing the operator's own automatic recovery"
fi
echo "replacing pod ${SVC_NAME}..."
T_DELETED=$(date +%s)
kubectl -n "${SVC_NS}" delete pod "${SVC_NAME}" >/dev/null
kubectl -n "${SVC_NS}" rollout status statefulset/t3code --timeout=600s >/dev/null ||
  die "statefulset/t3code never became ready"

TRIES=0
while :; do
  APP_IP=$(kubectl get pod "${SVC_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
  if [ -n "${APP_IP}" ] && [ "${APP_IP}" != "${APP_IP_OLD}" ]; then break; fi
  TRIES=$((TRIES + 1))
  [ "${TRIES}" -lt 40 ] || die "pod IP never changed from ${APP_IP_OLD} (inconclusive)"
  sleep 5
done
echo "pod replaced: ${APP_IP_OLD} -> ${APP_IP}"

# --- 3. recovery within the objective: 443 -> new IP AND HTTPS 200 ---------
echo "waiting for automatic recovery (objective ${RECOVERY_OBJECTIVE}s, expected ~30-60s)..."
T_DRIFT=$(date +%s)
while :; do
  PROXY_POD=$(discover_proxy)
  case "${PROXY_POD}" in
    ts-"${SVC_NAME}"-*) : ;;
    *) PROXY_POD="" ;;
  esac
  BACKEND=""
  [ -n "${PROXY_POD}" ] && BACKEND=$(https_backend "${PROXY_POD}")
  if [ "${BACKEND:-}" = "http://${APP_IP}:${PORT}" ]; then
    _code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || true)
    if [ "${_code}" = "200" ]; then
      RECOVERED=$(( $(date +%s) - T_DRIFT ))
      TOTAL=$(( $(date +%s) - T_DELETED ))
      echo
      echo "serve status after:"
      kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve status 2>/dev/null || true
      echo
      echo "PASS: ${URL} -> 200 with serve config ${BACKEND}"
      echo "recovery (new IP observed -> 200): ${RECOVERED}s of the ${RECOVERY_OBJECTIVE}s objective"
      echo "total (pod deleted -> 200): ${TOTAL}s"
      exit 0
    fi
  fi
  if [ "$(( $(date +%s) - T_DRIFT ))" -ge "${RECOVERY_OBJECTIVE}" ]; then
    die "recovery exceeded the ${RECOVERY_OBJECTIVE}s objective (last https backend: ${BACKEND:-<none>}, last code: ${_code:-none})"
  fi
  sleep "${STEP_SECONDS}"
done
