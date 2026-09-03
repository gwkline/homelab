#!/bin/sh
# Manual smoke test for the factory GitHub App token service (#70).
#
# Proves a short-lived App installation token can, with only the
# permissions it was minted for:
#   1. read an issue              (issues:read)
#   2. resolve the default branch (metadata:read, contents:read)
#   3. create a throwaway branch  (contents:write)
#   4. delete the throwaway branch (contents:write)
#
# Token sourcing (never printed, never written outside a mktemp file):
#   GH_TOKEN        existing installation token, or
#   GH_TOKEN_FILE   file containing one, or
#   (fallback)      minted via mint.ts from the 1Password-sourced env:
#                     GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID,
#                     GITHUB_APP_PRIVATE_KEY_FILE (or _PRIVATE_KEY)
#
# Usage:
#   REPO=owner/name ISSUE=<n> sh apps/factory/github-app/smoke-test.sh
#   REPO=owner/name ISSUE=<n> GH_TOKEN_FILE=/tmp/gh-token sh .../smoke-test.sh
set -eu

REPO="${1:-${REPO:?usage: REPO=owner/name ISSUE=<n> sh smoke-test.sh}}"
ISSUE="${2:-${ISSUE:?usage: REPO=owner/name ISSUE=<n> sh smoke-test.sh}}"
GH_BIN="${GH_BIN:-gh}"
TEST_BRANCH="factory/app-smoke-$(date +%s)"
CREATED=0
WORK="$(mktemp -d)"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  # Best-effort rollback: a leftover smoke branch must not accumulate.
  if [ "$CREATED" = "1" ]; then
    if "$GH_BIN" api -X DELETE "repos/${REPO}/git/refs/heads/${TEST_BRANCH}" >/dev/null 2>&1; then
      echo "[smoke] cleaned up branch ${TEST_BRANCH}"
    else
      echo "[smoke] WARN: could not delete ${TEST_BRANCH} — remove it manually" >&2
    fi
  fi
  rm -rf "${WORK}"
}
trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

if [ -n "${GH_TOKEN:-}" ]; then
  echo "[smoke] using GH_TOKEN from environment"
elif [ -n "${GH_TOKEN_FILE:-}" ] && [ -r "${GH_TOKEN_FILE}" ]; then
  GH_TOKEN="$(tr -d '[:space:]' < "${GH_TOKEN_FILE}")"
  echo "[smoke] using token from GH_TOKEN_FILE"
else
  if ! command -v node >/dev/null 2>&1; then
    echo "[smoke] FATAL: node >=22.6 required to mint a token (or set GH_TOKEN)" >&2
    exit 78
  fi
  echo "[smoke] minting a short-lived installation token via mint.ts"
  # Token lands in the mktemp dir with mode 0600; stdout of the mint
  # carries only the expiry, never the token itself.
  node --experimental-strip-types "${APP_DIR}/mint.ts" \
    --permissions contents:write,issues:read,metadata:read \
    --out "${WORK}/token" >/dev/null
  GH_TOKEN="$(tr -d '[:space:]' < "${WORK}/token")"
fi
export GH_TOKEN
GH_CONFIG_DIR="${WORK}/gh"
export GH_CONFIG_DIR

# --- 1. read an issue (issues:read) -----------------------------------------
READ_NUMBER="$("$GH_BIN" api "repos/${REPO}/issues/${ISSUE}" --jq .number)"
if [ "${READ_NUMBER}" != "${ISSUE}" ]; then
  echo "[smoke] FAIL: issue read returned #${READ_NUMBER}, expected #${ISSUE}" >&2
  exit 1
fi
echo "[smoke] ok: read issue ${REPO}#${ISSUE}"

# --- 2. resolve the default branch (metadata:read, contents:read) -----------
DEFAULT_BRANCH="$("$GH_BIN" api "repos/${REPO}" --jq .default_branch)"
BASE_SHA="$("$GH_BIN" api "repos/${REPO}/git/ref/heads/${DEFAULT_BRANCH}" --jq .object.sha)"
[ -n "${BASE_SHA}" ] || { echo "[smoke] FAIL: empty base sha" >&2; exit 1; }
echo "[smoke] ok: default branch ${DEFAULT_BRANCH} @ ${BASE_SHA}"

# --- 3. create a throwaway branch (contents:write) ---------------------------
"$GH_BIN" api -X POST "repos/${REPO}/git/refs" \
  -f "ref=refs/heads/${TEST_BRANCH}" -f "sha=${BASE_SHA}" >/dev/null
CREATED=1
echo "[smoke] ok: created branch ${TEST_BRANCH}"

# --- 4. delete it (contents:write) and verify it is gone ----------------------
"$GH_BIN" api -X DELETE "repos/${REPO}/git/refs/heads/${TEST_BRANCH}" >/dev/null
CREATED=0
if "$GH_BIN" api "repos/${REPO}/git/ref/heads/${TEST_BRANCH}" >/dev/null 2>&1; then
  echo "[smoke] FAIL: ${TEST_BRANCH} still exists after delete" >&2
  exit 1
fi

echo "[smoke] PASS: issue read + branch create/delete with a short-lived App token"
