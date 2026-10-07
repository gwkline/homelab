#!/bin/sh
# Offline run-contract test for the worker entrypoint: a stub agent edits a
# local file:// origin, verify runs, and a patch + report are emitted without
# pushing. Also checks schema rejection, that SIGTERM keeps artifacts but
# scrubs credentials, that agent state never rides in a patch, and that after
# the `prepare` clone step the agent's process tree holds no GitHub token.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
ENTRYPOINT="${REPO_ROOT}/apps/factory/worker/entrypoint.sh"
PREPARE="${REPO_ROOT}/apps/factory/worker/prepare.sh"

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
# PROMPT_DUMP captures the prompt; a seen [K1] citation is attributed via the
# context-used convention.
cat > "${PROMPT_DUMP:-/dev/null}"
if grep -q '\[K1\]' "${PROMPT_DUMP:-/dev/null}"; then
  echo "context-used: K1"
fi
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
# One cited knowledge chunk (url null exercises the schema's union type).
mkdir -p "${FIX}/task" "${FIX}/out" "${FIX}/work"
cat > "${FIX}/task/brief.json" << 'EOF'
{
  "run_id": "fixture-1",
  "repository": "example/fixture",
  "issue": { "number": 1, "title": "fixture task", "body": "append a line to README.md" },
  "constraints": ["minimal diff"],
  "verify_command": "sh test.sh",
  "knowledge": {
    "status": "ok",
    "error": null,
    "namespace": "fixture-docs",
    "service_run_ids": ["run_fixture"],
    "queries": [{ "kind": "title", "query": "fixture append a line to README.md", "results": 1 }],
    "retrieval": { "mode": "hybrid", "top_k": 5, "timeout_seconds": 5, "budget_chars": 6000, "max_chunks": 8, "max_sources": 4, "min_score": 0 },
    "citations": [
      {
        "id": "K1",
        "chunk_id": "ch-fixture-1",
        "document_id": "doc-fixture-1",
        "title": "Fixture conventions",
        "text": "Fixture convention: README edits append exactly one line and tests live in test.sh.",
        "score": 0.0328,
        "retrieved_by": ["title"],
        "source": { "kind": "file", "source_id": "docs/conventions.md", "path": "docs/conventions.md", "url": null },
        "version": { "version_id": "v1", "commit": "abc123", "created_at": "2026-09-01T00:00:00Z", "status": "current" },
        "anchors": [{ "type": "heading", "value": "Conventions" }]
      }
    ]
  }
}
EOF

GH_TOKEN=fixture-secret-token \
CLONE_URL="file://${FIX}/origin" \
WORKER_CMD=fake-cli WORKER_TIMEOUT=30 \
PROMPT_DUMP="${FIX}/prompt.txt" \
TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/out" WORK_DIR="${FIX}/work" \
HOME="${FIX}/home" \
PATH="${FIX}/bin:${PATH}" \
  sh "${ENTRYPOINT}" > "${FIX}/log" 2>&1 \
  || { echo "FAIL: happy-path run exited non-zero"; cat "${FIX}/log"; exit 1; }

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
# Pinned skills installed into the agent home.
grep -q "pinned" "${FIX}/log" || { echo "FAIL: skills not installed"; cat "${FIX}/log"; exit 1; }
test -f "${FIX}/home/.claude/skills/p-stack/SKILL.md" \
  || { echo "FAIL: skills not present in agent home"; exit 1; }
# Knowledge context: labeled untrusted in the prompt, attributed in the report.
grep -q "UNTRUSTED DATA" "${FIX}/prompt.txt" \
  || { echo "FAIL: knowledge context not labeled untrusted in prompt"; cat "${FIX}/prompt.txt"; exit 1; }
grep -q "^\[K1\] Fixture conventions — docs/conventions.md" "${FIX}/prompt.txt" \
  || { echo "FAIL: citation header missing from prompt"; cat "${FIX}/prompt.txt"; exit 1; }
grep -q "Fixture convention: README edits append exactly one line" "${FIX}/prompt.txt" \
  || { echo "FAIL: citation text missing from prompt"; cat "${FIX}/prompt.txt"; exit 1; }
