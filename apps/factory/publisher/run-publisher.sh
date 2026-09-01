#!/bin/sh
# Factory publisher (#79): trusted artifact → clean checkout → branch → draft PR.
#
# This is the ONLY component in the factory that pushes branches or opens PRs
# (ADR-001 D6 / ADR-002). It runs as a per-run publisher Job or is invoked by
# the orchestrator after a successful worker. Coding workers never receive the
# publisher credential: the write token is a short-lived GitHub App
# installation token minted by the #70 token service and injected here (env
# GH_TOKEN or a mounted token file via GH_TOKEN_FILE) — never in the worker
# brief, never in a Job manifest the worker can read.
#
# Inputs (env, unless noted):
#   FACTORY_REPO          owner/name (required)
#   FACTORY_ISSUE         issue number (required)
#   FACTORY_PROFILE       profile name          (default code-pr)
#   FACTORY_RUN_ID        run id                (default issue<N>-<N>)
#   FACTORY_ISSUE_TITLE   issue title for the PR title (else fetched via gh)
#   FACTORY_PATCH_FILE    patch artifact path   (default /out/patch.diff)
#   FACTORY_REPORT_FILE   worker report.json    (default /out/report.json, optional)
#   FACTORY_BASE_SHA      expected base revision (else report.base_sha, optional)
#   FACTORY_EXPECTED_PATHS comma-separated path prefixes the patch may touch
#   FACTORY_REPOS         repo allowlist (same defaults as orchestrator)
#   FACTORY_MAX_PATCH_BYTES     max patch artifact size (default 2 MiB)
#   FACTORY_MAX_CHANGED_FILES   max changed files       (default 50)
#   FACTORY_MAX_CHANGED_LINES   max added+removed lines (default 4000)
#   FACTORY_PR_UPDATE     update (default) | skip existing-PR policy on retry
#   FACTORY_MARKER_URL    run status comment URL (linked from the PR body)
#   FACTORY_PUBLISHER_VERSION  version stamped into the PR body (default v1)
#   GIT_REMOTE            clone/push URL override (tests + smoke)
#   GH_TOKEN | GH_TOKEN_FILE   write-scoped token (#70 App installation token)
#   FACTORY_RESULT_FILE   key=value result summary written on every exit path
#
# Validation before anything is pushed:
#   repository allowlist, patch exists/non-empty/size, worker report success,
#   artifact sha256 checksum, repository + run id cross-check, base revision
#   exists and is an ancestor of the default branch (drift detection),
#   patch applies (plain, then 3-way), changed-file/line limits, expected
#   changed paths. Any failure records an actionable Run event comment on the
#   issue (marker: <!-- factory:event:<issue>:<kind>:<ts> -->) and exits
#   without pushing.
#
# Exit codes: 0 published/updated/skipped · 3 empty artifact · 4 validation
#             5 base drift/conflict · 78 configuration · 1 unexpected
#
# Manual smoke (opens a real draft PR — #79 acceptance):
#   FACTORY_REPO=gwkline/launchpad FACTORY_ISSUE=6 FACTORY_PROFILE=code-pr \
#   FACTORY_PATCH_FILE=/tmp/patch.diff GH_TOKEN=<app installation token> \
#   sh apps/factory/publisher/run-publisher.sh
set -eu

