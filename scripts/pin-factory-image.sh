#!/bin/sh
# Stamp one factory component digest into every file that references it.
#
# The file list per component lives here and here only: adding a new consumer
# means adding one line below, and scripts/check-image-pins.sh fails CI if two
# copies of the same component ever disagree again.
#
# Usage: scripts/pin-factory-image.sh factory/worker <64-hex-digest>
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

locations() {
  case "$comp" in
    factory/worker)
      printf '%s\n' deploy/factory/base/profile-code-pr.yaml
      ;;
    factory/security)
      printf '%s\n' deploy/factory/base/profile-security.yaml
      ;;
    factory/reviewer)
      printf '%s\n' deploy/factory/base/reviewer-cronjob.yaml
      printf '%s\n' deploy/factory/base/reviewer-launchpad-cronjob.yaml
      printf '%s\n' deploy/factory/base/profile-reviewer.yaml
      ;;
    factory/orchestrator)
      printf '%s\n' deploy/factory/base/orchestrator-cronjob.yaml
      printf '%s\n' deploy/factory/base/orchestrator-launchpad-cronjob.yaml
      printf '%s\n' deploy/factory/base/reclaimer-cronjob.yaml
      ;;
    factory/collector)
      printf '%s\n' deploy/factory/base/collector-cronjob.yaml
      ;;
    *)
      fail "unknown component: ${comp} (want factory/worker|security|reviewer|orchestrator|collector)"
      ;;
  esac
}

stamped=0
# NB: locations() runs in a subshell here, so its internal fail() cannot stop
# the script by itself — the || exit re-raises the failure outside.
locs=$(locations) || exit 1
[ -n "$locs" ] || fail "unknown component: ${comp}"
for f in $locs; do
  [ -f "$f" ] || fail "location missing: ${f}"
  grep -q "homelab/${comp}@sha256:[0-9a-f]\\{64\\}" "$f" \
    || fail "no ${comp} digest ref found in ${f} (location table rot?)"
  tmp="$(mktemp)" || fail 'mktemp failed'
  sed "s|homelab/${comp}@sha256:[0-9a-f]\\{64\\}|homelab/${comp}@sha256:${digest}|g" "$f" > "$tmp"
  mv "$tmp" "$f"
  stamped=$((stamped + 1))
  echo "  stamped ${f}"
done
echo "pinned homelab/${comp} to ${digest} (${stamped} files)"
