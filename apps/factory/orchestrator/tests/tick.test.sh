#!/bin/sh
# Offline end-to-end ticks of run.sh (gh and kubectl shimmed, a local origin).
# An ordinary patch becomes a pushed branch and a draft PR. These are parked
# for a human instead: a patch touching a merge-gate path, an issue needing a
# capability its profile lacks, and a run that cannot be attempted. An
# ordinary failure still retries. A medic requeue (queued marker on the PR)
# turns the tick into a repair run on the PR branch; a requeue without a live
# red PR is skipped or handed back instead.
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
  "apply -f "*)
    # Keep the rendered Job so tests can inspect the clone ref and the brief.
    cp /tmp/worker-job.json "${FIX}/worker-job.json" 2>/dev/null || true
    echo "job.batch/x created"
    ;;
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
# Serves one queued issue (labelled with NEEDS, one earlier run marker); a PR
# (PR_HEAD_SHA + PR_NUMBER) and its medic/check fixtures for repair ticks.
# Records every call in gh.log.
echo "gh $*" >> "${FIX}/gh.log"
if [ -z "${CHECKS_JSON:-}" ]; then CHECKS_JSON='{"check_runs":[]}'; fi
case "$*" in
  "auth status") ;;
  *"issues?labels=factory/in-progress"*) ;;
  *"issues?labels=factory/queued"*) echo "${ISSUE}" ;;
  "api repos/"*"/issues/${ISSUE} --jq .title") echo "Fixture issue" ;;
  "api repos/"*"/issues/${ISSUE} --jq [.labels"*) echo "${NEEDS:-}" ;;
  *"issues/${ISSUE}/comments?per_page=100"*) echo 1 ;;
  *--paginate*) printf '%s\n' "${PR_COMMENTS:-[]}" ;;
  *"commits/"*"check-runs"*) printf '%s\n' "${CHECKS_JSON}" ;;
  "pr list"*)
    if [ -n "${PR_HEAD_SHA:-}" ]; then
      printf '[{"number":%s,"headRefOid":"%s"}]\n' "${PR_NUMBER:-500}" "${PR_HEAD_SHA}"
    else
      echo '[]'
    fi
    ;;
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

# A ci-red factory branch for the medic-repair scenarios: one commit on
# factory/issue-46/code-pr with a deliberately broken shell file.
git -C "${FIX}/seed" checkout -qb factory/issue-46/code-pr
printf '#!/bin/sh\necho (broken\n' > "${FIX}/seed/broken.sh"
git -C "${FIX}/seed" add -A
git -C "${FIX}/seed" commit -qm "break: deliberate red head"
git -C "${FIX}/seed" push -q origin factory/issue-46/code-pr
MEDIC_SHA="$(git -C "${FIX}/seed" rev-parse HEAD)"
MAIN_SHA="$(git -C "${FIX}/seed" rev-parse main)"
git -C "${FIX}/seed" checkout -q main
# The medic's requeue marker, posted on the PR for the pinned head.
PR_COMMENTS="$(printf '[ [ {"body": "<!-- factory:medic:%s:queued -->\\n## 🩺 Factory Medic brief — repair this ci-red PR"} ] ]' "${MEDIC_SHA}")"
RED_CHECKS='{"check_runs":[{"name":"ci / verify","conclusion":"failure","output":{"summary":"shellcheck failed on broken.sh"}}]}'
GREEN_CHECKS='{"check_runs":[{"name":"ci / verify","conclusion":"success","output":{"summary":"ok"}}]}'

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

# --- 6. a medic requeue on a red PR runs a repair worker on the PR branch --------------
patch_for README.md > "${FIX}/patch.diff"
tick 46 PR_HEAD_SHA="${MEDIC_SHA}" PR_NUMBER=507 PR_COMMENTS="${PR_COMMENTS}" CHECKS_JSON="${RED_CHECKS}"
grep -q '^kubectl apply' "${FIX}/kubectl.log" \
  || { cat "${FIX}/tick-46.log"; fail "medic requeue did not spawn a repair worker"; }