REPO="${FACTORY_REPO:?FACTORY_REPO required (owner/name)}"
ISSUE="${FACTORY_ISSUE:?FACTORY_ISSUE required}"
PROFILE="${FACTORY_PROFILE:-code-pr}"
RUN_ID="${FACTORY_RUN_ID:-issue${ISSUE}-${ISSUE}}"
PATCH_FILE="${FACTORY_PATCH_FILE:-/out/patch.diff}"
REPORT_FILE="${FACTORY_REPORT_FILE:-/out/report.json}"
PR_BASE="${FACTORY_PR_BASE:-main}"
UPDATE_MODE="${FACTORY_PR_UPDATE:-update}"
MAX_PATCH_BYTES="${FACTORY_MAX_PATCH_BYTES:-2097152}"
MAX_CHANGED_FILES="${FACTORY_MAX_CHANGED_FILES:-50}"
MAX_CHANGED_LINES="${FACTORY_MAX_CHANGED_LINES:-4000}"
EXPECTED_PATHS="${FACTORY_EXPECTED_PATHS:-}"
MARKER_URL="${FACTORY_MARKER_URL:-}"
PUBLISHER_VERSION="${FACTORY_PUBLISHER_VERSION:-v1}"
RESULT_FILE="${FACTORY_RESULT_FILE:-}"
GH_BIN="${GH_BIN:-/usr/local/bin/gh}"

# Operator allowlist, same defaults as the orchestrator CronJob. A repo that
# is not allowlisted is refused before any git/gh/network call touches it.
WHITELIST="${FACTORY_REPOS:-gwkline/homelab,gwkline/launchpad,gwkline/plantry,gwkline/personal-site,gwkline/kline-services-bot,gwkline/discord-bot,gwkline/pr-czar}"

# gh wrapper: a hung GitHub call must fail this publish, not wedge the Job.
gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$GH_BIN" "$@"
  else
    "$GH_BIN" "$@"
  fi
}
# Same ceiling for git network ops (clone/push) — mirrors the orchestrator.
gitt() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 300 git "$@"
  else
    git "$@"
  fi
}
timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_result() { # $1=status  $2=pr_url  $3=reason
  if [ -n "${RESULT_FILE}" ]; then
    {
      printf 'status=%s\n' "$1"
      printf 'pr_url=%s\n' "$2"
      printf 'branch=%s\n' "${BRANCH:-}"
      printf 'commit=%s\n' "${NEW_SHA:-}"
      printf 'reason=%s\n' "$3"
    } > "${RESULT_FILE}"
  fi
}

fail() { # $1=exit code, rest=reason (no GitHub event)
  RC=$1
  shift
  echo "[publisher] FAILED: $*" >&2
  write_result "failed" "" "$*"
  exit "${RC}"
}

# Actionable Run event: append-only comment on the issue, then fail.
# GitHub-as-ledger (ADR-002): events are marker comments; the status comment
# stays owned by the orchestrator/controller.
record_event() { # $1=kind, $2=markdown detail
  EVENT_KIND=$1
  EVENT_TS=$(timestamp)
  EVENT_FILE="${WORK:-/tmp}/factory-event-${EVENT_TS}.md"
  {
    printf '<!-- factory:event:%s:%s:%s -->\n\n' "${ISSUE}" "${EVENT_KIND}" "${EVENT_TS}"
    printf '## ⚠️ Publish event — %s\n\n%s\n' "${EVENT_KIND}" "$2"
  } > "${EVENT_FILE}" 2>/dev/null || true
  if gh issue comment "${ISSUE}" -R "${REPO}" --body-file "${EVENT_FILE}" >/dev/null 2>&1; then
    echo "[publisher] recorded ${EVENT_KIND} event on #${ISSUE}"
  else
    echo "[publisher] WARN: could not record event on #${ISSUE}" >&2
  fi
}

event_fail() { # $1=exit code, $2=kind, $3=detail
  RC=$1
  KIND=$2
  shift 2
  echo "[publisher] FAILED (${KIND}): $*" >&2
  record_event "${KIND}" "$*"
  write_result "failed" "" "$*"
  exit "${RC}"
}

# ---- configuration ---------------------------------------------------------
case ",${WHITELIST}," in
  *",${REPO},"*) ;;
  *) fail 78 "repository ${REPO} is not on the factory allowlist" ;;
esac
case "${UPDATE_MODE}" in
  update|skip) ;;
  *) fail 78 "FACTORY_PR_UPDATE must be 'update' or 'skip', got '${UPDATE_MODE}'" ;;