grep -q '"status": "ok"' "${FIX}/out/report.json" \
  || { echo "FAIL: knowledge status not in report"; cat "${FIX}/out/report.json"; exit 1; }
grep -q '"supplied": 1' "${FIX}/out/report.json" \
  || { echo "FAIL: supplied citation count not in report"; cat "${FIX}/out/report.json"; exit 1; }
grep -q '"used": \[' "${FIX}/out/report.json" \
  && grep -q '"K1"' "${FIX}/out/report.json" \
  || { echo "FAIL: citation attribution missing from report"; cat "${FIX}/out/report.json"; exit 1; }
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

# run_case <name> <agent-cli> [VAR=value ...]: one entrypoint run against the
# fixture origin; artifacts under ${FIX}/<name>, exit status in RC.
run_case() {
  _name="$1" _cli="$2"
  shift 2
  mkdir -p "${FIX}/${_name}/out" "${FIX}/${_name}/work"
  RC=0
  env GH_TOKEN=fixture-secret-token CLONE_URL="file://${FIX}/origin" \
    WORKER_CMD="${_cli}" WORKER_TIMEOUT=30 \
    TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/${_name}/out" WORK_DIR="${FIX}/${_name}/work" \
    HOME="${FIX}/${_name}/home" PATH="${FIX}/bin:${PATH}" "$@" \
    sh "${ENTRYPOINT}" > "${FIX}/${_name}/log" 2>&1 || RC=$?
}

# --- 4. agent state written into the clone stays out of the patch -------------
cat > "${FIX}/bin/stray-cli" << 'EOF'
#!/bin/sh
# Agent that runs a tool with HOME inside the repo, then does the task.
mkdir -p h1/.local/share/opencode .cursor/cache
printf 'sqlite' > h1/.local/share/opencode/opencode.db
printf 'wal' > h1/.local/share/opencode/opencode.db-wal
printf '{}' > .cursor/cache/state.json
echo "patched by fixture" >> README.md
EOF
chmod +x "${FIX}/bin/stray-cli"
run_case stray stray-cli
[ "$RC" -eq 0 ] || { echo "FAIL: stray-state run exited ${RC}"; cat "${FIX}/stray/log"; exit 1; }
grep -q "patched by fixture" "${FIX}/stray/out/patch.diff" \
  || { echo "FAIL: stray-state patch lost the task edit"; exit 1; }
if grep -qE 'opencode\.db|\.cursor/' "${FIX}/stray/out/patch.diff"; then
  echo "FAIL: agent state leaked into the patch"; grep '^diff' "${FIX}/stray/out/patch.diff"; exit 1
fi
grep -qE '^\[worker\] patch: [0-9]+ bytes \(cap 524288\)' "${FIX}/stray/log" \
  || { echo "FAIL: patch size not logged"; cat "${FIX}/stray/log"; exit 1; }
echo "PASS: stray h1/.local/share/opencode/opencode.db and .cursor/ stay out of the patch"

# --- 5. state that gets past the excludes rejects the run ---------------------
cat > "${FIX}/bin/commit-state-cli" << 'EOF'
#!/bin/sh
# Agent that force-adds and commits a cache, bypassing the excludes.
mkdir -p h2/.cache/tool
printf 'blob' > h2/.cache/tool/state.bin
echo "patched by fixture" >> README.md
git add -f h2 README.md
git -c user.name=agent -c user.email=agent@localhost commit -qm "agent commit"
EOF
chmod +x "${FIX}/bin/commit-state-cli"
run_case committed commit-state-cli
[ "$RC" -eq 65 ] || { echo "FAIL: committed state should exit 65, got ${RC}"; cat "${FIX}/committed/log"; exit 1; }
test ! -e "${FIX}/committed/out/patch.diff" || { echo "FAIL: rejected run left a patch"; exit 1; }
grep -q '"tests": "rejected"' "${FIX}/committed/out/report.json" \
  || { echo "FAIL: rejection not reported"; cat "${FIX}/committed/out/report.json"; exit 1; }
grep -q "h2/.cache/tool/state.bin" "${FIX}/committed/log" \
  || { echo "FAIL: rejection does not name the state path"; cat "${FIX}/committed/log"; exit 1; }
echo "PASS: committed agent state rejects the run (exit 65, no patch)"

