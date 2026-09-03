#!/bin/sh
# Factory worker entrypoint (#74).
# Contract (ADR-002 / factory-v1-github-ledger.md):
#   /task/brief.json   input: run_id, repository, issue, profile, verify_command
#   /work/<repo>       clone, make changes here
#   /out/patch.diff    git diff of the change
#   /out/report.json   structured result {success, summary, tests, base_sha, run_id, profile}
#   exit 0             success; non-zero = failed attempt
#   exit 78            invalid run input / misconfiguration
#
# Credential boundaries (#74): repository + model credentials arrive ONLY at
# runtime — as env from a Secret, or as files mounted under /run/secrets.
# They are never baked into the image, never written to /out or the repo, and
# are scrubbed on every exit path: graceful shutdown (SIGTERM/SIGINT) keeps
# the result artifacts but deletes the decoded credentials.
set -eu

TASK_DIR="${TASK_DIR:-/task}"
OUT_DIR="${OUT_DIR:-/out}"
WORK_DIR="${WORK_DIR:-/work}"
# Contract assets: image layout puts them under /usr/local/share/worker, the
# checkout layout puts them next to this script (used by the fixture tests).
_ENTRYPOINT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${SCHEMA:-}" ]; then
  if [ -f /usr/local/share/worker/brief.schema.json ]; then
    SCHEMA=/usr/local/share/worker/brief.schema.json
  else
    SCHEMA="${_ENTRYPOINT_DIR}/brief.schema.json"
  fi
fi
if [ -n "${FACTORY_SKILLS_DIR:-}" ]; then
  SKILLS_SRC="${FACTORY_SKILLS_DIR}"
elif [ -d /usr/local/share/worker/skills ]; then
  SKILLS_SRC=/usr/local/share/worker/skills
else
  SKILLS_SRC="${_ENTRYPOINT_DIR}/skills"
fi
OC_AUTH_FILE="${HOME}/.local/share/opencode/auth.json"
OC_CONFIG_FILE="${HOME}/.config/opencode/opencode.jsonc"

AGENT_PID=""
SHUTDOWN=0

# --- signal handling: graceful shutdown -------------------------------------
# SIGTERM/SIGINT (kubectl delete / activeDeadline / preemption): stop the
# agent, capture whatever patch exists, write a report, scrub credentials.
on_signal() {
  SHUTDOWN=1
  if [ -n "${AGENT_PID}" ]; then
    kill -TERM "${AGENT_PID}" 2>/dev/null || true
  fi
}

scrub_credentials() {
  rm -f "${OC_AUTH_FILE}" 2>/dev/null || true
  rm -f /tmp/task-prompt.txt 2>/dev/null || true
  unset GH_TOKEN GITHUB_TOKEN OPENCODE_AUTH_B64 OPENROUTER_API_KEY FACTORY_BRIEF_B64 || true
}

write_report() { # $1=tests-status  $2=summary  [$3=base_sha]  [$4=run_id]  [$5=profile]
  python3 - "$1" "$2" "${3:-}" "${4:-}" "${5:-}" << 'EOF' > "${OUT_DIR}/report.json.tmp"
import json, sys
tests, summary, base_sha, run_id, profile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
doc = {"success": tests in ("passed", "no-command-configured"),
       "summary": summary, "tests": tests or None}
if base_sha:
    doc["base_sha"] = base_sha
if run_id:
    doc["run_id"] = run_id
if profile:
    doc["profile"] = profile
# Run metadata (#81): which private-skills commit this run was built with.
try:
    doc["skills_sync"] = json.load(open("/out/skills-sync.json"))
except Exception:
    doc["skills_sync"] = None
print(json.dumps(doc, indent=2))
EOF
  mv "${OUT_DIR}/report.json.tmp" "${OUT_DIR}/report.json"
}

