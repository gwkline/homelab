#!/bin/sh
# Factory security worker (# security) — harness-agnostic.
# Contract: same as code-pr so orchestrator + publisher reuse the path.
#   /task/brief.json  input: run_id, repository, issue{number,title,body}
#   /work/<repo>      clone
#   /out/patch.diff   git diff (empty if report-only)
#   /out/report.json  {success, summary, tests}
# Human-readable report also at /out/report.md and echoed to logs.
set -eu

BRIEF="/task/brief.json"
OUT="/out"

if [ -n "${FACTORY_BRIEF_B64:-}" ] && [ ! -f "${BRIEF}" ]; then
  mkdir -p /task
  python3 -c "
import json, sys, base64
v = sys.argv[1].strip()
try:
    d = base64.b64decode(v).decode(); json.loads(d)
except Exception:
    sys.exit(1)
" "${FACTORY_BRIEF_B64}" && printf '%s' "${FACTORY_BRIEF_B64}" | base64 -d > "${BRIEF}" || printf '%s' "${FACTORY_BRIEF_B64}" > "${BRIEF}"
fi

# Nightly mode needs no brief — synthesize a minimal one from env.
# (CronJob sets FACTORY_SECURITY_MODE=nightly + FACTORY_REPO but no brief.)
if [ ! -f "${BRIEF}" ] && [ "${FACTORY_SECURITY_MODE:-}" = "nightly" ] && [ -n "${FACTORY_REPO:-}" ]; then
  mkdir -p /task
  RUN_ID="nightly-$(date +%s)"
  printf '{"run_id":"%s","repository":"%s","issue":{"number":0,"title":"nightly sweep","body":""}}' \
    "${RUN_ID}" "${FACTORY_REPO}" > "${BRIEF}"
  echo "[security] synthesized nightly brief: repo=${FACTORY_REPO}"
fi

[ -f "${BRIEF}" ] || { echo "[security] FATAL: no ${BRIEF}" >&2; exit 78; }

REPO=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['repository'])")
ISSUE_NUM=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['issue']['number'])")
ISSUE_TITLE=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['issue'].get('title',''))")
# shellcheck disable=SC2034
ISSUE_BODY=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['issue'].get('body','') or '')")
RUN_ID=$(python3 -c "import json;print(json.load(open('${BRIEF}'))['run_id'])")
MODE="${FACTORY_SECURITY_MODE:-per-issue}"
if [ "${ISSUE_NUM}" = "" ] || [ "${ISSUE_NUM}" = "0" ]; then
  MODE="nightly"
fi

echo "[security] run=${RUN_ID} repo=${REPO} issue=#${ISSUE_NUM} mode=${MODE}"

# Build the authenticated URL at runtime; never put a token in a Job manifest.
CLONE_URL="${CLONE_URL:-https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git}"
git clone --depth 20 "${CLONE_URL}" repo
git -C repo remote set-url origin "https://github.com/${REPO}.git"
cd repo
BASE_SHA=$(git rev-parse HEAD)
mkdir -p "${OUT}"

# --- helpers ---
append() { printf '%s\n' "$1" >> "${OUT}/report.md"; }
run_section() {
  title="$1"; shift
  echo "[security] $title"
  append "### $title"
  append '```'
  # shellcheck disable=SC2068
  if $@ >> "${OUT}/report.md" 2>&1; then
    : # ok
  else
    append "(exit $?)"
  fi
  append '```'
  append ""
}

: > "${OUT}/report.md"
append "# Factory Security Report — ${REPO} #${ISSUE_NUM}: ${ISSUE_TITLE}"
append ""
append "- Run: \`${RUN_ID}\` · base \`${BASE_SHA}\` · mode \`${MODE}\`"
append "- Profile: \`security\` · $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "${MODE}" != "nightly" ]; then
  append "- Issue: #${ISSUE_NUM} — ${ISSUE_TITLE}"
fi
append ""

HARNESS=""
if grep -q "opencode" "${BRIEF}" 2>/dev/null; then HARNESS="opencode"; fi
if [ -n "${HARNESS}" ]; then append "_Harness tag (for triage): \`${HARNESS}\` — not enforced._"; append ""; fi

