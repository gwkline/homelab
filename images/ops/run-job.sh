#!/bin/sh
# Entrypoint for one-off Jobs: git auth, clone WORKSPACE_REPOS under
# $DATA_DIR/repos, run $JOB_COMMAND, exit with its status. The pod is
# disposable; anything worth keeping must leave it before the command exits.
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth
sync_repos

: "${JOB_COMMAND:?JOB_COMMAND is required}"

echo "[job] starting: ${JOB_COMMAND}"
status=0
sh -c "${JOB_COMMAND}" || status=$?
echo "[job] exited with status ${status}"
exit "${status}"
