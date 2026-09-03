#!/bin/sh
# Converge the t3code proxy's serve config so HTTPS on 443 — the supported
# endpoint, the URL users open — targets the app pod's CURRENT IP (issue
# #11). Why this exists: the operator (1.102.3) provisions the proxy's serve
# config once, HTTP-only, targeting whatever pod IP existed at provisioning
# time; it neither refreshes the IP on rollout nor enables TLS.
#
# This file is the single implementation of that repair: run by hand, by the
# recovery drill, and by the serve-fixer loop (the Deployment mounts the
# t3code-serve-fixer ConfigMap copy of it; scripts/serve-fixer-check.sh
# fails when the ConfigMap copy and this file drift apart).
set -eu

TS_NS="tailscale"
SVC_NS="agents"
HOST="t3code-0"
PORT="3773"
# Least privilege (issue #32): the proxy pod is discovered via the
# operator's parent-resource labels, and the name guard below is a second,
# independent check — this can only ever select the t3code proxy StatefulSet
# pod, never the operator pod or another service's proxy.
PROXY_SEL="tailscale.com/parent-resource=${HOST},tailscale.com/parent-resource-ns=${SVC_NS},tailscale.com/parent-resource-type=svc"

# app pod IP (StatefulSet => stable name)
APP_IP=$(kubectl get pod "${HOST}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}' 2>/dev/null) || true
[ -n "${APP_IP}" ] || { echo "pod ${HOST} has no IP yet" >&2; exit 1; }

PROXY_POD=$(kubectl get pods -n "${TS_NS}" -l "${PROXY_SEL}" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || true
case "${PROXY_POD}" in
  ts-"${HOST}"-*) : ;;
  *) echo "no running proxy pod for ${HOST}" >&2; exit 1 ;;
esac

CURRENT=$(kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve status 2>/dev/null) || true

# Drift check examines the HTTPS handler only (issue #11): the first
# http://IP:PORT backend printed under the https:// handler line. A
# matching backend under a leftover http:// handler — or any other backend
# line — must not count as healthy.
HTTPS_BACKEND=$(printf '%s\n' "${CURRENT}" \
  | sed -n '/^https:\/\//,/^[^[:space:]]/p' \
  | grep -oE 'http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' \
  | head -1)

if [ "${HTTPS_BACKEND:-}" = "http://${APP_IP}:${PORT}" ]; then
  echo "https serve entry for ${HOST} already targets ${APP_IP}:${PORT}; nothing to do"
else
  echo "configuring https serve for ${HOST}: ${HTTPS_BACKEND:-<no https handler>} -> ${APP_IP}:${PORT}"
  # `tailscale serve` obtains/renews the *.ts.net cert automatically once
  # the https handler is configured.
  kubectl exec -n "${TS_NS}" "${PROXY_POD}" -- tailscale serve --bg --https=443 "http://${APP_IP}:${PORT}" >/dev/null
  echo "re-pointed https serve entry for ${HOST} at ${APP_IP}:${PORT}"
fi

# Tailnet DNS suffix (e.g. tailabc1234.ts.net). One documented value
# (deploy/tailscale/README.md): override with TAILNET_NAME, otherwise it is
# discovered from the Service's own operator-assigned LB hostname.
# Best-effort: the converge above is the job — the least-privileged fixer
# identity cannot read Services, so it runs without the final URL line.
TAILNET_NAME="${TAILNET_NAME:-}"
if [ -z "${TAILNET_NAME}" ]; then
  LB_HOST=$(kubectl get svc "${HOST}" -n "${SVC_NS}" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null) || true
  TAILNET_NAME=${LB_HOST#"${HOST}."}
fi
if [ -n "${TAILNET_NAME}" ]; then
  echo "done: https://${HOST}.${TAILNET_NAME} -> ${APP_IP}:${PORT}"
else
  echo "warn: tailnet suffix unknown (set TAILNET_NAME); https serve config is converged" >&2
fi