esac

# Write credential: short-lived App installation token from the #70 token
# service (env or mounted file). Never logged; workers never see it.
WRITE_TOKEN=""
if [ -n "${GH_TOKEN_FILE:-}" ] && [ -r "${GH_TOKEN_FILE}" ]; then
  WRITE_TOKEN=$(tr -d '[:space:]' < "${GH_TOKEN_FILE}")
fi
[ -n "${WRITE_TOKEN}" ] || WRITE_TOKEN="${GH_TOKEN:-}"
[ -n "${WRITE_TOKEN}" ] || fail 78 "no publisher write credential (set GH_TOKEN or mount GH_TOKEN_FILE)"
export GH_TOKEN="${WRITE_TOKEN}"

BRANCH="factory/issue-${ISSUE}/${PROFILE}"

WORK=$(mktemp -d)
# shellcheck disable=SC2329  # invoked via `trap cleanup EXIT`
cleanup() {
  RC=$?
  rm -rf "${WORK}"
  # POSIX preserves the original exit status after the trap completes.
}
trap cleanup EXIT

# ---- artifact intake & validation ------------------------------------------
[ -f "${PATCH_FILE}" ] || fail 4 "patch artifact not found at ${PATCH_FILE}"
cp "${PATCH_FILE}" "${WORK}/patch.diff"
PATCH_BYTES=$(wc -c < "${WORK}/patch.diff" | tr -d '[:space:]')
if [ "${PATCH_BYTES}" -eq 0 ]; then
  echo "[publisher] patch artifact is empty — nothing to publish (no PR will be created)"
  write_result "empty" "" "empty patch artifact"
  exit 3
fi
if [ "${PATCH_BYTES}" -gt "${MAX_PATCH_BYTES}" ]; then
  fail 4 "patch artifact is ${PATCH_BYTES} bytes, exceeding FACTORY_MAX_PATCH_BYTES=${MAX_PATCH_BYTES}"
fi

# Worker report (optional for old-image compat; validated when present).
REPORT_SUCCESS=""
REPORT_SHA256=""
REPORT_BASE=""
REPORT_RUN_ID=""
REPORT_REPO=""
REPORT_TESTS=""
REPORT_SUMMARY=""
if [ -f "${REPORT_FILE}" ]; then
  REPORT_SUCCESS=$(python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get("success"); print("true" if v is True else "false" if v is False else "")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_SHA256=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("patch_sha256") or "")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_BASE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("base_sha") or "")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_RUN_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("run_id") or "")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_REPO=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("repository") or "")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_TESTS=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("tests") or "unknown")' "${REPORT_FILE}" 2>/dev/null || echo "")
  REPORT_SUMMARY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("summary") or "")' "${REPORT_FILE}" 2>/dev/null || echo "")
else
  echo "[publisher] WARN: no worker report at ${REPORT_FILE} — report-derived checks skipped"
fi

if [ "${REPORT_SUCCESS}" = "false" ]; then
  event_fail 4 artifact-invalid "Worker report marks this run unsuccessful — refusing to publish a failed artifact."
fi
if [ -n "${REPORT_REPO}" ] && [ "${REPORT_REPO}" != "${REPO}" ]; then
  event_fail 4 artifact-invalid "Artifact repository mismatch: report says \`${REPORT_REPO}\`, publisher targets \`${REPO}\`. Refusing to publish cross-repo artifacts."
fi
if [ -n "${REPORT_RUN_ID}" ] && [ -n "${RUN_ID}" ] && [ "${REPORT_RUN_ID}" != "${RUN_ID}" ]; then
  event_fail 4 artifact-invalid "Run id mismatch: report carries \`${REPORT_RUN_ID}\`, publisher expected \`${RUN_ID}\`. Stale or foreign artifact."
