#!/bin/sh
# Factory worker entrypoint (#74).
# Contract (ADR-002 / factory-v1-github-ledger.md):
#   /task/brief.json   input: run_id, repository, issue, verify_command
#   /work/<repo>       clone, make changes here
#   /out/patch.diff    git diff of the change
#   /out/report.json   structured result {success, summary, tests}
#   exit 0             success; non-zero = failed attempt
set -eu


# opencode auth: decode from env (base64 auth.json) if provided.
if [ -n "${OPENCODE_AUTH_B64:-}" ]; then
  mkdir -p /home/node/.local/share/opencode
  printf '%s' "${OPENCODE_AUTH_B64}" | base64 -d > /home/node/.local/share/opencode/auth.json
fi

BRIEF="/task/brief.json"
OUT="/out"

# Brief arrives via env (base64 JSON) or mounted file — support both.
if [ -n "${FACTORY_BRIEF_B64:-}" ] && [ ! -f "${BRIEF}" ]; then
  mkdir -p /task
  printf '%s' "${FACTORY_BRIEF_B64}" | base64 -d > "${BRIEF}"
fi

[ -f "${BRIEF}" ] || { echo "[worker] FATAL: no ${BRIEF}" >&2; exit 78; }

REPO=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['repository'])")
VERIFY=$(python3 -c "import json;print(json.load(open('${BRIEF}')).get('verify_command',''))" 2>/dev/null || echo "")
ISSUE_NUM=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['issue']['number'])")
RUN_ID=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['run_id'])")

echo "[worker] run=${RUN_ID} repo=${REPO} issue=#${ISSUE_NUM}"

# --- clone (read-only public https or token-injected remote by orchestrator)
# Private repos need the token; public clones work with the plain URL too.
CLONE_URL="${CLONE_URL:-https://github.com/${REPO}.git}"
git clone --depth 20 "${CLONE_URL}" repo
git -C repo remote set-url origin "https://github.com/${REPO}.git"
cd repo
BASE_SHA=$(git rev-parse HEAD)

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
{b['issue'].get('body','')}

Rules:
- Implement the change described above. Keep it minimal and focused.
- Do NOT touch files outside the scope of the task.
- {'Run `' + b.get('verify_command','') + '` and make it pass.' if b.get('verify_command') else 'Ensure the project still builds/tests cleanly.'}
- When done, print a one-paragraph summary of what changed and why.""")
EOF
  # shellcheck disable=SC2086
  ${WORKER_CMD} < /tmp/task-prompt.txt || {
    echo "[worker] agent command failed" >&2
    printf '{"success": false, "summary": "agent CLI failed", "tests": null}\n' > "${OUT}/report.json"
    exit 1
  }
else
  echo "[worker] FATAL: WORKER_CMD not set by profile" >&2
  exit 78
fi

# --- capture patch --------------------------------------------------------
git add -A
if git diff --cached --quiet; then
  echo "[worker] no changes produced"
  printf '{"success": false, "summary": "worker made no changes", "tests": null}\n' > "${OUT}/report.json"
  exit 1
fi
git diff --cached --binary > "${OUT}/patch.diff"

# --- verification ----------------------------------------------------------
TESTS="not-run"
if [ -n "${VERIFY}" ]; then
  echo "[worker] running verify: ${VERIFY}"
  if sh -c "${VERIFY}"; then TESTS="passed"; else TESTS="failed"; fi
else
  TESTS="no-command-configured"
fi

SUMMARY=$(tail -5 /tmp/task-prompt-output.log 2>/dev/null | head -c 500 || echo "see patch")

python3 - "$TESTS" "$SUMMARY" "$BASE_SHA" << 'EOF' > "${OUT}/report.json"
import json, sys
print(json.dumps({
    "success": sys.argv[1] in ("passed", "no-command-configured"),
    "summary": sys.argv[2],
    "tests": sys.argv[1],
    "base_sha": sys.argv[3],
}, indent=2))
EOF

cat "${OUT}/report.json"
[ "${TESTS}" != "failed" ]
