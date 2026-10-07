#!/bin/sh
# Offline end-to-end ticks of run.sh (gh and kubectl shimmed, a local origin).
# An ordinary patch becomes a pushed branch and a draft PR. These are parked
# for a human instead: a patch touching a merge-gate path, an issue needing a
# capability its profile lacks, and a run that cannot be attempted. An
# ordinary failure still retries.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FIX="$(mktemp -d)"
trap 'rm -rf "${FIX}"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
export GIT_CONFIG_GLOBAL="${FIX}/gitconfig"
git config --global user.name fixture
git config --global user.email fixture@localhost
git config --global init.defaultBranch main

# --- origin: main with a README and a CI workflow -----------------------------------
git init -q --bare "${FIX}/origin.git"
git clone -q "${FIX}/origin.git" "${FIX}/seed" 2> /dev/null
mkdir -p "${FIX}/seed/.github/workflows"
echo "hello" > "${FIX}/seed/README.md"
echo "name: ci" > "${FIX}/seed/.github/workflows/ci.yaml"
git -C "${FIX}/seed" add -A
git -C "${FIX}/seed" commit -qm init
git -C "${FIX}/seed" push -q origin HEAD:main

patch_for() { # $1 = path to append a line to → git patch on stdout
  git -C "${FIX}/seed" checkout -q -- .
  echo "edited by the agent" >> "${FIX}/seed/$1"
  git -C "${FIX}/seed" diff
  git -C "${FIX}/seed" checkout -q -- .
}

# --- shims ------------------------------------------------------------------------------
mkdir -p "${FIX}/bin"
awk '/profile\.json: \|/ { on = 1; next } on && /^    / { sub(/^    /, ""); print; next } on { exit }' \
  "${ROOT}/deploy/factory/base/profile-code-pr.yaml" > "${FIX}/profile.json"

cat > "${FIX}/bin/kubectl" << 'EOF'
#!/bin/sh
# The worker Job ends at once: completes with the fixture patch in its pod
# log, or (JOB_FAILED set) fails with EXIT_CODES and JOB_LOG.
echo "kubectl $*" >> "${FIX}/kubectl.log"
case "$*" in
  *"get configmap"*) cat "${FIX}/profile.json" ;;
  "apply -f "*) echo "job.batch/x created" ;;
  *"get job"*Complete*) [ -n "${JOB_FAILED:-}" ] || echo True ;;
  *"get job"*Failed*) [ -z "${JOB_FAILED:-}" ] || echo True ;;
  *"get pods"*exitCode*) echo "${EXIT_CODES:-}" ;;
  *"get pods"*) echo worker-pod ;;
  *"logs job/"*) printf '%s\n' "${JOB_LOG:-}" ;;
  *"logs -n sandbox worker-pod -c worker"*)
    echo "---PATCH_B64_BEGIN---"
    base64 -w0 "${FIX}/patch.diff"
    echo
    echo "---PATCH_B64_END---"
    ;;
esac
EOF
cat > "${FIX}/bin/gh" << 'EOF'
#!/bin/sh
# Serves one queued issue (labelled with NEEDS, one earlier run marker);
# records every call in gh.log.
echo "gh $*" >> "${FIX}/gh.log"
case "$*" in
  "auth status") ;;
  *"issues?labels=factory/in-progress"*) ;;
  *"issues?labels=factory/queued"*) echo "${ISSUE}" ;;
  "api repos/"*"/issues/${ISSUE} --jq .title") echo "Fixture issue" ;;
  "api repos/"*"/issues/${ISSUE} --jq [.labels"*) echo "${NEEDS:-}" ;;
  *"issues/${ISSUE}/comments?per_page=100"*) echo 1 ;;
  "pr list"*) echo 0 ;;
  "issue comment ${ISSUE}"*) echo "https://github.com/gwkline/homelab/issues/${ISSUE}#issuecomment-99" ;;
  "issue view"*) printf '{"number":%s,"title":"Fixture issue","body":"edit a file","url":"u"}\n' "${ISSUE}" ;;
  "pr create"*) echo "https://github.com/gwkline/homelab/pull/500" ;;
  *"issues/comments/99"*)
    for a in "$@"; do case "$a" in body=*) printf '%s\n' "${a#body=}" > "${FIX}/status.md" ;; esac; done
    ;;
esac
EOF
chmod +x "${FIX}/bin/kubectl" "${FIX}/bin/gh"

