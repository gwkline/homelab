#!/bin/sh
# gh smoke test for the coding-agent images (#23). Proves for each image
# that the pinned gh CLI is on PATH (`gh --version`) and — when a test
# token is available in the environment — performs a read-only API call
# (`gh api rate_limit`) with that token. Tokens are consumed at runtime
# only, from GH_TOKEN or GITHUB_TOKEN in the caller's environment; nothing
# is baked into image layers.
#
# Usage:
#   docker build -t t3code-dev -f apps/t3code/Dockerfile . && scripts/gh-smoke.sh t3code-dev
#   scripts/gh-smoke.sh ghcr.io/gwkline/homelab/t3code@sha256:<digest>
#   GH_TOKEN=$(cat /secrets/token) scripts/gh-smoke.sh   # all three images
#
# Without an image argument the three published coding-agent images are
# checked (login to ghcr.io first if they are private). Without a token the
# authenticated API call is skipped — `gh --version` still runs everywhere.
set -eu

command -v docker >/dev/null 2>&1 || { echo "gh-smoke: docker not found" >&2; exit 2; }

if [ "$#" -gt 0 ]; then
  set -- "$@"
else
  set -- \
    ghcr.io/gwkline/homelab/t3code:latest \
    ghcr.io/gwkline/homelab/loop-agent:latest \
    ghcr.io/gwkline/homelab/hermes:latest
fi

token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -n "${token}" ]; then
  echo "==> test token present: authenticated read-only API call will run"
else
  echo "==> no GH_TOKEN/GITHUB_TOKEN in environment: authenticated API call skipped"
fi

status=0
for image in "$@"; do
  echo "==> ${image}: gh --version"
  docker run --rm --entrypoint gh "${image}" --version || status=1
  if [ -n "${token}" ]; then
    echo "==> ${image}: gh api rate_limit (read-only)"
    docker run --rm --entrypoint gh -e GH_TOKEN "${image}" api rate_limit -q .rate.remaining \
      || status=1
  fi
done

if [ "${status}" -eq 0 ]; then
  echo "==> gh smoke: PASS"
else
  echo "==> gh smoke: FAIL" >&2
  exit 1
fi
