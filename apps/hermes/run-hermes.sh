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

# ---------------------------------------------------------------------------
# Self-healing credential hygiene (#gh-token-approvals):
#
# GH_TOKEN/GITHUB_TOKEN are injected into the pod by the StatefulSet from
# secret github-token — every process (and every agent-issued shell command)
# already inherits them. The agent must NEVER write token exports into shell
# dotfiles or inline them into commands: exports in command text trip the
# pre-exec security scanner ("Sensitive credential exported"), require an
# approval every session, and leak the token into transcripts.
#
# The agent has historically written `export GH_TOKEN=...` into .bashrc /
# .profile when it couldn't see the token in a shell. Two failure modes fed
# that habit: non-interactive shells don't source .bashrc (so its own advice
# failed its own tests), and gh used to live only in ad-hoc ~/bin on the PVC
# (now baked into the image). This scrub runs every boot: any line containing
# a credential-ish assignment that the agent re-learns is removed at startup.
# ---------------------------------------------------------------------------
for _dotfile in "${HOME:-/data/home}/.bashrc" "${HOME:-/data/home}/.profile"; do
  [ -f "$_dotfile" ] || continue
  _scrubbed=$(grep -Ev '(GH_TOKEN|GITHUB_TOKEN|GIT_ASKPASS|PASSWORD|SECRET)' "$_dotfile" || true)
  if [ "$_scrubbed" != "$(cat "$_dotfile")" ]; then
    printf '%s\n' "$_scrubbed" > "$_dotfile"
    echo "[hermes] scrubbed credential export from $_dotfile"
  fi
done

# ---------------------------------------------------------------------------
# Boot-time auth verification: fail loudly in pod logs if the injected token
# is missing or stale, instead of the agent discovering it mid-task and
# improvising. Failure is non-fatal (token may be intentionally absent in dev)
# but the log line makes the cause unmissable.
# ---------------------------------------------------------------------------
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

# If the agent's working copy of the homelab repo has diverged (its local
# commits were PR'd/rebased upstream), fast-forward it so the next session
# starts from origin/main instead of fighting divergence.
if [ -d /data/home/homelab/.git ]; then
  git -C /data/home/homelab fetch origin -q || true
  git -C /data/home/homelab merge --ff-only origin/main >/dev/null 2>&1 \
    || echo "[hermes] NOTE: /data/home/homelab has local work not on origin/main — left untouched" >&2
fi

# ---------------------------------------------------------------------------
# SOUL.md operator contract: SOUL.md is injected into EVERY session regardless
# of working directory, so the credential rule lives here too — idempotent,
# marker-guarded, survives PVC recreation (file is on /data).
# ---------------------------------------------------------------------------
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

# Skills-sync health announcement (init container writes
# $HERMES_HOME/skills-sync/status.json). Loud fresh/stale line at boot;
# never fails the pod — degradation contract in skills-sync.yaml.
/usr/local/bin/check-skills-sync || true

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

# ---------------------------------------------------------------------------
# Agent CLI state (#19): claude and codex both read/write under $HOME —
# /data/home/.claude and /data/home/.codex. HOME is set to /data/home in the
# StatefulSet, on the hermes PVC, so auth/session state is persistent in
# place: no /home/node copy, no periodic write-back loop, nothing to flush
# at termination — the CLIs write straight to the PVC.
#
# One-time migration: older deployments snapshotted these dirs at
# /data/agent-state and restored them into container-local /home/node (never
# the value of $HOME), so logins were lost on every rollout. If such a legacy
# snapshot still exists and $HOME has no state yet, adopt it once, then drop
# the migrated marker so a later logout can't be resurrected by a stale
# restore.
# ---------------------------------------------------------------------------
_home="${HOME:-/data/home}"
if [ ! -e "${_home}/.agent-state-migrated" ] && [ -d /data/agent-state ]; then
  for _d in .claude .codex; do
    if [ -d "/data/agent-state/${_d}" ] && [ ! -d "${_home}/${_d}" ]; then
      cp -a "/data/agent-state/${_d}" "${_home}/" || true
    fi
  done
  : > "${_home}/.agent-state-migrated"
  echo "[hermes] migrated /data/agent-state into ${_home} (one-time)"
fi

# Harmless persistence probe (#19): a per-boot marker in each state dir. If
# the previous boot's marker is still present, the PVC-backed state survived
# the restart — persistence is provable from pod logs alone.
for _d in .claude .codex; do
  _probe="${_home}/${_d}/.persistence-probe"
  [ -d "${_home}/${_d}" ] || mkdir -p "${_home}/${_d}"
  if [ -f "${_probe}" ]; then
    echo "[hermes] ${_d}: state persisted across restart (probe from $(cat "${_probe}"))"
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ > "${_probe}"
done
unset _home _d _probe

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