emit_artifacts() { # b64 markers on pod logs — the orchestrator's extraction path
  if [ -s "${OUT_DIR}/patch.diff" ]; then
    echo "---PATCH_B64_BEGIN---"
    base64 -w0 "${OUT_DIR}/patch.diff"
    echo ""
    echo "---PATCH_B64_END---"
  fi
  if [ -s "${OUT_DIR}/report.json" ]; then
    echo "---REPORT_B64_BEGIN---"
    base64 -w0 "${OUT_DIR}/report.json"
    echo ""
    echo "---REPORT_B64_END---"
  fi
}

interrupted_exit() {
  echo "[worker] SIGTERM/SIGINT received — preserving artifacts, scrubbing credentials" >&2
  if [ -d "${WORK_DIR}/repo" ]; then
    # Partial work is still a result: capture the diff as of the interruption.
    git -C "${WORK_DIR}/repo" add -A 2>/dev/null || true
    git -C "${WORK_DIR}/repo" diff --cached --binary > "${OUT_DIR}/patch.diff" 2>/dev/null || true
    [ -s "${OUT_DIR}/patch.diff" ] || rm -f "${OUT_DIR}/patch.diff"
  fi
  write_report "interrupted" "run interrupted by SIGTERM/SIGINT (artifacts preserved, credentials scrubbed)"
  emit_artifacts
  exit 143
}

agent_wait() {
  AGENT_RC=0
  wait "${AGENT_PID}" || AGENT_RC=$?
  # If the signal landed before the kill could target the agent, reap it now.
  if [ "${SHUTDOWN}" = "1" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
    wait "${AGENT_PID}" 2>/dev/null || true
  fi
}

trap on_signal TERM INT
trap scrub_credentials EXIT

mkdir -p "${OUT_DIR}"

# --- credentials: runtime-only mounts/exports --------------------------------
# Repository credential: prefer a mounted token file over env (both are
# runtime-only; the file mount keeps tokens out of Job specs entirely).
if [ -z "${GH_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN_FILE:-}" ] && [ -r "${GITHUB_TOKEN_FILE}" ]; then
  GH_TOKEN="$(tr -d '[:space:]' < "${GITHUB_TOKEN_FILE}")"
  export GH_TOKEN
fi

# opencode auth + config: raw JSON or base64(JSON) from env or mounted file.
OC_AUTH_INPUT="${OPENCODE_AUTH_B64:-}"
if [ -z "${OC_AUTH_INPUT}" ] && [ -n "${OPENCODE_AUTH_FILE:-}" ] && [ -r "${OPENCODE_AUTH_FILE}" ]; then
  OC_AUTH_INPUT="$(cat "${OPENCODE_AUTH_FILE}")"
fi
if [ -n "${OC_AUTH_INPUT}" ]; then
  mkdir -p "${HOME}/.local/share/opencode" "${HOME}/.config/opencode"
  # The value may be raw JSON or base64(JSON) depending on how the secret was
  # created — validate, and decode once if needed.
  printf '%s' "${OC_AUTH_INPUT}" | python3 -c "
import json, sys, base64
v = sys.stdin.read().strip()
try:
    json.loads(v); print(v)  # already raw JSON
except json.JSONDecodeError:
    print(base64.b64decode(v).decode())
" > "${OC_AUTH_FILE}"
  # npm provider requires the key as env too:
  OPENROUTER_API_KEY=$(python3 -c "import json;print(json.load(open('${OC_AUTH_FILE}'))['openrouter']['key'])")
  export OPENROUTER_API_KEY

  # Force openrouter as THE provider — no zen router, no nous fallback.
  cat > "${OC_CONFIG_FILE}" <<'OCEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": {
      "npm": "@openrouter/ai-sdk-provider",
      "name": "OpenRouter",
      "options": { "baseURL": "https://openrouter.ai/api/v1" }
    }
  },
  "model": "openrouter/z-ai/glm-5.3-flash"
}
OCEOF
fi

