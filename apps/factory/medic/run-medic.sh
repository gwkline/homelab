#!/bin/sh
# Factory medic (#239) — takes ci-red factory PRs from red to green.
# Runs in the reviewer image (gh + jq + git + python3), GitHub-as-ledger,
# no k8s API: the orchestrator is the only component that spawns Jobs, so
# the medic asks it via the existing queued-issue flow.
#
# One sweep tick:
#   1. List open factory-authored PRs whose checks are red.
#   2. Skip PRs whose head-SHA failure budget (3) is exhausted → escalate
#      the linked issue to factory/stuck + comment, retries stop.
#   3. Cap concurrency: at most 1 in-flight medic repair.
#   4. Queue ONE repair: relabel the linked issue factory/queued (pinning the
#      run to the PR branch via the medic branch guard) and post the medic
#      brief (failing checks + logs, PR diff, verify command) on the PR.
#
# Bounds: one PR per tick, 20-min medic run budget (profile-medic), max 1
# concurrent run, only pushes to the PR's existing branch (medic-lib.sh).
set -eu

REPO="${FACTORY_REPO:?FACTORY_REPO required}"
DRY="${FACTORY_MEDIC_DRY_RUN:-false}"
MAX_ATTEMPTS="${FACTORY_MEDIC_MAX_ATTEMPTS:-3}"
MAX_CONCURRENT="${FACTORY_MEDIC_MAX_CONCURRENT:-1}"
ISSUE_LABEL="factory/in-progress" # a repair is in flight under this label
STUCK_LABEL="factory/stuck"
# Small fixes only: the profile pins activeDeadlineSeconds=1200 (20 min).

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "${SCRIPT_DIR}/medic-lib.sh"

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || { echo "[medic] gh auth failed"; exit 1; }
fi

# Same red/pending classification philosophy as the reviewer: unknown state
# is never red — medic only acts on explicit failures.
classify_checks() {
  case "$1" in
    *failure*|*timed_out*|*action_required*|*stale*|*cancelled*) echo red ;;
    *) echo not-red ;;
  esac
}

# Fixed per-repo verification commands — the SAME table the orchestrator
# gives its workers (single behavior, copied deliberately: medic runs in the
# reviewer image with no access to orchestrator internals).
verify_for() {
  case "${1:-}" in
    *launchpad*) echo "cargo check --workspace --all-targets" ;;
    *plantry*|*personal-site*|*pr-czar*|*kline-services-bot*|*discord-bot*) echo "npm run build" ;;
    *homelab*) echo "for f in \$(git diff --name-only HEAD -- '*.sh'); do shellcheck -s sh \"\$f\" 2>/dev/null || dash -n \"\$f\" || exit 1; done; echo verify-ok" ;;
    *) echo "" ;;
  esac
}

# ---- 1. find ci-red factory PRs ---------------------------------------------
[ -n "${MEDIC_TRACE:-}" ] && set -x
PRS_JSON="$(gh api --paginate --slurp "repos/${REPO}/pulls?state=open&per_page=100" \
  | jq '[.[][] | select((.head.ref // "") | startswith("factory/issue-"))]')"

# ---- 2. concurrency cap ------------------------------------------------------
# A repair run is in flight when its linked issue carries factory/in-progress
# (the orchestrator's WIP label — set when the run is dispatched). One repair
# at a time, measured live from the ledger, not from pod state.
IN_FLIGHT=0
for LNUM in $(gh api "repos/${REPO}/issues?labels=${ISSUE_LABEL}&state=open&per_page=100" --jq '.[].number' 2>/dev/null || true); do
  case ",${MEDIC_SKIP_ISSUES:-}," in
    *",${LNUM},"*) continue ;;
  esac
  IN_FLIGHT=$((IN_FLIGHT + 1))
done
if [ "${IN_FLIGHT}" -ge "${MAX_CONCURRENT}" ]; then
  echo "[medic] ${IN_FLIGHT} repair(s) already in flight (cap ${MAX_CONCURRENT}) — nothing to do"
  exit 0
fi

