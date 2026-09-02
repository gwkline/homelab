#!/bin/sh
# Fixture task for the factory worker image (#74): proves the full run
# contract offline — a fixture "agent" edits a repository, the verify command
# runs, and a patch + structured report are emitted WITHOUT pushing anything.
# Also proves graceful shutdown (SIGTERM) preserves artifacts but scrubs
# credentials. Runs the real entrypoint.sh with TASK_DIR/OUT_DIR/WORK_DIR
# redirected to a temp dir; the origin is a local git remote (file://), so no
# network and no real credentials are involved.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/apps/factory/worker/entrypoint.sh"

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

# --- fixture origin repository ------------------------------------------------
mkdir -p "${FIX}/origin"
git -C "${FIX}/origin" init -q -b main .
git -C "${FIX}/origin" config user.email fixture@localhost
git -C "${FIX}/origin" config user.name fixture
echo "hello" > "${FIX}/origin/README.md"
printf 'true\n' > "${FIX}/origin/test.sh"
git -C "${FIX}/origin" add -A
git -C "${FIX}/origin" commit -qm init

# --- agent shims (the real coding CLIs are replaced by controlled stubs) ------
mkdir -p "${FIX}/bin"
cat > "${FIX}/bin/fake-cli" << 'EOF'
#!/bin/sh
# Minimal agent: edits the repo, exits 0. Repo is the cwd the worker gave it.
echo "fixture agent: editing README.md"
echo "patched by fixture" >> README.md
EOF
chmod +x "${FIX}/bin/fake-cli"
cat > "${FIX}/bin/slow-cli" << 'EOF'
#!/bin/sh
# Agent that ignores the task and blocks until killed (for the shutdown test).
trap 'exit 143' TERM
while :; do sleep 1; done
EOF
chmod +x "${FIX}/bin/slow-cli"

# --- 1. happy path: edit -> verify -> patch + report, no push ------------------
mkdir -p "${FIX}/task" "${FIX}/out" "${FIX}/work"
cat > "${FIX}/task/brief.json" << 'EOF'
{
  "run_id": "fixture-1",
  "repository": "example/fixture",
  "issue": { "number": 1, "title": "fixture task", "body": "append a line to README.md" },
  "constraints": ["minimal diff"],
  "verify_command": "sh test.sh"
}
EOF

GH_TOKEN=fixture-secret-token \
CLONE_URL="file://${FIX}/origin" \
WORKER_CMD=fake-cli WORKER_TIMEOUT=30 \
TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/out" WORK_DIR="${FIX}/work" \
HOME="${FIX}/home" \
PATH="${FIX}/bin:${PATH}" \
  sh "${ENTRYPOINT}" > "${FIX}/log" 2>&1

test -s "${FIX}/out/patch.diff" || { echo "FAIL: no patch artifact emitted"; cat "${FIX}/log"; exit 1; }
grep -q "patched by fixture" "${FIX}/out/patch.diff" \
  || { echo "FAIL: patch does not contain the fixture edit"; exit 1; }
grep -q '"success": true' "${FIX}/out/report.json" \
  || { echo "FAIL: report not successful"; cat "${FIX}/out/report.json"; exit 1; }
grep -q '"tests": "passed"' "${FIX}/out/report.json" \
  || { echo "FAIL: verify not recorded as passed"; cat "${FIX}/out/report.json"; exit 1; }
git -C "${FIX}/work/repo" remote get-url origin | grep -q "fixture-secret-token" \
  && { echo "FAIL: token leaked into clone remote"; exit 1; } || true
grep -q "fixture-secret-token" "${FIX}/out/patch.diff" \
  && { echo "FAIL: token leaked into patch"; exit 1; } || true
# Typed input + pinned skills installed into the agent home.
grep -q "pinned" "${FIX}/log" || { echo "FAIL: skills not installed"; cat "${FIX}/log"; exit 1; }
test -f "${FIX}/home/.claude/skills/p-stack/SKILL.md" \
  || { echo "FAIL: skills not present in agent home"; exit 1; }
echo "PASS: fixture task edits repo, passes verify, emits patch + report (no push)"

# --- 2. invalid run input is rejected (typed input contract) -------------------
mkdir -p "${FIX}/task-bad" "${FIX}/out-bad" "${FIX}/work-bad"
cat > "${FIX}/task-bad/brief.json" << 'EOF'
{ "run_id": "", "repository": "not-owner-slash-repo", "issue": { "number": "one" } }
EOF
if GH_TOKEN=x CLONE_URL="file://${FIX}/origin" WORKER_CMD=fake-cli \
   TASK_DIR="${FIX}/task-bad" OUT_DIR="${FIX}/out-bad" WORK_DIR="${FIX}/work-bad" \
   HOME="${FIX}/home" PATH="${FIX}/bin:${PATH}" \
   sh "${ENTRYPOINT}" > "${FIX}/log-bad" 2>&1; then
  echo "FAIL: invalid brief was accepted"; exit 1
fi
grep -q "schema validation" "${FIX}/log-bad" || { echo "FAIL: no validation error"; cat "${FIX}/log-bad"; exit 1; }
echo "PASS: invalid run input rejected with schema validation"

# --- 3. graceful shutdown: artifacts preserved, credentials scrubbed -----------
mkdir -p "${FIX}/out-term" "${FIX}/work-term"
mkdir -p "${FIX}/home-term/.local/share/opencode"
printf '{"openrouter":{"key":"sk-fixture-key"}}' > "${FIX}/home-term/.local/share/opencode/auth.json"

GH_TOKEN=fixture-secret-token \
CLONE_URL="file://${FIX}/origin" \
WORKER_CMD=slow-cli WORKER_TIMEOUT=60 \
TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/out-term" WORK_DIR="${FIX}/work-term" \
HOME="${FIX}/home-term" \
PATH="${FIX}/bin:${PATH}" \
  sh "${ENTRYPOINT}" > "${FIX}/log-term" 2>&1 &
EPID=$!
# Wait until the clone is done (repo exists) before signalling.
i=0
while [ ! -d "${FIX}/work-term/repo/.git" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.2; done
sleep 1
kill -TERM "$EPID"
RC=0
wait "$EPID" || RC=$?
[ "$RC" -ne 0 ] || { echo "FAIL: interrupted run exited 0"; cat "${FIX}/log-term"; exit 1; }
grep -q '"tests": "interrupted"' "${FIX}/out-term/report.json" \
  || { echo "FAIL: no interrupted report"; cat "${FIX}/out-term/report.json"; exit 1; }
test ! -f "${FIX}/home-term/.local/share/opencode/auth.json" \
  || { echo "FAIL: credentials survived shutdown"; exit 1; }
echo "PASS: graceful shutdown preserves report, scrubs credentials (exit ${RC})"

echo "ALL FIXTURE TESTS PASSED"
