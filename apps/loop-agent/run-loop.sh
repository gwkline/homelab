#!/bin/sh
# Entrypoint for unattended loop agents.
# Lifecycle: auth git -> sync repos -> run $LOOP_COMMAND -> exit.
# The pod is disposable; anything worth keeping must be exported by
# LOOP_COMMAND (git push, HTTP POST, artifact upload) before it exits.
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth
setup_gh_cli
sync_repos

: "${LOOP_COMMAND:?LOOP_COMMAND is required (e.g. 'node /data/repos/my-loop/check.mjs')}"

echo "[loop] starting: ${LOOP_COMMAND}"
status=0
sh -c "${LOOP_COMMAND}" || status=$?

# Optional post-run hook (e.g. notify, cleanup).
if [ -n "${LOOP_POST_COMMAND:-}" ]; then
  sh -c "${LOOP_POST_COMMAND}" || echo "[loop] WARN: post command failed"
fi

echo "[loop] exited with status ${status}"
exit "${status}"