fi
if [ -n "${REPORT_SHA256}" ]; then
  ACTUAL_SHA=$(sha256sum "${WORK}/patch.diff" | cut -d ' ' -f1)
  if [ "${ACTUAL_SHA}" != "${REPORT_SHA256}" ]; then
    event_fail 4 artifact-invalid "Patch artifact checksum mismatch: expected \`${REPORT_SHA256}\`, got \`${ACTUAL_SHA}\`. The artifact was corrupted or tampered with after the worker emitted it."
  fi
fi
EXPECTED_BASE="${FACTORY_BASE_SHA:-${REPORT_BASE}}"

# ---- clean checkout --------------------------------------------------------
REMOTE_URL="${GIT_REMOTE:-https://x-access-token:${WRITE_TOKEN}@github.com/${REPO}.git}"
gitt clone -q "${REMOTE_URL}" "${WORK}/repo" || fail 1 "clone of target repository failed"
cd "${WORK}/repo"
git config user.name "factory-bot"
git config user.email "factory@homelab.local"
HEAD_SHA=$(gitt rev-parse HEAD)
DEFAULT_BRANCH=$(gitt rev-parse --abbrev-ref HEAD)

# ---- base revision validation (drift detection) ----------------------------
if [ -n "${EXPECTED_BASE}" ]; then
  if ! gitt cat-file -e "${EXPECTED_BASE}^{commit}" 2>/dev/null; then
    event_fail 5 base-drift "Base revision drift: expected base \`${EXPECTED_BASE}\` does not exist in ${REPO} (garbage-collected or wrong repository). Re-run the worker against the current default branch head."
  fi
  if ! gitt merge-base --is-ancestor "${EXPECTED_BASE}" "${HEAD_SHA}"; then
    event_fail 5 base-drift "Base revision drift: the patch was produced against \`${EXPECTED_BASE}\`, which is not an ancestor of ${DEFAULT_BRANCH}@\`${HEAD_SHA}\`. The worker's base is stale — re-run the worker on the current base."
  fi
fi

# ---- patch application (fails safely before anything is pushed) ------------
APPLY_ARGS=""
if ! gitt apply --check --whitespace=nowarn "${WORK}/patch.diff" 2> "${WORK}/apply-err"; then
  if gitt apply --check --3way --whitespace=nowarn "${WORK}/patch.diff" 2>> "${WORK}/apply-err"; then
    APPLY_ARGS="--3way"
  else
    ERR=$(head -c 1000 "${WORK}/apply-err")
    event_fail 5 apply-conflict "Patch does not apply to \`${DEFAULT_BRANCH}\`@\`${HEAD_SHA}\` (base drift or conflict); nothing was pushed. Re-run the worker on the current base.

