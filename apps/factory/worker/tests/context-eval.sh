#!/bin/sh
# Context A/B evaluation for coding-run briefs (#86, acceptance: "compares
# fixture task results with and without context rather than assuming
# improvement").
#
# Runs the SAME fixture task twice through the real worker entrypoint — once
# with a cited knowledge section in the brief, once without — and records both
# outcomes plus the delta as JSON on stdout. The gate is the run CONTRACT:
# both runs must emit a patch, pass verify, and produce a valid report.
# Whether context improved the outcome is RECORDED, never assumed: this
# script does not fail (and must never be made to fail) because the
# with-context run was not better — the comparison data feeds trend review
# like apps/knowledge/eval does for retrieval.
#
# Model-level A/B: the same harness replays real tasks by pointing
# WORKER_CMD at a real coding CLI with a real CLONE_URL; the fixture agent is
# only the deterministic offline default.
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
# Echos the prompt it received, attributes citation K1 when the prompt carried
# one (context-used convention), and makes the same minimal edit either way —
# so the ONLY variable between runs is the presence of knowledge context.
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
# Without-context brief = with-context brief minus the knowledge section
# (jq removal keeps the two runs byte-identical otherwise).
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
        # Both arms pass the contract here; the delta is the attribution
        # signal only. A real model-level A/B would compare quality too.
        "context_attributed": arm("with")["citations_used"] or [],
        "context_available_to_without_arm": False,
    },
    "note": "comparison recorded for trend review; the gate is the run contract, not that context helped",
}
print(json.dumps(comparison, indent=2))
EOF