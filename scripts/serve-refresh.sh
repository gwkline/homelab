#!/usr/bin/env bash
# Re-point an exposed app's tailscale serve entry at its current pod IP.
#
# Why this exists: the tailscale operator provisions each proxy's serve
# config once, targeting the pod IP that existed at provisioning time, and
# never refreshes it. Whenever the app pod is replaced (rollout, reschedule,
# node reboot) the entry keeps the dead IP and every request 502s until the
# proxy is manually re-pointed — this bit panel twice. This script makes
# that fix a single command.
#
# Usage: serve-refresh.sh <app> <namespace>
#   serve-refresh.sh panel agents
#   serve-refresh.sh t3code-0 agents
#
# <app> is the exposed Service name (= tailscale.com/hostname, matching the
# ts-<app> proxy pod). Works for panel and any service exposed the same way.
# Idempotent: exits 0 without changing anything when the serve entry already
# targets the current pod IP, and prints serve status before and after so
# the change is visible. If the entry does not exist yet but the operator
# has provisioned an HTTP one, the HTTPS entry (repo convention for every
# UI) is created from its backend port; if there is no entry at all, run
# scripts/serve-https.sh (t3code) or re-check the Service annotations.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: serve-refresh.sh <app> <namespace>" >&2; exit 2; }
APP=$1
NS=$2
TS_NS="tailscale"

# Current app pod IP, read from the Service's endpoints so discovery follows
# the Service's own selector (works for Deployments and StatefulSet replicas
# alike, without assuming pod labels mirror the service name).
APP_IP=$(kubectl get endpoints "$APP" -n "$NS" -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null) || true
[ -n "$APP_IP" ] || { echo "no ready endpoint for ${APP}/${NS} (service exists? pod ready?)" >&2; exit 1; }

# Operator-provisioned proxy pod for this service.
PROXY_POD=$(kubectl get pods -n "$TS_NS" --no-headers | grep "ts-${APP}" | awk '$3=="Running"{print $1}' | head -1) || true
[ -n "$PROXY_POD" ] || { echo "no running tailscale proxy pod matching ts-${APP}" >&2; exit 1; }

STATUS_OUT=$(kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve status 2>/dev/null) || true

echo "== serve status before (proxy pod ${PROXY_POD}) =="
printf '%s\n' "${STATUS_OUT:-<none>}"

# Only the pod IP goes stale on pod replacement: keep the entry's backend
# port, swap in the fresh IP. Prefer the backend under the https entry (the
# UI convention); fall back to the first backend when there is no https entry
# yet (serve-https.sh will create it).
BACKEND=$(printf '%s\n' "${STATUS_OUT}" | awk '/^https:\/\//{want=1; next} want&&/http:\/\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:[0-9]+/{print; exit}' | grep -oE 'http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' | head -1) || true
[ -n "${BACKEND}" ] || BACKEND=$(printf '%s\n' "${STATUS_OUT}" | grep -oE 'http://[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]+' | head -1) || true
[ -n "$BACKEND" ] || { echo "no serve entry for ${APP}; run scripts/serve-https.sh (t3code) or re-check the Service's tailscale annotations" >&2; exit 1; }
PORT=${BACKEND##*:}
TARGET="http://${APP_IP}:${PORT}"

if printf '%s\n' "$STATUS_OUT" | grep -q "https://${APP}\."; then
  if printf '%s\n' "$STATUS_OUT" | grep -q "http://${APP_IP}:${PORT}"; then
    echo "serve entry already points at ${TARGET}; nothing to do"
  else
    echo "re-pointing ${BACKEND} -> ${TARGET}"
    kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve --bg --https=443 "$TARGET" >/dev/null
  fi
else
  echo "creating https serve entry -> ${TARGET}"
  kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve --bg --https=443 "$TARGET" >/dev/null
fi

echo "== serve status after (proxy pod ${PROXY_POD}) =="
kubectl exec -n "$TS_NS" "$PROXY_POD" -- tailscale serve status
