#!/bin/sh
# Regression test: factory image digests have exactly one source of truth.
# The worker/profile split (a re-pin that missed the second hardcoded copy)
# silently ran stale code: run.sh must resolve the worker image from the
# profile ConfigMap at runtime, never carry its own digest.
# Offline and fixture-free: greps the working tree + exercises the pin helper
# on temp copies.
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
cd "$REPO_ROOT"

RUN_SH="apps/factory/orchestrator/run.sh"
CRONJOB="deploy/factory/base/orchestrator-cronjob.yaml"
PIN_HELPER="scripts/pin-factory-image.sh"

# 1. No hardcoded factory digest in the orchestrator dispatch path.
if grep -E 'WORKER_IMAGE="ghcr\.io/[^"]*@sha256:[0-9a-f]{64}"' "$RUN_SH"; then
  echo "FAIL: run.sh carries a hardcoded worker image digest (resolve from the profile ConfigMap instead)"
  exit 1
fi
echo "ok: no hardcoded worker digest in run.sh"

# 2. Resolution reads the profile ConfigMap, with an env override seam.
grep -q 'kubectl get configmap "${PROFILE_CM}"' "$RUN_SH" || {
  echo "FAIL: run.sh does not resolve the worker image from the profile ConfigMap"
  exit 1
}
grep -q 'WORKER_IMAGE_OVERRIDE' "$RUN_SH" || {
  echo "FAIL: run.sh has no WORKER_IMAGE_OVERRIDE seam"
  exit 1
}
echo "ok: run.sh resolves the worker image from the profile ConfigMap"

# 3. RBAC grants the read (scoped to the two profile ConfigMaps).
grep -q 'resourceNames: \["factory-profile-code-pr", "factory-profile-security"\]' "$CRONJOB" || {
  echo "FAIL: orchestrator Role does not scope configmap reads to the profiles"
  exit 1
}
echo "ok: orchestrator Role scopes profile ConfigMap reads"

# 4. The pin helper stamps every copy of a component (temp copies).
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
mkdir -p "$FIX/deploy/factory/base"
for f in reviewer-cronjob.yaml reviewer-launchpad-cronjob.yaml profile-reviewer.yaml; do
  printf 'image: ghcr.io/gwkline/homelab/factory/reviewer@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n' \
    > "$FIX/deploy/factory/base/$f"
done
NEW_DIGEST="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
(
  cd "$FIX"
  # run the helper with REPO_ROOT-independent paths by shadowing locations:
  # copy the helper and rewrite its location table prefix to the fixture dir
  sed 's|deploy/factory/base/|'"$FIX"'/deploy/factory/base/|g' "$REPO_ROOT/$PIN_HELPER" > "$FIX/pin.sh"
  sh "$FIX/pin.sh" factory/reviewer "$NEW_DIGEST" >/dev/null
)
for f in reviewer-cronjob.yaml reviewer-launchpad-cronjob.yaml profile-reviewer.yaml; do
  grep -q "factory/reviewer@sha256:${NEW_DIGEST}" "$FIX/deploy/factory/base/$f" || {
    echo "FAIL: pin helper did not stamp $f"
    exit 1
  }
done
echo "ok: pin helper stamps every copy of a component"

# 5. The pin helper rejects garbage and unknown components.
if sh "$REPO_ROOT/$PIN_HELPER" factory/worker deadbeef >/dev/null 2>&1; then
  echo "FAIL: pin helper accepted a malformed digest"
  exit 1
fi
if sh "$REPO_ROOT/$PIN_HELPER" factory/nope "$NEW_DIGEST" >/dev/null 2>&1; then
  echo "FAIL: pin helper accepted an unknown component"
  exit 1
fi
echo "ok: pin helper rejects malformed digests and unknown components"

# 6. The repo-wide pins check passes (single digest per factory component).
sh scripts/check-image-pins.sh >/dev/null || {
  echo "FAIL: scripts/check-image-pins.sh reports divergence"
  exit 1
}
echo "ok: check-image-pins.sh agrees"

echo "PASS: factory image single-source-of-truth is covered"
