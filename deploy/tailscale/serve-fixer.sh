#!/bin/sh
# Self-healing serve config for the t3code tailscale proxy pod.
# Runs as a sidecar-ish loop: whenever t3code's pod IP changes (restart,
# reschedule), re-points `tailscale serve` at the new IP. This works around
# the operator provisioning serve config with a stale pod IP and not
# refreshing it on StatefulSet pod replacement (observed on operator
# 1.102.x / k3s v1.36).
#
# One implementation (issue #11): the repair itself — HTTPS 443 pointed at
# the app pod's current IP, drift-checked on the https handler — lives only
# in scripts/serve-https.sh. This loop only adds periodicity: the Deployment
# mounts the t3code-serve-fixer ConfigMap, which must carry an exact copy of
# that file (scripts/serve-fixer-check.sh fails when the ConfigMap copy and
# the repo file differ, so the manual command and this loop cannot drift).
#
# Least privilege (issue #32): serve-https.sh selects the proxy pod via the
# operator's parent-resource labels plus a name guard, so this loop can only
# ever exec into the t3code proxy pod — never the operator pod or another
# service's proxy.
#
# Failure policy (issue #110): failures are surfaced, not swallowed —
# serve-https.sh prints the reason, the loop logs the nonzero exit each
# cycle, and the next cycle retries; `kubectl logs -n tailscale
# deploy/t3code-serve-fixer` always shows the current failure.
set -eu

while true; do
  if ! /scripts/serve-https.sh; then
    echo "$(date -u +%H:%M:%S) serve-https.sh exited nonzero; retrying"
  fi
  sleep 30
done
