#!/bin/sh
# Context A/B for coding-run briefs: runs the same fixture task through the
# worker entrypoint with and without a knowledge section and prints both
# outcomes plus the delta as JSON. Only the run contract gates; whether
# context helped is recorded, never asserted.
#
# Point WORKER_CMD at a real coding CLI and CLONE_URL at a real repo for a
# model-level A/B.
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

# --- deterministic fixture agent ------------------------------------------------
# Makes the same edit either way, so knowledge context is the only variable.
mkdir -p "${FIX}/bin"
cat > "${FIX}/bin/ctx-cli" << 'EOF'
#!/bin/sh
cat > "${PROMPT_DUMP:?}"
if grep -q '\[K1\]' "${PROMPT_DUMP:?}"; then
  echo "context-used: K1"
else
  echo "context-used: none"
fi
echo "patched by fixture" >> README.md
EOF
chmod +x "${FIX}/bin/ctx-cli"

run_fixture() { # $1=run-id  $2=brief-file  $3=out-dir  $4=work-dir  $5=prompt-dump
  mkdir -p "${3}" "${4}"
  GH_TOKEN=fixture-secret-token \
    CLONE_URL="file://${FIX}/origin" \
    WORKER_CMD=ctx-cli WORKER_TIMEOUT=60 \
    PROMPT_DUMP="${5}" \
    TASK_DIR="$(dirname "${2}")" OUT_DIR="${3}" WORK_DIR="${4}" \
    HOME="${FIX}/home-${1}" \
    PATH="${FIX}/bin:${PATH}" \
    sh "${ENTRYPOINT}" > "${FIX}/log-${1}" 2>&1
}

# --- brief: identical task, with vs without the knowledge section --------------
cat > "${FIX}/brief-with.json" << 'EOF'
{
  "run_id": "ctx-eval-with",
  "repository": "example/fixture",
  "issue": { "number": 1, "title": "fixture task", "body": "append a line to README.md" },
  "constraints": ["minimal diff"],
  "verify_command": "sh test.sh",
  "knowledge": {
    "status": "ok",
    "error": null,
    "namespace": "eval-docs",
    "service_run_ids": ["run_eval_fixture"],
    "queries": [{ "kind": "title", "query": "fixture append a line to README.md", "results": 1 }],
    "retrieval": { "mode": "hybrid", "top_k": 5, "timeout_seconds": 5, "budget_chars": 6000, "max_chunks": 8, "max_sources": 4, "min_score": 0 },
    "citations": [
      {
        "id": "K1",
        "chunk_id": "ch-eval-1",
        "document_id": "doc-eval-1",
        "title": "Fixture conventions",
        "text": "Fixture convention: README edits append exactly one line; tests live in test.sh.",
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
# Derived with jq so the two briefs are otherwise byte-identical.
jq 'del(.knowledge)' "${FIX}/brief-with.json" > "${FIX}/brief-without.json"

run_fixture with "${FIX}/brief-with.json" "${FIX}/out-with" "${FIX}/work-with" "${FIX}/prompt-with.txt"
run_fixture without "${FIX}/brief-without.json" "${FIX}/out-without" "${FIX}/work-without" "${FIX}/prompt-without.txt"

# --- contract gate: BOTH arms must satisfy the run contract ---------------------
for arm in with without; do
  test -s "${FIX}/out-${arm}/patch.diff" || { echo "FAIL: ${arm} run emitted no patch"; cat "${FIX}/log-${arm}"; exit 1; }
  grep -q "patched by fixture" "${FIX}/out-${arm}/patch.diff" \
    || { echo "FAIL: ${arm} run patch missing the fixture edit"; exit 1; }
  grep -q '"success": true' "${FIX}/out-${arm}/report.json" \
    || { echo "FAIL: ${arm} run report not successful"; cat "${FIX}/out-${arm}/report.json"; exit 1; }
  grep -q '"tests": "passed"' "${FIX}/out-${arm}/report.json" \
    || { echo "FAIL: ${arm} run verify not passed"; cat "${FIX}/out-${arm}/report.json"; exit 1; }
done
echo "PASS: both arms satisfy the run contract (patch + verify + valid report)"

# --- delivery assertions: context actually reached the agent only when supplied --
grep -q "UNTRUSTED DATA" "${FIX}/prompt-with.txt" \
  || { echo "FAIL: with-context prompt lacks the untrusted-data labeling"; exit 1; }
grep -q '\[K1\]' "${FIX}/prompt-with.txt" \
  || { echo "FAIL: with-context prompt lacks the citation"; exit 1; }
if grep -q "UNTRUSTED DATA" "${FIX}/prompt-without.txt"; then
  echo "FAIL: without-context prompt must not contain a knowledge section"; exit 1
fi

# --- recorded comparison (data, not a pass/fail gate) ---------------------------
mv "${FIX}/out-with/report.json" "${FIX}/report-with.json"
mv "${FIX}/out-without/report.json" "${FIX}/report-without.json"
python3 - "${FIX}" << 'EOF'
import json, sys

fix = sys.argv[1]


def arm(name):
    with open(f"{fix}/report-{name}.json", encoding="utf-8") as fh:
        r = json.load(fh)
    return {
        "run_id": r.get("run_id"),
        "success": r.get("success"),
        "tests": r.get("tests"),
        "knowledge_status": (r.get("knowledge") or {}).get("status"),
        "citations_supplied": (r.get("knowledge") or {}).get("supplied"),
        "citations_used": (r.get("knowledge") or {}).get("used"),
    }


comparison = {
    "eval": "context-ab-v1",
    "task": "fixture: append a line to README.md (identical otherwise)",
    "with_context": arm("with"),
    "without_context": arm("without"),
    "delta": {
        "context_attributed": arm("with")["citations_used"] or [],
        "context_available_to_without_arm": False,
    },
    "note": "comparison recorded for trend review; the gate is the run contract, not that context helped",
}
print(json.dumps(comparison, indent=2))
EOF