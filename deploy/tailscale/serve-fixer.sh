#!/bin/bash
# Self-healing serve config for the t3code tailscale proxy pod.
# Runs as a sidecar-ish loop: whenever t3code's pod IP changes (restart,
# reschedule), re-points `tailscale serve` at the new IP. This works around
# the operator provisioning serve config with a stale pod IP and not
# refreshing it on StatefulSet pod replacement (observed on operator
# 1.102.x / k3s v1.36).
# Deployed via a small Deployment in the tailscale namespace using the same
# serviceaccount; uses `kubectl exec` into the proxy pod. Simple, visible, removable.
set -euo pipefail

SVC_NS="agents"
SVC_NAME="t3code-0"
TS_NS="tailscale"

while true; do
  # app pod IP (StatefulSet => stable name)
  APP_IP=$(kubectl get pod "${SVC_NAME}" -n "${SVC_NS}" -o jsonpath='{.status.podIP}' 2>/dev/null || true)
  if [ -z "$APP_IP" ]; then echo "waiting for ${SVC_NAME}..."; sleep 15; continue; fi

  PROXY_POD=$(kubectl get pods -n "$TS_NS" --no-headers | grep "ts-${SVC_NAME}" | awk '$3=="Running"{print $1}' | head -1)
  if [ -z "$PROXY_POD" ]; then echo "waiting for proxy pod..."; sleep 15; continue; fi

  CURRENT=$(kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve status 2>/dev/null || true)
  if ! echo "$CURRENT" | grep -q "proxy http://${APP_IP}:3773"; then
    echo "$(date -u +%H:%M:%S) fixing serve -> ${APP_IP}:3773"
    kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve --bg --http=80 "http://${APP_IP}:3773" >/dev/null 2>&1 || true
  fi
  sleep 30
done
