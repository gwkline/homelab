#!/bin/sh
# Entrypoint for t3code pods: auth git, sync repos, register projects, serve.
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth

DATA_DIR="${DATA_DIR:-/data}"
REPOS_DIR="${DATA_DIR}/repos"

# Agent CLI state (.claude/.codex logins, sessions) is container-local by
# default. Restore from the PVC snapshot so logins survive rollouts; a
# background sync writes changes back every 60s (see bottom of file).
STATE_SRC="${DATA_DIR}/agent-state"
for _d in .claude .codex; do
  if [ -d "${STATE_SRC}/${_d}" ]; then
    mkdir -p "/home/node/${_d}"
    cp -a "${STATE_SRC}/${_d}/." "/home/node/${_d}/" 2>/dev/null || true
  fi
done
(
  while :; do
    sleep 60
    for _d in .claude .codex; do
      if [ -d "/home/node/${_d}" ]; then
        mkdir -p "${STATE_SRC}/${_d}"
        cp -a "/home/node/${_d}/." "${STATE_SRC}/${_d}/" 2>/dev/null || true
      fi
    done
  done
) &
echo "[t3code] agent-state sync started (${STATE_SRC})"

sync_repos

register_project() {
  dir="$1"
  # Best-effort: tolerate CLI flag drift across t3 versions; a failed or
  # duplicate registration must not crash the pod.
  t3 project add "$(realpath "${dir}")" 2>/dev/null \
    || echo "[workspace] WARN: could not register ${dir} (may already exist)"
}

for dir in "${REPOS_DIR}"/*/; do
  [ -d "${dir}.git" ] && register_project "${dir}"
done

echo "[t3code] starting server on 0.0.0.0:3773"
exec t3 serve --host 0.0.0.0 --port 3773
