#!/bin/sh
# Enforce immutable digests on homelab image refs (issue #91).
#
# Every `image:` reference to a ghcr.io/**/homelab/** image in deployed
# manifests and job-spawning code must end in an @sha256 digest: CI signs
# digests (never tags) and the admission policy (deploy/image-policy/base)
# verifies the signature of the exact digest, so a mutable tag would have no
# signature to verify and would silently bypass both guarantees.
#
# Runs in the CI validate job beside scripts/verify.sh — verify.sh itself is
# bash and must stay untouched by dash-gated worker edits (see ci.yaml).
# scripts/ is deliberately out of scope: smoke scripts probe GHCR tags by
# design (scripts/gh-smoke.sh) and deploy nothing.
set -eu

cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# Same image-ref shape the ownership check in verify.sh greps for, so the two
# checks cover exactly the same refs.
_refs() {
  grep -rnE "(^|[[:space:]])\"?image\"?:[[:space:]]*\"?ghcr\.io/[^/]+/homelab/" \
    deploy/ apps/ examples/ 2>/dev/null || true
}

untagged=$(_refs | grep -v '@sha256:' || true)
if [ -n "$untagged" ]; then
  printf '%s\n' "$untagged" >&2
  fail 'homelab image ref without an @sha256 digest pin (issue #91)'
fi

# A digest that is not exactly 64 hex chars is not an immutable pin — reject
# it rather than letting a truncated or padded digest through.
malformed=$(_refs | grep '@sha256:' | grep -vE '@sha256:[0-9a-f]{64}([^0-9a-f]|$)' || true)
if [ -n "$malformed" ]; then
  printf '%s\n' "$malformed" >&2
  fail 'malformed digest pin (expected exactly 64 hex chars)'
fi

pinned=$(_refs | grep -c '@sha256:' || true)
echo "all homelab image refs are digest-pinned ($pinned refs)"

# One digest per factory component: the same factory image must never resolve
# to two different digests in different files. A re-pin that misses a second
# hardcoded copy silently runs stale code (the worker/profile split that
# motivated this check). Same _refs shape as above, so test/example vars
# (WORKER_IMAGE=, docs) stay out of scope by design.
factory_pairs=$(_refs | grep -oE 'ghcr\.io/[A-Za-z0-9_.-]+/homelab/factory/[A-Za-z0-9_.-]+@sha256:[0-9a-f]{64}' | sort -u || true)
if [ -n "$factory_pairs" ]; then
  divergent=$(printf '%s\n' "$factory_pairs" | awk -F'@sha256:' '{print $1}' | sort | uniq -d || true)
  if [ -n "$divergent" ]; then
    printf '%s\n' "$divergent" | while IFS= read -r path; do
      [ -n "$path" ] || continue
      echo "divergent pin for ${path}:" >&2
      _refs | grep -F "$path" >&2 || true
    done
    fail 'same factory image pinned to different digests — re-pin with scripts/pin-factory-image.sh so every copy agrees'
  fi
  agree=$(printf '%s\n' "$factory_pairs" | awk -F'@sha256:' '{print $1}' | sort -u | wc -l | tr -d ' ')
  echo "factory image pins agree ($agree components)"
fi
