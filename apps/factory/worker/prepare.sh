#!/bin/sh
# Factory worker clone step: the Job's initContainer and the only factory
# container that holds a GitHub credential. It clones FACTORY_REPO into
# ${WORK_DIR}/repo and syncs the pinned private skills, then exits, so the
# agent container starts with no token in its env, files or /proc.
#
#   in   FACTORY_REPO (owner/name); GH_TOKEN, GITHUB_TOKEN or GITHUB_TOKEN_FILE
#        (optional: public repos clone anonymously); FACTORY_CLONE_REF
#        (optional: a branch to check out after the clone — medic repair runs)
#   out  ${WORK_DIR}/repo with a credential-free origin; skills in
#        SKILLS_TARGET with their status in SKILLS_STATUS_FILE
#   exit 0 cloned · 1 clone failed or stalled (retryable) · 78 cannot attempt:
#        misconfiguration or a failed private-skills sync
#
# The token reaches git only through a throwaway GIT_ASKPASS helper, never a
# URL, so nothing on disk (.git/config, FETCH_HEAD) records it.
set -eu

WORK_DIR="${WORK_DIR:-/work}"
REPO="${FACTORY_REPO:-}"
case "${REPO}" in
  */*) ;;
  *) echo "[prepare] CANNOT ATTEMPT: FACTORY_REPO must be owner/name (got '${REPO}')" >&2; exit 78 ;;
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

# Medic repair runs (apps/factory/orchestrator/run.sh) work on the existing PR
# branch, not the default branch: check it out so the worker's patch diffs
# against the branch tip the fix is pushed onto. A vanished branch means the
# PR was merged or closed while the repair queued — cannot attempt.
if [ -n "${FACTORY_CLONE_REF:-}" ]; then
  _pcr_rc=0
  PREPARE_TOKEN="${PREPARE_TOKEN}" GIT_ASKPASS="${ASKPASS}" GIT_TERMINAL_PROMPT=0 \
    git -C "${WORK_DIR}/repo" fetch -q --depth 20 origin "refs/heads/${FACTORY_CLONE_REF}" || _pcr_rc=$?
  if [ "${_pcr_rc}" -ne 0 ]; then
    if PREPARE_TOKEN="${PREPARE_TOKEN}" GIT_ASKPASS="${ASKPASS}" GIT_TERMINAL_PROMPT=0 \
      git -C "${WORK_DIR}/repo" ls-remote --exit-code origin "refs/heads/${FACTORY_CLONE_REF}" >/dev/null 2>&1; then
      echo "[prepare] FATAL: fetch of ${FACTORY_CLONE_REF} failed (or stalled >30s)" >&2
      exit 1
    fi
    echo "[prepare] CANNOT ATTEMPT: ${FACTORY_CLONE_REF} is gone from origin (PR merged or closed?)" >&2
    exit 78
  fi
  git -C "${WORK_DIR}/repo" checkout -q FETCH_HEAD
  echo "[prepare] checked out ${FACTORY_CLONE_REF} @ $(git -C "${WORK_DIR}/repo" rev-parse --short HEAD)"
fi

# Pinned private skills (apps/shared/skills-lib.sh), required when SKILLS_REF
# is set: without them the run only churns to "no changes", so a failed sync
# stops it as cannot-attempt (78) with the reason.
if [ -n "${SKILLS_REF:-}" ] && [ -f "${SKILLS_LIB}" ]; then
  # shellcheck source=apps/shared/skills-lib.sh
  . "${SKILLS_LIB}"
  if ! skills_sync; then
    _err=$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' "${SKILLS_STATUS_FILE:-/dev/null}" 2>/dev/null || true)
    echo "[prepare] CANNOT ATTEMPT: private skills sync failed${_err:+ (${_err})}; check that the github-token Secret can read ${SKILLS_REPO_URL:-the skills repo}" >&2
    exit 78
  fi
fi