\`\`\`
${ERR}
\`\`\`"
  fi
fi
# shellcheck disable=SC2086  # APPLY_ARGS is empty or the single --3way flag
gitt apply ${APPLY_ARGS} --whitespace=nowarn "${WORK}/patch.diff"

# ---- change-size limits & expected paths ------------------------------------
NUMSTAT=$(gitt apply --numstat "${WORK}/patch.diff" || true)
CHANGED_FILES=$(printf '%s\n' "${NUMSTAT}" | grep -c . || true)
CHANGED_LINES=$(printf '%s\n' "${NUMSTAT}" | awk '{a+=$1; d+=$2} END {printf "%d", a+d}')
if [ "${CHANGED_FILES}" -gt "${MAX_CHANGED_FILES}" ]; then
  event_fail 4 too-large "Patch changes ${CHANGED_FILES} files, exceeding FACTORY_MAX_CHANGED_FILES=${MAX_CHANGED_FILES}. Split the work or raise the limit deliberately."
fi
if [ "${CHANGED_LINES}" -gt "${MAX_CHANGED_LINES}" ]; then
  event_fail 4 too-large "Patch changes ${CHANGED_LINES} lines, exceeding FACTORY_MAX_CHANGED_LINES=${MAX_CHANGED_LINES}. Split the work or raise the limit deliberately."
fi
if [ -n "${EXPECTED_PATHS}" ]; then
  VIOLATIONS=$(printf '%s\n' "${NUMSTAT}" | awk '{print $3}' | while IFS= read -r p; do
    [ -n "${p}" ] || continue
    ok=0
    for entry in $(printf '%s' "${EXPECTED_PATHS}" | tr ',' ' '); do
      case "${p}" in
        "${entry}"|"${entry}"/*) ok=1 ;;
      esac
    done
    [ "${ok}" = "1" ] || printf '%s\n' "${p}"
  done)
  if [ -n "${VIOLATIONS}" ]; then
    event_fail 4 path-violation "Patch touches paths outside the expected set (${EXPECTED_PATHS}):
${VIOLATIONS}"
  fi
fi

# ---- deterministic commit ---------------------------------------------------
gitt add -A
gitt commit -qm "factory: resolve #${ISSUE}

Produced by homelab software factory (${PROFILE} profile).
Run: ${RUN_ID}
Refs #${ISSUE}"
NEW_SHA=$(gitt rev-parse HEAD)

# ---- existing PR lookup (before any push, so skip-policy is a true no-op) ---
EXISTING_PR=$(gh pr list -R "${REPO}" --head "${BRANCH}" --state open --json number,url 2>/dev/null | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[0]["number"] if a else "")' || echo "")

# ---- idempotent push (deterministic branch, force-with-lease on retry) ------
REMOTE_SHA=$(gitt ls-remote origin "refs/heads/${BRANCH}" | cut -f1)
PUSHED=0
SKIPPED_SAME_TREE=0
if [ -n "${REMOTE_SHA}" ] && gitt diff --quiet "${REMOTE_SHA}" "${NEW_SHA}" 2>/dev/null; then
  # Identical tree already on the remote branch — retry is a true no-op.
  SKIPPED_SAME_TREE=1
  echo "[publisher] branch ${BRANCH} already up to date (${REMOTE_SHA})"
else
  if [ -n "${REMOTE_SHA}" ]; then
    gitt push -q --force-with-lease="refs/heads/${BRANCH}:${REMOTE_SHA}" origin "HEAD:refs/heads/${BRANCH}" \
      || event_fail 5 push-rejected "Force-with-lease push to ${BRANCH} failed: the branch moved since this run started (concurrent publisher?). Nothing was clobbered; retry."
  else
    gitt push -q origin "HEAD:refs/heads/${BRANCH}" \
      || event_fail 5 push-failed "Push of ${BRANCH} to ${REPO} failed (auth or permission problem with the publisher token)."
  fi
  PUSHED=1
fi

# ---- deterministic PR body ---------------------------------------------------
ISSUE_TITLE="${FACTORY_ISSUE_TITLE:-}"
if [ -z "${ISSUE_TITLE}" ]; then
  ISSUE_TITLE=$(gh issue view "${ISSUE}" -R "${REPO}" --json title --jq .title 2>/dev/null || true)
fi
[ -n "${ISSUE_TITLE}" ] || ISSUE_TITLE="issue #${ISSUE}"

SANITIZED_SUMMARY=$(printf '%s' "${REPORT_SUMMARY}" | sed 's/`//g' | head -c 1000)
PR_BODY_FILE="${WORK}/pr-body.md"
{
  printf '## 🏭 Factory Run — %s\n\n' "${PROFILE}"
  printf 'Closes #%s\n\n' "${ISSUE}"
  printf '> ⚠️ **Automated draft PR** produced by the homelab software factory.\n'
  printf '> Requires CI green + human review before promotion. Do not auto-merge.\n\n'
  printf '| | |\n|---|---|\n'
  printf '| Run | `%s` |\n' "${RUN_ID}"
  printf '| Issue | #%s |\n' "${ISSUE}"
  printf '| Profile | `%s` |\n' "${PROFILE}"
  printf '| Publisher | `%s` |\n' "${PUBLISHER_VERSION}"
  printf '| Base | `%s` (expected `%s`) |\n' "${HEAD_SHA}" "${EXPECTED_BASE:-n/a}"
  printf '| Tests | `%s` |\n' "${REPORT_TESTS}"
  printf '\n'
  if [ -n "${SANITIZED_SUMMARY}" ]; then
    printf '**Agent report**\n\n```\n%s\n```\n\n' "${SANITIZED_SUMMARY}"
  fi
  printf '**Artifacts & logs**\n\n'
  printf -- '- Patch: branch `%s` (commit `%s`)\n' "${BRANCH}" "${NEW_SHA}"
  if [ -n "${MARKER_URL}" ]; then
    printf -- '- Run status + log tail: %s\n' "${MARKER_URL}"
  else
    printf -- '- Run status: status comment on #%s\n' "${ISSUE}"
  fi
  printf -- '- Full worker logs: worker Job pod (TTL-bound)\n'
} > "${PR_BODY_FILE}"

