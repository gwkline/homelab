#!/bin/sh
# Stamp one component digest into every file that references it.
#
# The file list per component lives here and here only: adding a new consumer
# means adding one line below, and scripts/check-image-pins.sh fails CI if two
# copies of the same component ever disagree again.
#
# Usage: scripts/pin-factory-image.sh <component> <64-hex-digest>
# Components: factory/worker factory/security factory/reviewer
#             factory/orchestrator factory/collector
#             knowledge/ingest knowledge/retrieval
# Example digest source (latest main build of the component):
#   gh api 'users/gwkline/packages/container/homelab%2Ffactory%2Fworker/versions?per_page=1' \
#     --jq '.[0].name'
set -eu

cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

comp="${1:?usage: scripts/pin-factory-image.sh <component> <64-hex-digest> (e.g. factory/worker <digest>)}"
digest="${2:?usage: scripts/pin-factory-image.sh <component> <64-hex-digest> (e.g. factory/worker <digest>)}"

case "${#digest}" in
  64) ;;
  *) fail "malformed digest (expected exactly 64 hex chars): ${digest}" ;;
esac
case "$digest" in
  *[!0-9a-f]*) fail "malformed digest (non-hex characters): ${digest}" ;;
esac

# GHCR repository name for a component (knowledge/* images use hyphens).
image_name() {
  case "$comp" in
    knowledge/ingest) printf '%s\n' "knowledge-ingest" ;;
    knowledge/retrieval) printf '%s\n' "knowledge-retrieval" ;;
    *) printf '%s\n' "$comp" ;;
  esac
}

locations() {
  case "$comp" in
    factory/worker)
      printf '%s\n' deploy/factory/base/profile-code-pr.yaml
      printf '%s\n' deploy/factory/base/profile-medic.yaml
      ;;
    factory/security)
      printf '%s\n' deploy/factory/base/profile-security.yaml
      printf '%s\n' deploy/factory/base/security-cronjob.yaml
      ;;
    factory/reviewer)
      printf '%s\n' deploy/factory/base/reviewer-cronjob.yaml
      printf '%s\n' deploy/factory/base/reviewer-launchpad-cronjob.yaml
      printf '%s\n' deploy/factory/base/sweeper-cronjob.yaml
      printf '%s\n' deploy/factory/base/profile-reviewer.yaml
      printf '%s\n' deploy/factory/base/medic-cronjob.yaml
      ;;
    factory/orchestrator)
      printf '%s\n' deploy/factory/base/orchestrator-cronjob.yaml
      printf '%s\n' deploy/factory/base/orchestrator-launchpad-cronjob.yaml
      printf '%s\n' deploy/factory/base/reclaimer-cronjob.yaml
      ;;
    factory/collector)
      printf '%s\n' deploy/factory/base/collector-cronjob.yaml
      ;;
    knowledge/ingest)
      printf '%s\n' deploy/knowledge/base/deployment-knowledge-ingest.yaml
      ;;
    knowledge/retrieval)
      printf '%s\n' deploy/knowledge/base/deployment-knowledge-retrieval.yaml
      ;;
    *)
      fail "unknown component: ${comp} (want factory/worker|security|reviewer|orchestrator|collector or knowledge/ingest|retrieval)"
      ;;
  esac
}

image="$(image_name)"
stamped=0
# NB: locations() runs in a subshell here, so its internal fail() cannot stop
# the script by itself — the || exit re-raises the failure outside.
locs=$(locations) || exit 1
[ -n "$locs" ] || fail "unknown component: ${comp}"
for f in $locs; do
  [ -f "$f" ] || fail "location missing: ${f}"
  grep -q "homelab/${image}@sha256:[0-9a-f]\\{64\\}" "$f" \
    || fail "no ${image} digest ref found in ${f} (location table rot?)"
  tmp="$(mktemp)" || fail 'mktemp failed'
  sed "s|homelab/${image}@sha256:[0-9a-f]\\{64\\}|homelab/${image}@sha256:${digest}|g" "$f" > "$tmp"
  mv "$tmp" "$f"
  stamped=$((stamped + 1))
  echo "  stamped ${f}"
done
echo "pinned homelab/${image} to ${digest} (${stamped} files)"
