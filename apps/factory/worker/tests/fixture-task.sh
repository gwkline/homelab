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
# When PROMPT_DUMP is set it keeps the exact prompt it received (#86) so tests
# can assert what the agent was told, and it attributes any supplied citation
# id it saw using the context-used convention.
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
# The brief carries a cited knowledge section (#86): status ok, one citation
# with full provenance (source kind/file + url null proves the schema's union
# types). The fixture agent must see it as UNTRUSTED reference data and
# attribute it in the report.
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
# Knowledge context (#86): cited, labeled untrusted, delivered to the agent,
# attributed in the report.
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

echo "ALL FIXTURE TESTS PASSED"
