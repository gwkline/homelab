#!/bin/sh
# Entrypoint for t3code pods: auth git, sync repos, register projects, serve.
set -eu

. /usr/local/lib/workspace-lib.sh

# gh CLI reads GH_TOKEN, not GITHUB_TOKEN_FILE: bridge the mounted secret
# into the environment before anything (sync_repos, t3) shells out to gh.
if [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
  GH_TOKEN="$(cat "${GITHUB_TOKEN_FILE}")"
  GITHUB_TOKEN="${GH_TOKEN}"
  export GH_TOKEN GITHUB_TOKEN
fi
setup_git_auth
# A mounted writer token, if any, takes over GH_TOKEN.
setup_gh_cli

DATA_DIR="${DATA_DIR:-/data}"
REPOS_DIR="${DATA_DIR}/repos"

# Agent CLI state lives in the container; restore it from the PVC and write
# changes back every 60s so logins and config survive rollouts. Caches, logs
# and repo clones stay container-local:
#   claude, codex          ~/.claude, ~/.codex
#   opencode (stable+beta) ~/.config/opencode, ~/.local/share/opencode
#                          (auth.json, opencode.db*; not log/ or repos/)
#   cursor-agent           ~/.config/cursor/auth.json, ~/.cursor/cli-config.json
#                          (not projects/)
STATE_SRC="${DATA_DIR}/agent-state"
OC_SHARE="/home/node/.local/share/opencode"

# sync_dirs <from> <to> [excluded-names...]: merge-copy the children of
# <from> into <to>, skipping the excluded top-level names.
sync_dirs() {
  _from="$1"; _to="$2"; shift 2
  [ -d "${_from}" ] || return 0
  mkdir -p "${_to}"
  for _child in "${_from}"/* "${_from}"/.[!.]* "${_from}"/..?*; do
    [ -e "${_child}" ] || continue
    _name=${_child##*/}
    for _x in "$@"; do
      if [ "${_name}" = "${_x}" ]; then continue 2; fi
    done
    cp -a "${_child}" "${_to}/" 2>/dev/null || true
  done
}

for _d in .claude .codex .config/opencode .config/cursor; do
  sync_dirs "${STATE_SRC}/${_d}" "/home/node/${_d}"
done
# Older images symlinked the whole opencode share dir onto the PVC.
if [ -L "${OC_SHARE}" ]; then rm -f "${OC_SHARE}"; fi
sync_dirs "${STATE_SRC}/opencode/share" "${OC_SHARE}" log repos
sync_dirs "${STATE_SRC}/cursor" "/home/node/.cursor" projects
(
  while :; do
    sleep 60
    for _d in .claude .codex .config/opencode .config/cursor; do
      sync_dirs "/home/node/${_d}" "${STATE_SRC}/${_d}"
    done
    sync_dirs "${OC_SHARE}" "${STATE_SRC}/opencode/share" log repos
    sync_dirs "/home/node/.cursor" "${STATE_SRC}/cursor" projects
  done
) &
echo "[t3code] agent-state sync started (${STATE_SRC})"

# Link the skills-sync init container's store into the CLIs' skill dirs.
# This runs after the agent-state restore so a restored file can never write
# through a fresh symlink. A failed sync warns and serves without skills.
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

# Agents here are driven through t3, so per-command permission prompts
# defeat the point. Seed a permissive opencode config (only if none was
# restored) and trust every synced repo in claude: untrusted folders make
# claude ignore the repo's own .claude/settings.json allowlist.
OC_CONFIG="/home/node/.config/opencode/opencode.json"
if [ ! -f "${OC_CONFIG}" ]; then
  mkdir -p /home/node/.config/opencode
  cat > "${OC_CONFIG}" <<'__OC__'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "read": "allow",
    "glob": "allow",
    "grep": "allow",
    "list": "allow",
    "edit": "allow",
    "external_directory": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "bash": {
      "*": "allow",
      "rm -rf *": "ask",
      "sudo *": "deny"
    }
  }
}
__OC__
fi
if command -v python3 >/dev/null 2>&1 && [ -d "${REPOS_DIR}" ]; then
  python3 - "${REPOS_DIR}" <<'__PY__' || echo "[t3code] WARN: claude trust seed failed"
import json, os, sys

repos = sys.argv[1]
cfg = os.path.expanduser("~/.claude.json")
try:
    with open(cfg) as f:
        d = json.load(f)
except Exception:
    d = {}
projects = d.setdefault("projects", {})
for name in sorted(os.listdir(repos)):
    path = os.path.join(repos, name)
    if os.path.isdir(os.path.join(path, ".git")):
        projects[path] = {"hasTrustDialogAccepted": True}
with open(cfg, "w") as f:
    json.dump(d, f, indent=2)
__PY__
fi

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

# Enable the opencode provider (the same file the UI toggle writes).
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

echo "[t3code] starting server on 0.0.0.0:3773"
exec t3 serve --host 0.0.0.0 --port 3773