if grep -q '^gh pr create' "${FIX}/gh.log"; then fail "a repair opened a second PR"; fi
grep -q "issue edit 46 .*--remove-label factory/in-progress --add-label factory/draft-pr" "${FIX}/gh.log" \
  || fail "repaired issue not moved to factory/draft-pr"
# The fix landed on the SAME branch, one commit on top of the pinned head.
[ "$(git -C "${FIX}/origin.git" rev-parse "refs/heads/factory/issue-46/code-pr^")" = "${MEDIC_SHA}" ] \
  || fail "repair commit is not on top of the medic-pinned head"
git -C "${FIX}/origin.git" log -1 --format=%s refs/heads/factory/issue-46/code-pr | grep -q "factory(medic): repair #46" \
  || fail "repair commit message wrong"
grep -q "Repair pushed to" "${FIX}/status.md" || { cat "${FIX}/status.md"; fail "run comment does not record the repair"; }
# The clone checks out the PR branch and the brief carries PR, pinned head and checks.
jq -e --arg b "factory/issue-46/code-pr" \
  '.spec.template.spec.initContainers[0].env | any(.name == "FACTORY_CLONE_REF" and .value == $b)' \
  "${FIX}/worker-job.json" > /dev/null || fail "repair Job does not clone the PR branch"
jq -r '.spec.template.spec.containers[0].env[] | select(.name == "FACTORY_BRIEF_B64") | .value' \
  "${FIX}/worker-job.json" | base64 -d | jq -e --arg sha "${MEDIC_SHA}" \
  '.repair.pr == 507 and .repair.branch == "factory/issue-46/code-pr" and .repair.head_sha == $sha
    and (.repair.failing_checks | contains("ci / verify"))' > /dev/null \
  || fail "repair brief lacks the PR, pinned head or failing checks"
echo "PASS: a medic requeue on a red PR runs a repair worker on the PR branch"

# --- 7. control: a PR without a medic requeue is still skipped as a duplicate ----------
tick 47 PR_HEAD_SHA="${MEDIC_SHA}" PR_NUMBER=508
if grep -q '^kubectl apply' "${FIX}/kubectl.log"; then fail "duplicate-PR skip spawned a worker"; fi
grep -q "issue edit 47 .*--remove-label factory/queued --remove-label factory/in-progress --add-label factory/draft-pr" "${FIX}/gh.log" \
  || fail "duplicate-PR issue not converged to factory/draft-pr"
echo "PASS: a PR without a medic requeue is still skipped as a duplicate"

# --- 8. a stale medic requeue (branch moved) is handed back, not run --------------------
tick 48 PR_HEAD_SHA="${MAIN_SHA}" PR_NUMBER=508 PR_COMMENTS="${PR_COMMENTS}" CHECKS_JSON="${RED_CHECKS}"
if grep -q '^kubectl apply' "${FIX}/kubectl.log"; then fail "stale medic requeue spawned a worker"; fi
grep -q "issue edit 48 .*--remove-label factory/queued --add-label factory/draft-pr" "${FIX}/gh.log" \
  || fail "stale medic requeue not handed back to factory/draft-pr"
echo "PASS: a stale medic requeue is handed back without a run"

# --- 9. a medic requeue on a green PR is not repaired -----------------------------------
tick 49 PR_HEAD_SHA="${MEDIC_SHA}" PR_NUMBER=509 PR_COMMENTS="${PR_COMMENTS}" CHECKS_JSON="${GREEN_CHECKS}"
if grep -q '^kubectl apply' "${FIX}/kubectl.log"; then fail "a green PR with a medic requeue spawned a worker"; fi
grep -q "issue edit 49 .*--remove-label factory/queued --add-label factory/draft-pr" "${FIX}/gh.log" \
  || fail "green PR with a medic requeue not handed back to factory/draft-pr"
echo "PASS: a green PR with a medic requeue is left to the reviewer"