# ---- idempotent PR: update rather than duplicate ----------------------------
if [ -n "${EXISTING_PR}" ]; then
  if [ "${UPDATE_MODE}" = "skip" ]; then
    echo "[publisher] PR #${EXISTING_PR} exists and FACTORY_PR_UPDATE=skip — leaving untouched"
    EXISTING_URL=$(gh pr view "${EXISTING_PR}" -R "${REPO}" --json url --jq .url 2>/dev/null || echo "")
    write_result "skipped" "${EXISTING_URL}" "existing PR kept per retry policy"
    echo "[publisher] status=skipped pr_url=${EXISTING_URL}"
    exit 0
  fi
  EXISTING_BODY=$(gh pr view "${EXISTING_PR}" -R "${REPO}" --json body --jq .body 2>/dev/null || echo "")
  NEW_BODY=$(cat "${PR_BODY_FILE}")
  if [ "${PUSHED}" = "0" ] && [ "${SKIPPED_SAME_TREE}" = "1" ] && [ "${EXISTING_BODY}" = "${NEW_BODY}" ]; then
    PR_URL=$(gh pr view "${EXISTING_PR}" -R "${REPO}" --json url --jq .url 2>/dev/null || echo "")
    write_result "skipped" "${PR_URL}" "branch and PR already up to date"
    echo "[publisher] status=skipped (already up to date) pr_url=${PR_URL}"
    exit 0
  fi
  if [ "${EXISTING_BODY}" != "${NEW_BODY}" ]; then
    gh pr edit "${EXISTING_PR}" -R "${REPO}" \
      --title "${ISSUE_TITLE}" --body-file "${PR_BODY_FILE}" >/dev/null
  fi
  PR_URL=$(gh pr view "${EXISTING_PR}" -R "${REPO}" --json url --jq .url 2>/dev/null || echo "")
  write_result "updated" "${PR_URL}" "existing PR #${EXISTING_PR} refreshed"
  echo "[publisher] status=updated pr_url=${PR_URL}"
  exit 0
fi

PR_URL=$(gh pr create -R "${REPO}" --draft \
  --head "${BRANCH}" --base "${PR_BASE}" \
  --title "${ISSUE_TITLE}" \
  --body-file "${PR_BODY_FILE}")

# Link the issue to its PR (one PR-link comment per run; ADR-002 "published").
EVENT_TS=$(timestamp)
EVENT_FILE="${WORK}/pr-ready.md"
{
  printf '<!-- factory:event:%s:pr-published:%s -->\n\n' "${ISSUE}" "${EVENT_TS}"
  printf '🏭 Draft PR ready: %s\n' "${PR_URL}"
} > "${EVENT_FILE}"
gh issue comment "${ISSUE}" -R "${REPO}" --body-file "${EVENT_FILE}" >/dev/null || true

write_result "published" "${PR_URL}" "draft PR created"
echo "[publisher] status=published pr_url=${PR_URL}"
