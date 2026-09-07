#!/bin/sh
# Acceptance test: t3code HTTPS must recover on its own after a pod
# replacement (issue #24). Turns the observed stale-serve-backend workaround
# (the serve-fixer loop in deploy/tailscale) into a repeatable test instead
# of an anecdotal manual check.
#
# What it does:
#   1. records the current t3code-0 pod IP and verifies HTTPS returns 200
#   2. deletes the t3code-0 pod (statefulset/t3code replaces it) and waits
#      for a DIFFERENT IP
#   3. waits — invoking no manual repair script; the serve-fixer loop is the
#      only repairer — for HTTPS to return 200 again within the recovery
#      objective
#   4. verifies the proxy's serve status now points the https 443 handler at
#      the new pod IP
#
# Recovery objective: RECOVERY_SECONDS (default 120) counted from the moment
# the replacement pod reports its new IP. The fixer loop converges every
# ~30s, so typical recovery is ~60s. The exact command and the objective are
# documented in docs/rebuild-runbook.md section 4b.
#
# Environment: run from a machine with tailnet access and an admin kubeconfig
# (the recovery drill's environment). Requires a configured tailnet, so it
# runs manually rather than in GitHub-hosted CI.
#
# Disruptive: replaces the t3code-0 pod (in-flight t3 sessions drop) and
# changes nothing else. The test itself repairs nothing: if HTTPS does not
# come back on its own, that is a failed acceptance, not something to fix
# inline.
#
# Exit codes:
#   0  HTTPS recovered within the objective; serve config verified
#   1  environment or acceptance failure — diagnostics (serve-fixer logs,
#      proxy serve status, proxy pod logs) are printed before exit
set -eu

RECOVERY_SECONDS="${RECOVERY_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
TS_NS="tailscale"
SVC_NS="agents"
POD_NAME="t3code-0"
STATEFULSET="t3code"
PORT="3773"
FIXER_DEPLOY="t3code-serve-fixer"
# Same selection as scripts/serve-https.sh: the operator's parent-resource
# labels can only match the t3code proxy.
PROXY_SEL="tailscale.com/parent-resource=${POD_NAME},tailscale.com/parent-resource-ns=${SVC_NS},tailscale.com/parent-resource-type=svc"

APP_IP_OLD=""
APP_IP_NEW=""
PROXY_POD=""

case "${RECOVERY_SECONDS}" in
  '' | *[!0-9]*) echo "FAIL: RECOVERY_SECONDS must be a non-negative integer (got '${RECOVERY_SECONDS}')" >&2; exit 1 ;;
esac
case "${POLL_SECONDS}" in
  '' | *[!0-9]*) echo "FAIL: POLL_SECONDS must be a non-negative integer (got '${POLL_SECONDS}')" >&2; exit 1 ;;
esac

diagnostics() {
  echo
  echo "--- failure diagnostics (issue #24) ---"
  echo "== serve-fixer logs (kubectl -n ${TS_NS} logs deploy/${FIXER_DEPLOY}) =="
  kubectl -n "${TS_NS}" logs "deploy/${FIXER_DEPLOY}" --tail=100 2>&1 || true
  if [ -n "${PROXY_POD}" ]; then
    echo
    echo "== proxy serve status (pod ${PROXY_POD}) =="
    kubectl -n "${TS_NS}" exec "${PROXY_POD}" -- tailscale serve status 2>&1 || true
    echo
    echo "== proxy pod logs (kubectl -n ${TS_NS} logs ${PROXY_POD}) =="
    kubectl -n "${TS_NS}" logs "${PROXY_POD}" --all-containers --tail=100 2>&1 || true
  else
    echo
    echo "== no running proxy pod found for ${PROXY_SEL} =="
    kubectl -n "${TS_NS}" get pods -l "${PROXY_SEL}" -o wide 2>&1 || true
  fi
}

# Every failure path (explicit FAIL or set -e) prints the serve-fixer and
# proxy state before exiting, so the output is actionable on its own.
on_exit() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then diagnostics >&2; fi
}
trap on_exit EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

https_code() {
  curl -s -m 10 -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || true
}

# The https handler's first http://IP:PORT backend — the same parse
# scripts/serve-https.sh drift-checks (issue #11): a matching backend under
# a leftover http:// handler must not count as healthy.
https_backend() {
  kubectl -n "${TS_NS}" exec "${PROXY_POD}" -- tailscale serve status 2>/dev/null |
    sed -n '/^https:\/\//,/^[^[:space:]]/p' |
    grep -oE 'http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' |
    head -1
}

discover_proxy() {
  PROXY_POD=$(kubectl get pods -n "${TS_NS}" -l "${PROXY_SEL}" --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || PROXY_POD=""
  case "${PROXY_POD}" in
    ts-"${POD_NAME}"-*) : ;;
    *) PROXY_POD="" ;;
  esac
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"
kubectl get nodes >/dev/null 2>&1 || fail "cluster unreachable (set KUBECONFIG)"
kubectl get pod "${POD_NAME}" -n "${SVC_NS}" >/dev/null 2>&1 ||
  fail "pod ${POD_NAME} not found in ${SVC_NS}"

