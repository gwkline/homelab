#!/bin/sh
# Entrypoint for hermes pods: auth git, sync repos, start hermes.
#
# Default mode is the messaging gateway (Telegram/Discord/etc.) so the agent
# is reachable without a shell. For interactive TUI use:
#   kubectl exec -it hermes-0 -n agents -- hermes
# Override with HERMES_COMMAND (e.g. "hermes gateway start").
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth
sync_repos

export HERMES_HOME="${HERMES_HOME:-/data/hermes}"
mkdir -p "${HERMES_HOME}" "${HOME:-/data/home}"

# First boot requires `hermes setup` (provider/model config) — run it once
# interactively via kubectl exec; this entrypoint refuses to guess.
if [ ! -f "${HERMES_HOME}/config.toml" ] && [ ! -d "${HERMES_HOME}/.hermes" ]; then
  cat >&2 <<'EOF'
[hermes] No config found in HERMES_HOME.
Run one-time setup:
  kubectl exec -it hermes-0 -n agents -- bash
  hermes setup --portal
Then restart: kubectl rollout restart statefulset hermes -n agents
Idling until configured...
EOF
  exec sleep infinity
fi

exec ${HERMES_COMMAND:-hermes gateway}