tick() { # $1 = issue number, rest = env assignments; runs one orchestrator tick
  _issue="$1"
  shift
  : > "${FIX}/gh.log"
  : > "${FIX}/kubectl.log"
  env FIX="${FIX}" ISSUE="${_issue}" FACTORY_REPO=gwkline/homelab GH_TOKEN=fixture-token \
    GH_BIN="${FIX}/bin/gh" KUBECTL_BIN="${FIX}/bin/kubectl" \
    FACTORY_PUBLISH_REMOTE="file://${FIX}/origin.git" PATH="${FIX}/bin:${PATH}" "$@" \
    sh "${ROOT}/apps/factory/orchestrator/run.sh" > "${FIX}/tick-${_issue}.log" 2>&1 \
    || { cat "${FIX}/tick-${_issue}.log"; fail "tick for #${_issue} exited non-zero"; }
}
branch_exists() { git -C "${FIX}/origin.git" rev-parse -q --verify "refs/heads/factory/issue-$1/code-pr" > /dev/null; }

# --- 1. an ordinary patch is pushed and opened as a draft PR ---------------------------
patch_for README.md > "${FIX}/patch.diff"
tick 41
branch_exists 41 || { cat "${FIX}/tick-41.log"; fail "ordinary patch was not pushed"; }
grep -q '^gh pr create .*--draft' "${FIX}/gh.log" || fail "ordinary patch did not open a draft PR"
grep -q "issue edit 41 .*--add-label factory/draft-pr" "${FIX}/gh.log" || fail "issue not moved to factory/draft-pr"
echo "PASS: an ordinary patch is pushed and opened as a draft PR"

# --- 2. a patch to the CI workflow is parked: no push, no PR ---------------------------
patch_for .github/workflows/ci.yaml > "${FIX}/patch.diff"
tick 42
if branch_exists 42; then fail "a workflow patch was pushed"; fi
if grep -q '^gh pr create' "${FIX}/gh.log"; then fail "a workflow patch opened a PR"; fi
grep -q "issue edit 42 .*--add-label factory/failed --add-label factory/stuck" "${FIX}/gh.log" \
  || fail "workflow patch not parked on factory/stuck"
grep -q '\.github/workflows/ci\.yaml' "${FIX}/status.md" || fail "run comment does not name the protected path"
grep -q "not published" "${FIX}/tick-42.log" || fail "orchestrator did not log why"
echo "PASS: a patch touching .github/ is parked on factory/stuck without a push or a PR"

# --- 3. an issue needing a capability its profile lacks is parked unrun ---------------
tick 43 NEEDS=cluster
if grep -q "^kubectl apply" "${FIX}/kubectl.log"; then fail "needs:cluster issue spawned a worker"; fi
grep -q "issue edit 43 .*--remove-label factory/queued --add-label factory/failed --add-label factory/stuck" "${FIX}/gh.log" \
  || fail "needs:cluster issue not parked on factory/stuck"
grep -q "issue comment 43 .*Not attemptable in profile \`code-pr\`: this issue needs cluster" "${FIX}/gh.log" \
  || fail "no 'not attemptable' comment for needs:cluster"
echo "PASS: an issue labelled needs:cluster is parked on the first pick with a reason"

# --- 4. cannot attempt (exit 78) is parked with its reason, never retried --------------
tick 44 JOB_FAILED=1 EXIT_CODES="78 " \
  JOB_LOG="[prepare] CANNOT ATTEMPT: private skills sync failed (Authentication failed); check that the github-token Secret can read the skills repo"
grep -q "issue edit 44 .*--remove-label factory/in-progress --add-label factory/failed --add-label factory/stuck" "${FIX}/gh.log" \
  || fail "cannot-attempt run not parked on factory/stuck"
if grep -q "issue edit 44 .*--add-label factory/queued" "${FIX}/gh.log"; then fail "cannot-attempt run was requeued"; fi
grep -q "Cannot attempt:\*\* private skills sync failed (Authentication failed)" "${FIX}/status.md" \
  || { cat "${FIX}/status.md"; fail "run comment lacks the actionable reason"; }
echo "PASS: a skills-auth failure (exit 78) is parked with its reason and not retried"

# --- 5. control: an ordinary agent failure is still retried ----------------------------
tick 45 JOB_FAILED=1 EXIT_CODES="0 1" JOB_LOG="[worker] agent command failed (exit 1)"
grep -q "issue edit 45 .*--remove-label factory/in-progress --add-label factory/queued" "${FIX}/gh.log" \
  || fail "an ordinary failure was not requeued for its retry"
echo "PASS: an ordinary worker failure is still requeued for one retry"
