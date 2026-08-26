#!/usr/bin/env bash
# Ensure the t3code proxy pod serves HTTPS with real tailnet certs and points
# at the current app pod IP. Idempotent; run via the serve-fixer loop or by hand.
#
# Why this exists: the operator (1.102.3) provisions the proxy's serve config
# once, HTTP-only, targeting whatever pod IP existed at provisioning time. It
# neither refreshes the IP on rollout nor enables TLS. This script fixes both.
set -euo pipefail

TS_NS="tailscale"
SVC_NS="agents"
HOST="t3code-0"

APP_IP=$(kubectl get pod "${HOST}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}')
PROXY_POD=$(kubectl get pods -n "$TS_NS" --no-headers | grep "ts-${HOST}" | awk '$3=="Running"{print $1}' | head -1)
[ -n "${PROXY_POD}" ] || { echo "no running proxy pod" >&2; exit 1; }

# Serve config: HTTPS on 443 -> app :3773. `tailscale serve` obtains/renews
# the *.ts.net cert automatically once enabled.
if kubectl exec -n "$TS_NS" "$PROXY_POD" -- sh -c \
     "test \"\$(tailscale serve status 2>/dev/null | grep -c 'https://${HOST}')\" -gt 0" 2>/dev/null; then
  echo "HTTPS serve already configured"
else
  echo "configuring HTTPS serve for ${HOST}..."
  kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve --bg --https=443 "http://${APP_IP}:3773" >/dev/null
fi
echo "done: https://${HOST}.tailc3cc03.ts.net -> ${APP_IP}:3773"