append "## Scope"
append "- Repo: \`${REPO}\` @ \`${BASE_SHA}\`"
append "- Scanners: gitleaks, shellcheck, hadolint, semgrep (best-effort), trivy (best-effort), kustomize verify, secret-pattern grep"
append ""

# shellcheck disable=SC2034
FAIL=0

run_section "gitleaks (secrets)" sh -c 'gitleaks detect --no-git --source . --verbose 2>&1 | head -n 300; echo "gitleaks exit $?"'
run_section "shellcheck (factory shell)" sh -c 'shellcheck apps/factory/security/entrypoint.sh apps/factory/orchestrator/run.sh apps/factory/worker/entrypoint.sh 2>&1 | head -n 200; echo "shellcheck exit $?"'
run_section "hadolint (Dockerfiles)" sh -c 'hadolint apps/factory/security/Dockerfile 2>&1 | head -n 200; echo "hadolint worker:"; hadolint apps/factory/worker/Dockerfile 2>&1 | head -n 100; echo "hadolint orchestrator:"; hadolint apps/factory/orchestrator/Dockerfile 2>&1 | head -n 100'
run_section "kustomize verify (deploy/factory)" sh -c 'kubectl kustomize deploy/factory/base 2>&1 | head -n 50; echo "kustomize exit $?"'
run_section "secret-pattern grep (verify.sh pattern)" sh -c 'PAT=$(sed -n "s/.*pattern=.\\(.*\\)./\\1/p" scripts/verify.sh 2>/dev/null); grep -rnE "$PAT" --exclude-dir=.git --exclude=scripts/verify.sh . 2>&1 | head -n 100; echo "grep exit $?"'
if command -v semgrep >/dev/null 2>&1; then
  run_section "semgrep (SAST, p/ci)" sh -c 'semgrep --config p/ci --error --timeout 120 2>&1 | head -n 400; echo "semgrep exit $?"'
else
  append "### semgrep (SAST, p/ci) — skipped (not installed)"
  append '```'
  append "semgrep not found"
  append '```'
fi
if command -v trivy >/dev/null 2>&1; then
  run_section "trivy fs (HIGH,CRITICAL)" sh -c 'trivy fs --severity HIGH,CRITICAL --ignore-unfixed --format table . 2>&1 | head -n 300; echo "trivy exit $?"'
fi

# Summarize: did anything look bad?
if grep -qi "leak\|secret\|HIGH\|CRITICAL\|error\|fail" "${OUT}/report.md" 2>/dev/null; then
  # keep report; don't auto-fail for sweep — human reviews
  :
fi

# For per-issue mode, optionally draft a minimal patch if the issue is actionable
# (harness-agnostic: no LLM — only deterministic fix stubs). For v1, patch is empty
# so the run is report-only; publisher will still post the marker comment + report.
git diff --quiet || git diff --binary > "${OUT}/patch.diff" 2>/dev/null || true
if [ ! -f "${OUT}/patch.diff" ]; then : > "${OUT}/patch.diff"; fi

python3 - "${BASE_SHA}" << 'PY' > "${OUT}/report.json"
import json, sys, pathlib
report = pathlib.Path("/out/report.md").read_text()[:8000] if pathlib.Path("/out/report.md").exists() else ""
print(json.dumps({
    "success": True,
    "summary": report[:500].replace("\n", " "),
    "tests": "report-only",
    "base_sha": sys.argv[1],
    "mode": "security",
}, indent=2))
PY

cat "${OUT}/report.json"
echo "---PATCH_B64_BEGIN---"
base64 -w0 "${OUT}/patch.diff" 2>/dev/null || true; echo ""
echo "---PATCH_B64_END---"
echo "---REPORT_B64_BEGIN---"
base64 -w0 "${OUT}/report.json" 2>/dev/null || true; echo ""
echo "---REPORT_B64_END---"
# Also emit report.md b64 for publisher convenience
echo "---REPORT_MD_B64_BEGIN---"
base64 -w0 "${OUT}/report.md" 2>/dev/null || true; echo ""
echo "---REPORT_MD_B64_END---"

exit 0