DONE=0
# Loop in the main shell (redirect, not pipeline): the queued/escalate writes
# below must run even under `set -e`, and a pipeline would hide them in a
# subshell whose failures the sweep would never see.
PRS_FILE="$(mktemp)"; trap 'rm -f "${PRS_FILE}"' EXIT
printf '%s' "$PRS_JSON" | jq -c '.[]' > "${PRS_FILE}"
while IFS= read -r PR; do
  NUM="$(printf '%s' "$PR" | jq -r '.number')"
  HEAD_REF="$(printf '%s' "$PR" | jq -r '.head.ref')"
  HEAD_SHA="$(printf '%s' "$PR" | jq -r '.head.sha')"
  LINKED_ISSUE="$(printf '%s' "$HEAD_REF" | sed -n 's|^factory/issue-\([0-9]*\)/.*|\1|p')"

  CHECKS="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" 2>/dev/null |
    jq -r '.check_runs | map(.conclusion // .status) | join(",")')" || CHECKS=""
  CI="$(classify_checks "${CHECKS:-none}")"
  [ "${CI}" = "red" ] || continue

  echo "[medic] PR #${NUM} (${HEAD_REF}) is ci-red — checks: ${CHECKS:-unknown}"

  if [ -z "${LINKED_ISSUE}" ]; then
    echo "[medic] PR #${NUM}: cannot map branch ${HEAD_REF} to a linked issue — skipping"
    continue
  fi

  # Issue ledger guard: never fight an in-progress run for the same issue.
  ISSUE_LABELS="$(gh api "repos/${REPO}/issues/${LINKED_ISSUE}" --jq '[.labels[].name] | join(",")' 2>/dev/null || echo '')"
  case ",${ISSUE_LABELS}," in
    *,${ISSUE_LABEL},*)
      echo "[medic] issue #${LINKED_ISSUE} already in-progress — skipping (one repair at a time)"
      continue
      ;;
    *,factory/queued,*)
      # This sweep (or the orchestrator) already queued the issue and the
      # orchestrator has not flipped it to in-progress yet. Re-dispatching
      # would double-book the repair — wait for the label handoff.
      echo "[medic] issue #${LINKED_ISSUE} already factory/queued — waiting for the orchestrator handoff"
      continue
      ;;
    *,${STUCK_LABEL},*)
      echo "[medic] issue #${LINKED_ISSUE} is ${STUCK_LABEL} — a human owns it now"
      continue
      ;;
  esac

  # Escalation gate: failures are recorded per head SHA. Same head + budget
  # exhausted → stuck. A pushed fix changes the head, resetting the budget.
  ATTEMPTS="$(medic_count_failures "${REPO}" "${NUM}" "${HEAD_SHA}")"
  if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "[medic] PR #${NUM}: ${ATTEMPTS} failed attempts at head ${HEAD_SHA} (budget ${MAX_ATTEMPTS}) — escalating"
    [ "${DRY}" = "true" ] || medic_mark_stuck "${REPO}" "${LINKED_ISSUE}" "${NUM}" "${HEAD_SHA}" "${ATTEMPTS}"
    continue
  fi

  # ---- 3. build the medic run brief -----------------------------------------
  # Failing check names + truncated logs, the PR diff, the verify command.
  FAILING_NAMES="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" 2>/dev/null |
    jq -r '[.check_runs[] | select((.conclusion // "") | test("failure|timed_out|action_required|stale|cancelled")) | .name] | join(", ")')" || FAILING_NAMES=""
  FAIL_LOGS="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/check-runs" 2>/dev/null |
    jq -r '[.check_runs[] | select((.conclusion // "") | test("failure|timed_out|action_required|stale|cancelled")) | "-- " + .name + " --\n" + ((.output.summary // "no log captured")[0:2000])] | join("\n\n")')" || FAIL_LOGS=""
  PR_DIFF="$(gh api "repos/${REPO}/pulls/${NUM}.diff" 2>/dev/null | head -c 20000)" || PR_DIFF=""
  VERIFY_CMD="$(verify_for "${REPO}")"

  BRIEF_MD="## 🩺 Factory Medic brief — repair this ci-red PR

PR #${NUM} is ci-red at head \`${HEAD_SHA}\`. Fix the failing checks **on this branch only**.

| | |
|---|---|
| Failing checks | ${FAILING_NAMES:-see logs} |
| Branch (push target) | \`${HEAD_REF}\` — the ONLY branch you may push to |
| Verification | \`${VERIFY_CMD:-none configured}\` |

### Failing check logs (truncated)

\`\`\`
${FAIL_LOGS:-no log captured}
\`\`\`

### PR diff (truncated)

\`\`\`diff
${PR_DIFF:-no diff}
\`\`\`

Rules:
- Commit fixes to \`${HEAD_REF}\` ONLY. Never open a PR, never push to main, never force-push.
- Keep the fix minimal; re-run the verification command and make it pass.
- End with a one-paragraph report of what was broken and what the fix was."

  if [ "${DRY}" = "true" ]; then
    echo "[medic] PR #${NUM}: dry-run — would queue repair for issue #${LINKED_ISSUE} with brief:"
    printf '%s\n' "${BRIEF_MD}" | head -12
    continue
  fi

  # Post the brief on the PR (the run report will land next to it), then hand
  # the issue to the orchestrator queue. The orchestrator's standard code-pr
  # run publishes to factory/issue-<N>/<profile> branches — the medic branch
  # guard (medic_publish_patch) redirects the publish to the PR's own branch,
  # and a plain non-FF push cannot create or clobber anything.
  if ! gh api -X POST "repos/${REPO}/issues/${NUM}/comments" -f body="${BRIEF_MD}" >/dev/null; then
    echo "[medic] WARN: could not post the medic brief on PR #${NUM} — skipping this tick" >&2
    continue
  fi
  # Queue the linked issue for the orchestrator (its next */10 tick picks it
  # up and spawns the code-pr run; medic-lib's publish guard redirects the
  # push to the PR's own branch).
  if ! gh issue edit "${LINKED_ISSUE}" -R "${REPO}" \
    --remove-label "${STUCK_LABEL}" --add-label "factory/queued" >/dev/null 2>&1; then
    if ! gh issue edit "${LINKED_ISSUE}" -R "${REPO}" --add-label "factory/queued" >/dev/null; then
      echo "[medic] WARN: could not queue issue #${LINKED_ISSUE} — skipping this tick" >&2
      continue
    fi
  fi
  gh issue comment "${LINKED_ISSUE}" -R "${REPO}" \
    --body="🩺 ci-red detected on PR #${NUM} — medic repair queued (attempt $((ATTEMPTS + 1))/${MAX_ATTEMPTS}, pinned to head \`${HEAD_SHA}\`)." >/dev/null
  echo "[medic] issue #${LINKED_ISSUE}: repair queued for PR #${NUM} (attempt $((ATTEMPTS + 1))/${MAX_ATTEMPTS})"

  # One PR per tick: leaves budget for the orchestrator to pick it up.
  DONE=$((DONE + 1))
  break
done < "${PRS_FILE}"

if [ "${DONE:-0}" = "0" ]; then
  echo "[medic] sweep complete — nothing new queued"
else
  echo "[medic] sweep complete — ${DONE} repair(s) queued"
fi