# --- 6. the patch size cap is enforced -----------------------------------------
run_case oversize fake-cli WORKER_PATCH_MAX_BYTES=64
[ "$RC" -eq 65 ] || { echo "FAIL: oversize patch should exit 65, got ${RC}"; cat "${FIX}/oversize/log"; exit 1; }
grep -q "over the 64-byte cap" "${FIX}/oversize/log" \
  || { echo "FAIL: size-cap rejection not logged"; cat "${FIX}/oversize/log"; exit 1; }
test ! -e "${FIX}/oversize/out/patch.diff" || { echo "FAIL: oversize run left a patch"; exit 1; }
echo "PASS: a patch over WORKER_PATCH_MAX_BYTES is rejected"

# --- 7. HOME inside the clone is refused before any work -----------------------
run_case homeinrepo fake-cli HOME="${FIX}/homeinrepo/work/repo/h"
[ "$RC" -eq 78 ] || { echo "FAIL: HOME inside the clone should exit 78, got ${RC}"; cat "${FIX}/homeinrepo/log"; exit 1; }
echo "PASS: HOME inside the clone is refused"

# --- 8. initContainer split: the agent's process tree holds no GitHub token ----
mkdir -p "${FIX}/prepared/work" "${FIX}/prepared/out"
RC=0
GH_TOKEN=fixture-secret-token FACTORY_REPO=example/fixture \
CLONE_URL="file://${FIX}/origin" WORK_DIR="${FIX}/prepared/work" HOME="${FIX}/prepared/init-home" \
  sh "${PREPARE}" > "${FIX}/prepared/prepare.log" 2>&1 || RC=$?
[ "$RC" -eq 0 ] || { echo "FAIL: prepare exited ${RC}"; cat "${FIX}/prepared/prepare.log"; exit 1; }
[ "$(git -C "${FIX}/prepared/work/repo" remote get-url origin)" = "https://github.com/example/fixture.git" ] \
  || { echo "FAIL: prepare left a non-canonical origin"; exit 1; }
if grep -rq "fixture-secret-token" "${FIX}/prepared/work"; then
  echo "FAIL: prepare left the token on the shared volume"; exit 1
fi

cat > "${FIX}/bin/environ-cli" << 'EOF'
#!/bin/sh
# Agent that records whether it, or the entrypoint (PID 1 in the pod; the
# parent of `timeout`), carries a GitHub token, then does the task.
entry=$(awk '/^PPid:/ { print $2 }' "/proc/${PPID}/status")
{
  if tr '\0' '\n' < "/proc/${entry}/environ" | grep -qE '^(GH_TOKEN|GITHUB_TOKEN)='; then echo "entrypoint: token"; else echo "entrypoint: clean"; fi
  if env | grep -qE '^(GH_TOKEN|GITHUB_TOKEN)='; then echo "agent: token"; else echo "agent: clean"; fi
} > "${ENVIRON_DUMP}"
echo "patched by fixture" >> README.md
EOF
chmod +x "${FIX}/bin/environ-cli"
RC=0
env WORKER_CMD=environ-cli WORKER_TIMEOUT=30 ENVIRON_DUMP="${FIX}/prepared/environ.txt" \
  TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/prepared/out" WORK_DIR="${FIX}/prepared/work" \
  HOME="${FIX}/prepared/home" PATH="${FIX}/bin:${PATH}" \
  sh "${ENTRYPOINT}" > "${FIX}/prepared/log" 2>&1 || RC=$?
[ "$RC" -eq 0 ] || { echo "FAIL: prepared run exited ${RC}"; cat "${FIX}/prepared/log"; exit 1; }
grep -q "patched by fixture" "${FIX}/prepared/out/patch.diff" \
  || { echo "FAIL: prepared run emitted no task patch"; exit 1; }
