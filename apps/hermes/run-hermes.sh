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

# GH_TOKEN is injected by the pod; drop any token exports the agent wrote
# into dotfiles (they trip the pre-exec scanner on every session).
for _dotfile in "${HOME:-/data/home}/.bashrc" "${HOME:-/data/home}/.profile"; do
  [ -f "$_dotfile" ] || continue
  _scrubbed=$(grep -Ev '(GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|PASSWORD|SECRET)' "$_dotfile" || true)
  if [ "$_scrubbed" != "$(cat "$_dotfile")" ]; then
    printf '%s\n' "$_scrubbed" > "$_dotfile"
    echo "[hermes] scrubbed credential export from $_dotfile"
  fi
done

# Surface a missing or rejected token in pod logs (non-fatal).
if command -v gh >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ]; then
  _gh_user="$(gh api user -q .login 2>/dev/null || true)"
  if [ -n "${_gh_user:-}" ]; then
    echo "[hermes] GitHub auth OK (${_gh_user})"
  else
    echo "[hermes] WARNING: GH_TOKEN present but GitHub rejected it — rotate secret github-token (agents ns)" >&2
  fi
  unset _gh_user
elif [ -z "${GH_TOKEN:-}" ]; then
  echo "[hermes] WARNING: GH_TOKEN not set — git push / gh api will fail until secret github-token is wired" >&2
fi

# Fast-forward the agent's homelab checkout when it has no local work.
if [ -d /data/home/homelab/.git ]; then
  git -C /data/home/homelab fetch origin -q || true
  git -C /data/home/homelab merge --ff-only origin/main >/dev/null 2>&1 \
    || echo "[hermes] NOTE: /data/home/homelab has local work not on origin/main — left untouched" >&2
fi

# SOUL.md is injected into every session, so the credential rule lives there
# too (marker-guarded, idempotent).
_soul="${HERMES_HOME}/SOUL.md"
_marker="operator:credential-contract"
if ! grep -q "$_marker" "$_soul" 2>/dev/null; then
  cat >> "$_soul" <<'EOF'

<!-- operator:credential-contract -->
## Environment contract (operator-managed)
- GH_TOKEN/GITHUB_TOKEN are already set in your environment. NEVER write
  `export GH_TOKEN=...` or any token export into terminal commands, scripts,
  .bashrc, or .profile — inline credentials trip the pre-exec security
  scanner and force a human approval every session. The export is redundant.
- gh and git are pre-installed. `git push`, `gh api` work with zero setup.
- Auth problem? Run `gh api user -q .login` (no exports). If it fails,
  report it — token rotation is an operator action.
EOF
  echo "[hermes] seeded credential contract into SOUL.md"
fi

# Log skills-sync freshness; never fails the pod.
/usr/local/bin/check-skills-sync || true

# The photon adapter needs every sidecar source under HERMES_HOME, not just
# node_modules; resync from the plugin tree each boot.
_sid_src="/opt/hermes/plugins/platforms/photon/sidecar"
_sid_dst="${HERMES_HOME}/photon/sidecar"
if [ -d "${_sid_src}" ]; then
  mkdir -p "${_sid_dst}"
  cp -u "${_sid_src}"/*.mjs "${_sid_src}/package.json" "${_sid_src}/package-lock.json" \
    "${_sid_dst}/" 2>/dev/null || true
fi

# claude/codex state lives under $HOME (/data/home), on the PVC.
_home="${HOME:-/data/home}"
# Per-boot marker: finding the previous one proves state survived the restart.
for _d in .claude .codex; do
  _probe="${_home}/${_d}/.persistence-probe"
  [ -d "${_home}/${_d}" ] || mkdir -p "${_home}/${_d}"
  if [ -f "${_probe}" ]; then
    echo "[hermes] ${_d}: state persisted across restart (probe from $(cat "${_probe}"))"
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "${_probe}"
done
unset _home _d _probe

# First boot needs an interactive `hermes setup`; refuse to guess.
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
