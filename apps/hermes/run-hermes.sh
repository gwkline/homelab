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

# Photon sidecar: the adapter expects its runtime dir under HERMES_HOME with
# ALL sources present (a bare `npm ci` from node_modules alone leaves out
# sibling .mjs files and fails with ERR_MODULE_NOT_FOUND on first connect).
# Sync from the plugin tree every boot — cheap, idempotent, self-healing.
_sid_src="/opt/hermes/plugins/platforms/photon/sidecar"
_sid_dst="${HERMES_HOME}/photon/sidecar"
if [ -d "${_sid_src}" ]; then
  mkdir -p "${_sid_dst}"
  cp -u "${_sid_src}"/*.mjs "${_sid_src}/package.json" "${_sid_src}/package-lock.json" \
    "${_sid_dst}/" 2>/dev/null || true
fi

# Agent CLI state (claude/codex logins + sessions) lives under /home/node but
# is container-local. Restore from /data (survives rollouts); a snapshot hook
# elsewhere writes it back before pod termination.
for _d in .claude .codex; do
  if [ -d "/data/agent-state/${_d}" ]; then
    cp -a "/data/agent-state/${_d}/." "/home/node/${_d}/" 2>/dev/null || true
  fi
done

# First boot requires `hermes setup` (provider/model config) — run it once
# interactively via kubectl exec; this entrypoint refuses to guess.
# NOTE: hermes writes config to ${HERMES_HOME}/config.yaml (yaml, despite the
# legacy name check below kept for older layouts).
if [ ! -f "${HERMES_HOME}/config.yaml" ] && [ ! -f "${HERMES_HOME}/config.toml" ] && [ ! -d "${HERMES_HOME}/.hermes" ]; then
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
