#!/bin/sh
# Retests whether the pinned Tailscale operator release refreshes a proxy's
# serve config when the app pod is replaced (issue #32), and re-verifies the
# HTTPS recovery flow from issue #24 afterwards. Run from a machine with
# tailnet access and an admin kubeconfig (the recovery drill's environment).
#
# What it does:
#   1. records the operator image, the t3code-0 pod IP, and the proxy's
#      serve entry
#   2. scales the t3code serve-fixer to zero so it cannot mask the result
#   3. deletes the t3code-0 pod; the StatefulSet replaces it with a new IP
#   4. watches `tailscale serve status` in the proxy for the NEW IP
#   5. restores the fixer and re-verifies HTTPS end-to-end (the #24 flow)
#
# Disruptive: replaces the t3code-0 pod and disables its auto-repair for
# the duration. Nothing else is modified.
#
# Outcomes:
#   exit 0  operator refreshed the serve config itself -> the workaround is
#           obsolete: delete deploy/tailscale and drop the fixer from the
#           recovery drill (update deploy/tailscale/README.md first)
#   exit 3  operator did not refresh within GRACE_SECONDS -> the workaround
#           is still necessary; fixers were restored and HTTPS verified
#   exit 1  environment or verification failure (pod never replaced, HTTPS
#           did not recover) — fix before trusting any verdict
#
# GRACE_SECONDS (default 300) bounds the operator watch window; the
# operator reconciles on a shared informer cadence, so a verdict of
# "still necessary" means "does not heal within the drill's recovery
# objective", not "never heals".
set -u

GRACE_SECONDS="${GRACE_SECONDS:-300}"
STEP_SECONDS="${STEP_SECONDS:-15}"
TS_NS="tailscale"
SVC_NS="agents"
SVC_NAME="t3code-0"
FIXER_DEPLOY="t3code-serve-fixer"
PORT="3773"
PROXY_SEL="tailscale.com/parent-resource=${SVC_NAME},tailscale.com/parent-resource-ns=${SVC_NS},tailscale.com/parent-resource-type=svc"
FIXER_DISABLED=0
SELF_HEAL=0

die() { echo "FAIL: $1" >&2; exit 1; }

cleanup() {
  if [ "${FIXER_DISABLED}" -eq 1 ]; then
    echo "restoring ${FIXER_DEPLOY}..."
    kubectl -n "${TS_NS}" scale deploy "${FIXER_DEPLOY}" --replicas=1 >/dev/null 2>&1 || true
    kubectl -n "${TS_NS}" rollout status "deploy/${FIXER_DEPLOY}" --timeout=120s >/dev/null 2>&1 || true
    FIXER_DISABLED=0
  fi
}
trap cleanup EXIT INT TERM

command -v kubectl >/dev/null 2>&1 || die "kubectl not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
kubectl get nodes >/dev/null 2>&1 || die "cluster unreachable (set KUBECONFIG)"
kubectl get pod "${SVC_NAME}" -n "${SVC_NS}" >/dev/null 2>&1 ||
  die "pod ${SVC_NAME} not found in ${SVC_NS}"

OP_IMAGE=$(kubectl -n "${TS_NS}" get deploy operator -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
echo "operator image: ${OP_IMAGE:-unknown}"

discover_proxy() {
  kubectl get pods -n "${TS_NS}" -l "${PROXY_SEL}" --field-selector=status.phase=Running \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

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

# --- 1. disable the fixer so it cannot mask the operator's behavior --------
if kubectl -n "${TS_NS}" get deploy "${FIXER_DEPLOY}" >/dev/null 2>&1; then
  kubectl -n "${TS_NS}" scale deploy "${FIXER_DEPLOY}" --replicas=0 >/dev/null
  kubectl -n "${TS_NS}" rollout status "deploy/${FIXER_DEPLOY}" --timeout=120s >/dev/null
  FIXER_DISABLED=1
  echo "disabled ${FIXER_DEPLOY}"
else
  echo "${FIXER_DEPLOY} not found — workaround already deleted; testing raw operator behavior"
fi

# --- 2. replace the app pod (StatefulSet recreates it with a new IP) -------
echo "replacing pod ${SVC_NAME}..."
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

# --- 3. does the operator re-point the serve config at the new IP? ---------
echo "watching proxy serve config for the new IP (grace ${GRACE_SECONDS}s)..."
TRIES=0
while [ "${TRIES}" -le "$((GRACE_SECONDS / STEP_SECONDS))" ]; do
  PROXY_POD=$(discover_proxy)
  case "${PROXY_POD}" in
    ts-"${SVC_NAME}"-*) : ;;
    *) PROXY_POD="" ;;
  esac
  if [ -n "${PROXY_POD}" ] &&
    kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve status 2>/dev/null |
      grep -q "proxy http://${APP_IP}:${PORT}"; then
    echo "operator re-pointed the serve config at ${APP_IP} after ~$((TRIES * STEP_SECONDS))s"
    SELF_HEAL=1
    break
  fi
  TRIES=$((TRIES + 1))
  sleep "${STEP_SECONDS}"
done

# --- 4. restore the fixer, then re-verify HTTPS end-to-end (#24) -----------
cleanup
TAILNET_NAME="${TAILNET_NAME:-}"
if [ -z "${TAILNET_NAME}" ]; then
  _lb=$(kubectl get svc "${SVC_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)
  TAILNET_NAME=${_lb#"${SVC_NAME}."}
fi
[ -n "${TAILNET_NAME}" ] || die "cannot determine tailnet suffix (set TAILNET_NAME)"

URL="https://${SVC_NAME}.${TAILNET_NAME}/"
TRIES=0
while :; do
  _code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "${URL}" 2>/dev/null || true)
  case "${_code}" in
    2?? | 3??)
      echo "HTTPS recovered: ${URL} -> ${_code}"
      break
      ;;
  esac
  TRIES=$((TRIES + 1))
  [ "${TRIES}" -lt 8 ] || die "HTTPS did not recover (${URL} -> ${_code}); fixer logs: kubectl logs -n ${TS_NS} deploy/${FIXER_DEPLOY}"
  sleep 15
done

echo "serve status after:"
PROXY_POD=$(discover_proxy)
kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve status 2>/dev/null || true

if [ "${SELF_HEAL}" -eq 1 ]; then
  echo
  echo "VERDICT: operator ${OP_IMAGE:-<unknown>} refreshed the serve config on pod replacement."
  echo "The serve-fixer workaround is obsolete: delete deploy/tailscale, drop it from"
  echo "scripts/recovery-drill.sh, and update deploy/tailscale/README.md (issue #32)."
  exit 0
fi

echo
echo "VERDICT: operator ${OP_IMAGE:-<unknown>} did NOT refresh the serve config within ${GRACE_SECONDS}s."
echo "The serve-fixer workaround is still necessary (exit 3)."
exit 3
