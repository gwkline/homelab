#!/bin/sh
# Entrypoint for t3code pods: auth git, sync repos, register projects, serve.
set -eu

. /usr/local/lib/workspace-lib.sh
setup_git_auth
# gh (baked into the image, see Dockerfile) authenticates runtime-only:
# exports GH_TOKEN when a writer token file is mounted (GITHUB_WRITER_TOKEN_FILE);
# a no-op otherwise — the image itself carries no credentials (#23).
setup_gh_cli

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

# ---------------------------------------------------------------------------
# Private skills (#81): the skills-sync init container built the generated
# store at ${DATA_DIR}/skills-generated from the pinned private-repo commit
# (t3code-skills-sync ConfigMap; updates are opt-in reviewed CM changes).
# Link it into the coding CLIs' skill dirs here — AFTER the agent-state
# restore above — so a snapshot file can never write through a fresh sync
# symlink. The link step only manages its own symlinks; real user files are
# reported and never overwritten. A failed sync degrades explicitly: loud
# warning, server keeps running without private skills.
# ---------------------------------------------------------------------------
. /usr/local/lib/skills-lib.sh
SKILLS_STORE="${DATA_DIR}/skills-generated"
SKILLS_STATUS="${DATA_DIR}/skills-sync/status.json"
if [ -f "${SKILLS_STATUS}" ] && grep -q '"ok":true' "${SKILLS_STATUS}"; then
  for _skills_dir in /home/node/.claude/skills; do
    skills_link_generated "${SKILLS_STORE}" "${_skills_dir}" \
      || echo "[t3code] WARNING: skills link into ${_skills_dir} incomplete" >&2
  done
  echo "[t3code] skills-sync: $(cat "${SKILLS_STATUS}")"
else
  echo "[t3code] WARNING: skills-sync did not produce a healthy store this boot — running WITHOUT private skills (see ${SKILLS_STATUS})" >&2
fi

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
# Enable the opencode provider in t3code settings (source of truth:
# $T3_STATE_DIR/settings.json — the UI toggle writes here). Idempotent.
SETTINGS="/home/node/.t3/userdata/settings.json"
if [ -d "$(dirname "${SETTINGS}")" ] && ! grep -q '"opencode"' "${SETTINGS}" 2>/dev/null; then
  if command -v python3 >/dev/null; then
    python3 -c "
import json, os
p = '${SETTINGS}'
s = json.load(open(p)) if os.path.exists(p) else {}
s.setdefault('providers', {}).setdefault('opencode', {})['enabled'] = True
json.dump(s, open(p, 'w'), indent=2)
"
  fi
fi

# opencode credentials: symlink its state dir into the PVC-backed agent-state
# so auth.json survives rollouts (opencode reads
# ~/.local/share/opencode/auth.json).
mkdir -p "${DATA_DIR}/agent-state/opencode/share" /home/node/.local/share
[ -f "${DATA_DIR}/agent-state/opencode/share/auth.json" ] || \
  cp /home/node/.local/share/opencode/auth.json \
     "${DATA_DIR}/agent-state/opencode/share/auth.json" 2>/dev/null || true
ln -sfn "${DATA_DIR}/agent-state/opencode/share" /home/node/.local/share/opencode

echo "[t3code] starting server on 0.0.0.0:3773"
exec t3 serve --host 0.0.0.0 --port 3773