# --- typed run input ----------------------------------------------------------
BRIEF="${TASK_DIR}/brief.json"

# ---------------------------------------------------------------------------
# Pinned private skills (#81): apps/shared/skills-lib.sh builds the generated
# store at $SKILLS_TARGET from the pinned commit (SKILLS_REF, verified) with
# only the allowlisted skill paths, then links into the coding CLIs' skill
# dir. Auth is the read-only GH_TOKEN via throwaway GIT_ASKPASS — nothing
# lands in Git config. Degrade explicitly on failure: loud warning, the run
# continues WITHOUT private skills, and the status (recorded commit included)
# lands in /out/skills-sync.json and the final run report.
# ---------------------------------------------------------------------------
. /usr/local/lib/skills-lib.sh
SKILLS_SYNC_RC=0
skills_sync || SKILLS_SYNC_RC=$?
if [ "$SKILLS_SYNC_RC" -eq 0 ]; then
  for _skills_dir in /home/node/.claude/skills; do
    skills_link_generated "${SKILLS_TARGET}" "${_skills_dir}" \
      || echo "[worker] WARNING: skills link into ${_skills_dir} incomplete" >&2
  done
  echo "[worker] skills-sync: $(cat "${SKILLS_STATUS_FILE}")"
else
  echo "[worker] WARNING: skills sync FAILED (rc=${SKILLS_SYNC_RC}) — continuing WITHOUT private skills (see ${SKILLS_STATUS_FILE})" >&2
fi

# Brief arrives via env (base64 JSON) or mounted file — support both.
if [ -n "${FACTORY_BRIEF_B64:-}" ] && [ ! -f "${BRIEF}" ]; then
  mkdir -p "${TASK_DIR}"
  if printf '%s' "${FACTORY_BRIEF_B64}" | base64 -d > "${BRIEF}.tmp" 2>/dev/null \
     && python3 -m json.tool "${BRIEF}.tmp" > /dev/null 2>&1; then
    mv "${BRIEF}.tmp" "${BRIEF}"
  else
    rm -f "${BRIEF}.tmp"
    printf '%s' "${FACTORY_BRIEF_B64}" > "${BRIEF}"
  fi
fi

[ -f "${BRIEF}" ] || { echo "[worker] FATAL: no ${BRIEF}" >&2; exit 78; }

# Validate the brief against the schema before doing ANY work (#74 typed input).
if ! python3 - "${SCHEMA}" "${BRIEF}" << 'EOF'
import json, re, sys

schema = json.load(open(sys.argv[1]))
brief = json.load(open(sys.argv[2]))
errs = []

def check(inst, sch, path):
    t = sch.get("type")
    if t == "object":
        if not isinstance(inst, dict):
            errs.append(f"{path}: expected object")
            return
        for k in sch.get("required", []):
            if k not in inst:
                errs.append(f"{path}.{k}: missing required field")
        for k, v in inst.items():
            if k in sch.get("properties", {}):
                check(v, sch["properties"][k], f"{path}.{k}")
    elif t == "array":
        if not isinstance(inst, list):
            errs.append(f"{path}: expected array")
            return
        for i, v in enumerate(inst):
            check(v, sch.get("items", {}), f"{path}[{i}]")
    elif t == "integer":
        if isinstance(inst, bool) or not isinstance(inst, int):
            errs.append(f"{path}: expected integer")
            return
        if "minimum" in sch and inst < sch["minimum"]:
            errs.append(f"{path}: below minimum")
    elif t == "string":
        if not isinstance(inst, str):
            errs.append(f"{path}: expected string")
            return
        if len(inst) < sch.get("minLength", 0):
            errs.append(f"{path}: shorter than minLength")
        if "pattern" in sch and not re.search(sch["pattern"], inst):
            errs.append(f"{path}: does not match pattern {sch['pattern']}")

check(brief, schema, "brief")
if errs:
    print("; ".join(errs), file=sys.stderr)
    sys.exit(1)
