#!/bin/sh
# Factory worker clone step: the Job's initContainer and the only factory
# container that holds a GitHub credential. It clones FACTORY_REPO into
# ${WORK_DIR}/repo and syncs the pinned private skills, then exits, so the
# agent container starts with no token in its env, files or /proc.
#
#   in   FACTORY_REPO (owner/name); GH_TOKEN, GITHUB_TOKEN or GITHUB_TOKEN_FILE
#        (optional: public repos clone anonymously)
#   out  ${WORK_DIR}/repo with a credential-free origin; skills in
#        SKILLS_TARGET with their status in SKILLS_STATUS_FILE
#   exit 0 cloned · 1 clone failed or stalled · 78 misconfiguration
#
# The token reaches git only through a throwaway GIT_ASKPASS helper, never a
# URL, so nothing on disk (.git/config, FETCH_HEAD) records it.
set -eu

WORK_DIR="${WORK_DIR:-/work}"
REPO="${FACTORY_REPO:-}"
case "${REPO}" in
  */*) ;;
  *) echo "[prepare] FATAL: FACTORY_REPO must be owner/name (got '${REPO}')" >&2; exit 78 ;;
esac
CLONE_URL="${CLONE_URL:-https://github.com/${REPO}.git}"
_PREPARE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f /usr/local/lib/skills-lib.sh ]; then
  SKILLS_LIB=/usr/local/lib/skills-lib.sh
else
  SKILLS_LIB="${_PREPARE_DIR}/../../shared/skills-lib.sh"
fi

PREPARE_TOKEN=""
if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
  PREPARE_TOKEN="$(tr -d '[:space:]' < "${GITHUB_TOKEN_FILE}")"
elif [ -n "${GH_TOKEN:-}" ]; then
  PREPARE_TOKEN="${GH_TOKEN}"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  PREPARE_TOKEN="${GITHUB_TOKEN}"
fi

ASKPASS="$(mktemp)"
trap 'rm -f "${ASKPASS}"' EXIT
# shellcheck disable=SC2016  # the helper expands these when git runs it
{
  echo '#!/bin/sh'
  echo 'case "$1" in'
  echo '  Username*) echo x-access-token ;;'
  echo '  Password*) printf %s "${PREPARE_TOKEN}" ;;'
  echo 'esac'
} > "${ASKPASS}"
# mktemp creates mode 600; git cannot exec the helper without the exec bit.
chmod 700 "${ASKPASS}"

if [ -d "${WORK_DIR}/repo/.git" ]; then
  echo "[prepare] ${WORK_DIR}/repo already cloned"
else
  mkdir -p "${WORK_DIR}"
  _rc=0
  PREPARE_TOKEN="${PREPARE_TOKEN}" GIT_ASKPASS="${ASKPASS}" GIT_TERMINAL_PROMPT=0 \
    git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 \
      clone -q --depth 20 "${CLONE_URL}" "${WORK_DIR}/repo" || _rc=$?
  if [ "${_rc}" -ne 0 ]; then
    echo "[prepare] FATAL: clone of ${REPO} failed (or stalled >30s)" >&2
    exit 1
  fi
  git -C "${WORK_DIR}/repo" remote set-url origin "https://github.com/${REPO}.git"
  echo "[prepare] cloned ${REPO} @ $(git -C "${WORK_DIR}/repo" rev-parse --short HEAD)"
fi

# Pinned private skills (apps/shared/skills-lib.sh). A failure is recorded in
# SKILLS_STATUS_FILE and the run continues without them.
if [ -n "${SKILLS_REF:-}" ] && [ -f "${SKILLS_LIB}" ]; then
  # shellcheck source=apps/shared/skills-lib.sh
  . "${SKILLS_LIB}"
  skills_sync \
    || echo "[prepare] WARNING: skills sync FAILED — the agent runs without private skills" >&2
fi