[ "$(cat "${FIX}/prepared/environ.txt")" = "entrypoint: clean
agent: clean" ] || { echo "FAIL: GitHub token reachable from the agent"; cat "${FIX}/prepared/environ.txt"; exit 1; }
echo "PASS: after prepare, the entrypoint's /proc environ and the agent's env hold no GitHub token"

# Control: without the split the token is still in the entrypoint's environ
# after `unset`, which is why the clone moved to an initContainer.
run_case legacy-environ environ-cli ENVIRON_DUMP="${FIX}/legacy-environ.txt"
[ "$RC" -eq 0 ] || { echo "FAIL: legacy run exited ${RC}"; cat "${FIX}/legacy-environ/log"; exit 1; }
grep -qx "entrypoint: token" "${FIX}/legacy-environ.txt" \
  || { echo "FAIL: environ probe cannot see a token it should"; cat "${FIX}/legacy-environ.txt"; exit 1; }
grep -qx "agent: clean" "${FIX}/legacy-environ.txt" \
  || { echo "FAIL: legacy path leaked the token into the agent env"; exit 1; }

# A prepared clone plus a token in the agent container is a Job-spec regression.
mkdir -p "${FIX}/prepared/out-tok"
RC=0
env GH_TOKEN=fixture-secret-token WORKER_CMD=fake-cli WORKER_TIMEOUT=30 \
  TASK_DIR="${FIX}/task" OUT_DIR="${FIX}/prepared/out-tok" WORK_DIR="${FIX}/prepared/work" \
  HOME="${FIX}/prepared/home" PATH="${FIX}/bin:${PATH}" \
  sh "${ENTRYPOINT}" > "${FIX}/prepared/log-tok" 2>&1 || RC=$?
[ "$RC" -eq 78 ] || { echo "FAIL: token beside a prepared clone should exit 78, got ${RC}"; cat "${FIX}/prepared/log-tok"; exit 1; }
echo "PASS: a GitHub token beside a prepared clone is refused"

# --- 9. cannot attempt: a missing required input is its own status --------------
# The generated OpenCode config is valid JSON under `set -u`.
run_case ocjson fake-cli OPENCODE_AUTH_B64="$(printf '{"openrouter":{"key":"sk-fixture"}}' | base64 -w0)"
[ "$RC" -eq 0 ] || { echo "FAIL: run with a model key exited ${RC}"; cat "${FIX}/ocjson/log"; exit 1; }
python3 -m json.tool "${FIX}/ocjson/home/.config/opencode/opencode.jsonc" > /dev/null \
  || { echo "FAIL: generated OpenCode config is not valid JSON"; exit 1; }

# An opencode profile without its model key stops before the agent runs.
run_case nokey fake-cli WORKER_CMD="opencode run"
[ "$RC" -eq 78 ] || { echo "FAIL: missing model key should exit 78, got ${RC}"; cat "${FIX}/nokey/log"; exit 1; }
grep -q '"tests": "cannot-attempt"' "${FIX}/nokey/out/report.json" \
  || { echo "FAIL: missing model key not reported as cannot-attempt"; cat "${FIX}/nokey/out/report.json"; exit 1; }
grep -q "CANNOT ATTEMPT: no model credential" "${FIX}/nokey/log" \
  || { echo "FAIL: no actionable reason for the missing key"; cat "${FIX}/nokey/log"; exit 1; }

# Required private skills that fail to sync stop the clone step with a reason.
mkdir -p "${FIX}/skills/work"
RC=0
FACTORY_REPO=example/fixture CLONE_URL="file://${FIX}/origin" WORK_DIR="${FIX}/skills/work" \
  HOME="${FIX}/skills/home" SKILLS_REF=0123456789abcdef0123456789abcdef01234567 \
  SKILLS_REPO_URL="file://${FIX}/no-such-skills-repo" SKILLS_TARGET="${FIX}/skills/target" \
  SKILLS_WORKDIR="${FIX}/skills/sync" SKILLS_STATUS_FILE="${FIX}/skills/status.json" \
  sh "${PREPARE}" > "${FIX}/skills/log" 2>&1 || RC=$?
[ "$RC" -eq 78 ] || { echo "FAIL: failed skills sync should exit 78, got ${RC}"; cat "${FIX}/skills/log"; exit 1; }
grep -q "CANNOT ATTEMPT: private skills sync failed" "${FIX}/skills/log" \
  || { echo "FAIL: no actionable reason for the skills failure"; cat "${FIX}/skills/log"; exit 1; }
echo "PASS: a missing model key or failed skills sync is cannot-attempt (exit 78), with a reason"

echo "ALL FIXTURE TESTS PASSED"