# The serve-fixer Deployment is the repairer under test: it must exist and be
# Available before the run (this test never repairs anything itself).
kubectl -n "${TS_NS}" wait --for=condition=Available "deploy/${FIXER_DEPLOY}" --timeout=30s >/dev/null 2>&1 ||
  fail "deploy/${FIXER_DEPLOY} is not Available (missing or scaled to zero?) — deploy/tailscale owns the repair; restore it before running this test"

TAILNET_NAME="${TAILNET_NAME:-}"
if [ -z "${TAILNET_NAME}" ]; then
  _lb=$(kubectl get svc "${POD_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  TAILNET_NAME=${_lb#"${POD_NAME}."}
fi
[ -n "${TAILNET_NAME}" ] || fail "cannot determine tailnet suffix (set TAILNET_NAME)"
URL="https://${POD_NAME}.${TAILNET_NAME}/"

# --- 1. record the current pod IP and prove baseline HTTPS health ----------
APP_IP_OLD=$(kubectl get pod "${POD_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
[ -n "${APP_IP_OLD}" ] || fail "pod ${POD_NAME} has no IP yet"
discover_proxy
echo "t3code pod IP (before): ${APP_IP_OLD}"
BASELINE_CODE=$(https_code)
case "${BASELINE_CODE}" in
  2?? | 3??) echo "baseline: ${URL} -> ${BASELINE_CODE}" ;;
  *) fail "baseline HTTPS not healthy (${URL} -> ${BASELINE_CODE}) — this test proves recovery from a pod replacement, not initial health" ;;
esac

# --- 2. replace the pod and wait for a different IP -------------------------
echo "deleting pod ${POD_NAME} (statefulset/${STATEFULSET} replaces it)..."
kubectl -n "${SVC_NS}" delete pod "${POD_NAME}" >/dev/null ||
  fail "could not delete pod ${POD_NAME}"
kubectl -n "${SVC_NS}" rollout status "statefulset/${STATEFULSET}" --timeout=600s >/dev/null ||
  fail "statefulset/${STATEFULSET} never became ready"

TRIES=0
while :; do
  APP_IP_NEW=$(kubectl get pod "${POD_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
  if [ -n "${APP_IP_NEW}" ] && [ "${APP_IP_NEW}" != "${APP_IP_OLD}" ]; then break; fi
  TRIES=$((TRIES + 1))
  [ "${TRIES}" -lt 40 ] ||
    fail "pod IP never changed from ${APP_IP_OLD} — inconclusive (a same-IP reschedule proves nothing about serve-config healing)"
  sleep "${POLL_SECONDS}"
done
RECOVERY_START=$(date +%s)
echo "pod replaced: ${APP_IP_OLD} -> ${APP_IP_NEW}"

# --- 3. wait for HTTPS 200 with no manual repair (fixer loop only) ----------
echo "waiting for HTTPS to recover on its own (objective ${RECOVERY_SECONDS}s from the new IP; fixer loop converges every ~30s)..."
LAST_CODE=""
RECOVERED_AT=""
while [ "$(date +%s)" -le "$((RECOVERY_START + RECOVERY_SECONDS))" ]; do
  LAST_CODE=$(https_code)
  case "${LAST_CODE}" in
    2?? | 3??)
      RECOVERED_AT=$(( $(date +%s) - RECOVERY_START ))
      break
      ;;
  esac
  sleep "${POLL_SECONDS}"
done
[ -n "${RECOVERED_AT}" ] ||
  fail "HTTPS did not return 200 within ${RECOVERY_SECONDS}s of the new pod IP (last code: ${LAST_CODE:-none}) — self-healing regression; this test invoked no repair"
echo "HTTPS recovered: ${URL} -> ${LAST_CODE} after ${RECOVERED_AT}s"

# --- 4. the proxy must point https 443 at the new IP -------------------------
discover_proxy
[ -n "${PROXY_POD}" ] || fail "no running proxy pod matching ${PROXY_SEL}"
BACKEND=$(https_backend)
echo "serve status after recovery (proxy pod ${PROXY_POD}):"
kubectl -n "${TS_NS}" exec "${PROXY_POD}" -- tailscale serve status 2>/dev/null || true
case "${BACKEND}" in
  "http://${APP_IP_NEW}:${PORT}")
    echo "https 443 handler targets the new pod IP: ${BACKEND}"
    ;;
  *)
    fail "proxy https handler points at '${BACKEND:-<none>}', expected http://${APP_IP_NEW}:${PORT}"
    ;;
esac

echo
echo "PASS: t3code HTTPS self-healed after pod replacement (issue #24)"
echo "  pod IP:        ${APP_IP_OLD} -> ${APP_IP_NEW}"
echo "  recovery time: ${RECOVERED_AT}s from the new pod IP (objective ${RECOVERY_SECONDS}s)"
echo "  https handler: 443 -> ${BACKEND}"