EOF
then
  echo "[worker] FATAL: run input failed schema validation (see stderr above)" >&2
  exit 78
fi

REPO=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['repository'])")
VERIFY=$(python3 -c "import json;print(json.load(open('${BRIEF}')).get('verify_command',''))" 2>/dev/null || echo "")
ISSUE_NUM=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['issue']['number'])")
RUN_ID=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['run_id'])")
PROFILE=$(python3 -c "import json;print(json.load(open('${BRIEF}')).get('profile','unknown'))" 2>/dev/null || echo "unknown")

echo "[worker] run=${RUN_ID} repo=${REPO} issue=#${ISSUE_NUM}"

# --- clone (worker builds the authenticated URL from GH_TOKEN itself) --------
# Token never rides in the Job manifest (ADR D6); origin is scrubbed after
# clone so it doesn't leak into the emitted patch either.
GITGUARD="-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30"
CLONE_URL="${CLONE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git}"
mkdir -p "${WORK_DIR}"
cd "${WORK_DIR}"
# shellcheck disable=SC2086  # word-splitting is intended: GITGUARD is two -c flags
git ${GITGUARD} clone --depth 20 "${CLONE_URL}" repo || {
  echo "[worker] FATAL: clone failed (or stalled >30s)" >&2
  write_report "clone-failed" "clone failed or stalled"
  emit_artifacts
  exit 1
}
git -C repo remote set-url origin "https://github.com/${REPO}.git"
# Credential boundary: the clone was the only authenticated operation. Drop
# the long-lived token BEFORE the agent runs so the coding CLI (and anything
# it executes) can never read or reuse it — publishing happens in the
# orchestrator, which holds the writer role.
unset GH_TOKEN GITHUB_TOKEN CLONE_URL

# Checkpoint: SIGTERM while cloning → bail out gracefully from here.
[ "${SHUTDOWN}" = "0" ] || interrupted_exit
cd repo
BASE_SHA=$(git rev-parse HEAD)

# --- pinned verification skills (#68) ----------------------------------------
# Runtime copies into the agent-global skill dirs; they never touch the repo
# (which would pollute the emitted patch) and are ephemeral with the pod.
if [ -f "${SKILLS_SRC}/manifest.json" ]; then
  for SKILL_DIR in "${HOME}/.claude/skills" "${HOME}/.config/opencode/skill"; do
    mkdir -p "${SKILL_DIR}"
    cp -r "${SKILLS_SRC}/." "${SKILL_DIR}/"
  done
  python3 - "${SKILLS_SRC}/manifest.json" << 'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
print(f"[worker] skills: {m['name']}@{m['version']} (pinned)")
EOF
else
  echo "[worker] WARNING: verification skills missing from image" >&2
fi

# --- let the agent do the work -------------------------------------------
# The coding CLI is chosen by the profile via $WORKER_CMD (default claude).
# It receives the task brief on stdin and operates autonomously.
if [ -n "${WORKER_CMD:-}" ]; then
  python3 - "$BRIEF" << 'EOF' > /tmp/task-prompt.txt
