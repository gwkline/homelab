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

# Agent CLI state (logins, sessions, opencode config) lives in the container;
# restore it from the PVC and write changes back every 60s so it survives
# rollouts.
STATE_SRC="${DATA_DIR}/agent-state"
for _d in .claude .codex .config/opencode; do
  if [ -d "${STATE_SRC}/${_d}" ]; then
    mkdir -p "/home/node/${_d}"
    cp -a "${STATE_SRC}/${_d}/." "/home/node/${_d}/" 2>/dev/null || true
  fi
done
(
  while :; do
    sleep 60
    for _d in .claude .codex .config/opencode; do
      if [ -d "/home/node/${_d}" ]; then
        mkdir -p "${STATE_SRC}/${_d}"
        cp -a "/home/node/${_d}/." "${STATE_SRC}/${_d}/" 2>/dev/null || true
      fi
    done
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

# Keep opencode's auth.json on the PVC so it survives rollouts.
mkdir -p "${DATA_DIR}/agent-state/opencode/share" /home/node/.local/share
[ -f "${DATA_DIR}/agent-state/opencode/share/auth.json" ] || \
  cp /home/node/.local/share/opencode/auth.json \
     "${DATA_DIR}/agent-state/opencode/share/auth.json" 2>/dev/null || true
ln -sfn "${DATA_DIR}/agent-state/opencode/share" /home/node/.local/share/opencode

echo "[t3code] starting server on 0.0.0.0:3773"
exec t3 serve --host 0.0.0.0 --port 3773
