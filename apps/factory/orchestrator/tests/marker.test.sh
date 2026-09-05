#!/bin/bash
# Offline test: the Run marker comment (the factory audit event) must record
# the caller identity injected through the Executor MCP path (#84), and must
# stay identical to the pre-#84 format when no identity is present (cron).
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

NUM=6
RUN_TS="2026-09-05T00:00:00Z"
PROFILE="code-pr"
WORKFLOW_VERSION="v1"
WORKER_IMAGE="ghcr.io/gwkline/homelab/factory/worker@sha256:test"
timestamp() { printf '2026-09-05T00:01:00Z'; }

body_with() {  # FACTORY_TRIGGERED_BY value -> comment body
  FACTORY_TRIGGERED_BY="$1" sh <<EOF
NUM=$NUM RUN_TS=$RUN_TS PROFILE=$PROFILE
WORKFLOW_VERSION=$WORKFLOW_VERSION
WORKER_IMAGE='$WORKER_IMAGE'
timestamp() { printf '2026-09-05T00:01:00Z'; }
. "$SCRIPT_DIR/../marker.sh"
factory_marker_body running "_Worker dispatched"
EOF
}

body=$(body_with "hermes")
printf '%s\n' "$body" | grep -q '^| Requested by | hermes |$' || {
  echo "FAIL: marker comment must record the requesting client identity"
  printf '%s\n' "$body"
  exit 1
}
# The marker id and workflow rows stay intact alongside the new audit row.
printf '%s\n' "$body" | grep -q '<!-- factory:run:6:2026-09-05T00:00:00Z -->' || {
  echo "FAIL: run marker id lost"; exit 1
}
printf '%s\n' "$body" | grep -q '^| Workflow | code-pr@v1 (' || {
  echo "FAIL: workflow row lost"; exit 1
}

# No identity (scheduled cron tick) -> no row, comment still renders.
body=$(body_with "")
if printf '%s\n' "$body" | grep -q 'Requested by'; then
  echo "FAIL: scheduled tick must not render an identity row"
  printf '%s\n' "$body"
  exit 1
fi
printf '%s\n' "$body" | grep -q '^| Status | running |$' || {
  echo "FAIL: base marker rows lost without identity"; exit 1
}

# Updated timestamp variant (edit-in-place path) keeps both audit rows.
FACTORY_TRIGGERED_BY=t3code sh <<EOF > /tmp/marker-updated.$$ || exit 1
NUM=$NUM RUN_TS=$RUN_TS PROFILE=$PROFILE
WORKFLOW_VERSION=$WORKFLOW_VERSION
WORKER_IMAGE='$WORKER_IMAGE'
timestamp() { printf '2026-09-05T00:01:00Z'; }
. "$SCRIPT_DIR/../marker.sh"
factory_marker_body failed boom 2026-09-05T00:02:00Z
EOF
grep -q '^| Updated | 2026-09-05T00:02:00Z |$' /tmp/marker-updated.$$ || {
  echo "FAIL: updated row lost on edit-in-place"; exit 1
}
grep -q '^| Requested by | t3code |$' /tmp/marker-updated.$$ || {
  echo "FAIL: identity row lost on edit-in-place"; exit 1
}
rm -f /tmp/marker-updated.$$

echo "PASS: factory run marker records caller identity (and omits it for cron ticks)"