import json, sys
b = json.load(open(sys.argv[1]))
print(f"""You are an autonomous coding worker.
Repository: {b['repository']} (cloned at ./repo, you are already in it)
Issue #{b['issue']['number']}: {b['issue']['title']}
{b['issue'].get('body') or ''}

The p-stack verification skill is installed at ~/.claude/skills/p-stack
(~/.config/opencode/skill/p-stack): plan, patch, prove.

Rules:
- Implement the change described above. Keep it minimal and focused.
- Do NOT touch files outside the scope of the task.
- {'Run `' + b.get('verify_command','') + '` and make it pass.' if b.get('verify_command') else 'Ensure the project still builds/tests cleanly.'}
- When done, print a one-paragraph summary of what changed and why.""")
EOF
  # Hard ceiling on the agent command: a hung provider/model must not burn
  # the pod's whole 3600s budget (and a retry on top of it). 45 min leaves
  # time for clone + verify + artifact emission inside the deadline. The
  # redirect lives OUTSIDE the pipeline so $? stays the agent's exit code.
  # Backgrounded so SIGTERM can reach the agent for graceful shutdown.
  WORKER_TIMEOUT="${WORKER_TIMEOUT:-2700}"
  echo "[worker] agent budget: ${WORKER_TIMEOUT}s"
  # shellcheck disable=SC2086  # word-splitting is intended: WORKER_CMD is a command line
  timeout "${WORKER_TIMEOUT}" ${WORKER_CMD} < /tmp/task-prompt.txt > /tmp/task-prompt-output.log 2>&1 &
  AGENT_PID=$!
  agent_wait
  if [ "${SHUTDOWN}" = "1" ]; then
    interrupted_exit  # never returns
  fi
  if [ "${AGENT_RC}" != "0" ]; then
    if [ "${AGENT_RC}" = "124" ]; then
      echo "[worker] agent command TIMED OUT after ${WORKER_TIMEOUT}s" >&2
      SUMMARY="agent timed out after ${WORKER_TIMEOUT}s"
    else
      echo "[worker] agent command failed (exit ${AGENT_RC})" >&2
      SUMMARY="agent CLI failed (exit ${AGENT_RC})"
    fi
    tail -20 /tmp/task-prompt-output.log 2>/dev/null >&2 || true
    write_report "not-run" "${SUMMARY}"
    exit 1
  fi
else
  echo "[worker] FATAL: WORKER_CMD not set by profile" >&2
  exit 78
fi

# --- capture patch --------------------------------------------------------
git add -A
if git diff --cached --quiet; then
  echo "[worker] no changes produced"
  write_report "not-run" "worker made no changes"
  emit_artifacts
  exit 1
fi
git diff --cached --binary > "${OUT_DIR}/patch.diff"

# --- verification ----------------------------------------------------------
# The default verify for repos without a specific command is diff-scoped, not
# fixed-file: every changed *.sh gets parsed (dash -n is in the base image),
# so "verify passes" carries signal about the patch, not one arbitrary file.
TESTS="not-run"
if [ -n "${VERIFY}" ]; then
  echo "[worker] running verify: ${VERIFY}"
  if sh -c "${VERIFY}"; then TESTS="passed"; else TESTS="failed"; fi
else
  CHANGED_SH=$(git diff --cached --name-only --diff-filter=ACMR | grep '\.sh$' || true)
  if [ -n "${CHANGED_SH}" ]; then
    RC_VERIFY=0
    while IFS= read -r f; do
      echo "[worker] verify (dash -n): ${f}"
      dash -n "${f}" 2>&1 || RC_VERIFY=1
    done <<EOF
${CHANGED_SH}
EOF
    if [ "${RC_VERIFY}" = "0" ]; then TESTS="passed"; else TESTS="failed"; fi
  else
    TESTS="no-command-configured"
  fi
fi

# Audit trail: the agent's full output goes to pod logs on success too (the
# panel Runs UI and postmortems want the summary; before this it vanished).
echo "[worker] --- agent output (tail) ---"
tail -40 /tmp/task-prompt-output.log 2>/dev/null || true
echo "[worker] --- end agent output ---"
SUMMARY=$(tail -5 /tmp/task-prompt-output.log 2>/dev/null | head -c 500 || echo "see patch")

write_report "${TESTS}" "${SUMMARY}" "${BASE_SHA}" "${RUN_ID}" "${PROFILE}"

cat "${OUT_DIR}/report.json"

# Emit artifacts to pod logs (publisher extracts via kubectl logs, not kubectl cp
# which requires a Running container and fails on terminated Job pods).
emit_artifacts

[ "${TESTS}" != "failed" ]
