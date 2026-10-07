#!/bin/sh
# Offline end-to-end tick of run.sh (gh and kubectl shimmed, a local origin):
# an ordinary patch becomes a pushed branch and a draft PR, and a patch that
# touches a merge-gate path (here the CI workflow) is parked without a push
# or a PR.
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
# The worker Job completes at once; its pod log carries the fixture patch.
case "$*" in
  *"get configmap"*) cat "${FIX}/profile.json" ;;
  "apply -f "*) echo "job.batch/x created" ;;
  *"get job"*Complete*) echo True ;;
  *"get job"*) ;;
  *"get pods"*) echo worker-pod ;;
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
# Serves one queued issue; records every write in gh.log.
echo "gh $*" >> "${FIX}/gh.log"
case "$*" in
  "auth status") ;;
  *"issues?labels=factory/in-progress"*) ;;
  *"issues?labels=factory/queued"*) echo "${ISSUE}" ;;
  "api repos/"*"/issues/${ISSUE} --jq .title") echo "Fixture issue" ;;
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

tick() { # $1 = issue number; runs one orchestrator tick
  : > "${FIX}/gh.log"
  env FIX="${FIX}" ISSUE="$1" FACTORY_REPO=gwkline/homelab GH_TOKEN=fixture-token \
    GH_BIN="${FIX}/bin/gh" KUBECTL_BIN="${FIX}/bin/kubectl" \
    FACTORY_PUBLISH_REMOTE="file://${FIX}/origin.git" PATH="${FIX}/bin:${PATH}" \
    sh "${ROOT}/apps/factory/orchestrator/run.sh" > "${FIX}/tick-$1.log" 2>&1 \
    || { cat "${FIX}/tick-$1.log"; fail "tick for #$1 exited non-zero"; }
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
