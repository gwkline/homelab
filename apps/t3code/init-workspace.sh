#!/bin/sh
# Entrypoint for t3code pods: auth git, sync repos, register projects, serve.
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth

DATA_DIR="${DATA_DIR:-/data}"
REPOS_DIR="${DATA_DIR}/repos"

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
