#!/bin/sh
# Factory reviewer — GitHub-as-ledger approval loop poller.
# Harness-agnostic: gh + jq only, no LLM, no k8s API.
#
# v1 behavior:
#   - Reads open PRs carrying factory/* ledger labels with live CI + review
#     status, echoes per-PR verdicts (visible in CronJob logs).
#   - Posts ONE idempotent status comment per PR (marker <!-- factory:review:N -->,
#     edited in place — never duplicated).
#   - Mutates NOTHING else unless FACTORY_REVIEWER_AUTO_MERGE=true (write path
#     lands later; default off).
set -eu

REPO="${FACTORY_REPO:?FACTORY_REPO required}"
DRY="${FACTORY_REVIEWER_DRY_RUN:-false}"
AUTO_MERGE="${FACTORY_REVIEWER_AUTO_MERGE:-false}"

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || { echo "[reviewer] gh auth failed"; exit 1; }
fi

classify_checks() {
  # $1 = comma-separated check conclusions/statuses (or empty)
  # Empty = no checks YET (or the API call failed): that is pending, never
  # green — treating it green let zero-verification PRs get flipped ready.
  case "$1" in
    *failure*|*timed_out*|*action_required*|*stale*|*cancelled*) echo red ;;
    ""|none)                                                     echo pending ;;
    *pending*|*queued*|*in_progress*|*waiting*)                  echo pending ;;
    success)                                                    echo green ;;
    *,*) echo green ;;  # multiple conclusions, none red/pending => all green/skipped
    *)                                                          echo unknown ;;
  esac
}

# List open PRs that carry factory ledger labels.
# NOTE: use printf, never echo — echo mangles JSON content (parse errors on
# real payloads with emoji/control chars); printf '%s' round-trips byte-safe.
PRS_JSON="$(gh api "repos/${REPO}/pulls?state=open&per_page=50&labels=factory/draft-pr")"

printf '%s' "$PRS_JSON" | jq -c '.[]' | while IFS= read -r PR; do
  NUM="$(printf '%s' "$PR" | jq -r '.number')"
  DRAFT="$(printf '%s' "$PR" | jq -r '.draft')"
  HEAD_REF="$(printf '%s' "$PR" | jq -r '.head.ref')"
  LABELS="$(printf '%s' "$PR" | jq -r '[(.labels // [])[].name] | join(",")')"
  LINKED_ISSUE=""
  case "$HEAD_REF" in
    factory/issue-*/*) LINKED_ISSUE="$(printf '%s' "$HEAD_REF" | sed 's|^factory/issue-\([0-9]*\)/.*|\1|')" ;;
  esac

  SHA="$(printf '%s' "$PR" | jq -r '.head.sha')"
  CHECKS="$(gh api "repos/${REPO}/commits/${SHA}/check-runs" 2>/dev/null | jq -r '.check_runs | map(.conclusion // .status) | join(",")')" || CHECKS=""
  CHECKS_STATE="${CHECKS:-none}"
  CI="$(classify_checks "$CHECKS_STATE")"

  REVIEWS="$(gh api "repos/${REPO}/pulls/${NUM}/reviews" 2>/dev/null | jq -r '[.[] | select(.state=="APPROVED")] | length')" || REVIEWS=0
  CHANGES_REQUESTED="$(gh api "repos/${REPO}/pulls/${NUM}/reviews" 2>/dev/null | jq -r '[.[] | select(.state=="CHANGES_REQUESTED")] | length > 0')" || CHANGES_REQUESTED=false
  DECISION="PENDING"
  [ "${REVIEWS:-0}" -gt 0 ] && DECISION="APPROVED"
  [ "${CHANGES_REQUESTED:-false}" = "true" ] && DECISION="CHANGES_REQUESTED"

  VERDICT=""
  if [ "$CI" = "pending" ]; then
    VERDICT="ci-pending: CI ⏳"
  elif [ "$CI" = "red" ]; then
    VERDICT="ci-red: checks failing — needs fix"
  elif [ "$DRAFT" = "true" ]; then
    VERDICT="ready-for-review: CI green on draft — flip ready & request review"
  elif [ "$DECISION" = "APPROVED" ]; then
    VERDICT="ready-to-merge: APPROVED + CI green ✅"
  elif [ "$AUTO_MERGE" = "true" ]; then
    # Auto-merge mode: the factory authored the PR and CI is the gate —
    # no human approval needed (GitHub forbids self-approval anyway).
    VERDICT="auto-merge: CI green ✅ (CI-as-gate, auto mode)"
  elif [ "$DECISION" = "CHANGES_REQUESTED" ]; then
    VERDICT="changes-requested: address review feedback"
  else
    VERDICT="needs-review: awaiting human review (@gwkline)"
  fi

  echo "[reviewer] issue #${LINKED_ISSUE:-?} → PR #${NUM} (${HEAD_REF}) draft=${DRAFT} ci=${CI} review=${DECISION} labels=[${LABELS}] :: ${VERDICT}"

  # ── Write path (only when FACTORY_REVIEWER_AUTO_MERGE=true) ─────────────
  # Priority: merge if approved+green → flip draft ready if green → otherwise
  # just label/nudge. Branch protection still gates the actual merge; a refusal
  # (405/409) is surfaced in the log, never forced.
  if [ "${AUTO_MERGE}" = "true" ] && [ "$DRY" != "true" ]; then
    case "$CI/$DRAFT" in
      green/false)
        echo "[reviewer] PR #${NUM}: auto-merge (squash) — CI green (auto mode)"
        if ! gh pr merge "$NUM" -R "$REPO" --squash --delete-branch >/dev/null 2>&1; then
          echo "[reviewer] PR #${NUM}: merge refused by GitHub — left open, see comment"
        fi
        ;;
      green/true)
        echo "[reviewer] PR #${NUM}: flipping draft → ready for review"
        gh pr ready "$NUM" -R "$REPO" >/dev/null 2>&1 \
          || echo "[reviewer] PR #${NUM}: could not flip ready (needs Pull requests: write)"
        ;;
      *)
        : # no safe mutation — comment above already nudges
        ;;
    esac
    # Label bookkeeping: needs-review when ready+green; approved when APPROVED.
    if [ "$CI" = "green" ] && [ "$DRAFT" = "false" ] && [ "$DECISION" != "CHANGES_REQUESTED" ] \
       && ! printf '%s' "$LABELS" | grep -q "factory/needs-review"; then
      gh api -X POST "repos/${REPO}/issues/${NUM}/labels" -f 'labels[]=factory/needs-review' >/dev/null 2>&1 || true
      echo "[reviewer] PR #${NUM}: labeled factory/needs-review"
    fi
    if [ "$CI" = "green" ] && [ "$DECISION" = "APPROVED" ] \
       && ! printf '%s' "$LABELS" | grep -q "factory/approved"; then
      gh api -X POST "repos/${REPO}/issues/${NUM}/labels" -f 'labels[]=factory/approved' >/dev/null 2>&1 || true
      echo "[reviewer] PR #${NUM}: labeled factory/approved"
    fi
  elif [ "${AUTO_MERGE}" = "true" ] && [ "$DRY" = "true" ]; then
    echo "[reviewer] PR #${NUM}: auto-merge flag on but dry-run — would evaluate write actions"
  fi

  # ── Idempotent status comment (one per PR, marker-edited in place) ──────
  if [ "$DRY" != "true" ]; then
    MARKER="<!-- factory:review:${NUM} -->"
    BODY="${MARKER}
## 🔍 Factory Review Status

| | |
|---|---|
| Verdict | ${VERDICT%%:*} |
| Detail | ${VERDICT#*: } |
| CI | ${CI} (${CHECKS_STATE}) |
| Review decision | ${DECISION} |
| Linked issue | #${LINKED_ISSUE:-n/a} |

_Updated by factory-reviewer (auto-managed comment; do not edit)._"

    EXISTING_ID="$(gh api --paginate --slurp "repos/${REPO}/issues/${NUM}/comments" 2>/dev/null |
      jq -r --arg m "factory:review:${NUM}" '[.[][] | select(.body | contains($m))][0].id // empty')" || EXISTING_ID=""
    if [ -n "$EXISTING_ID" ]; then
      gh api -X PATCH "repos/${REPO}/issues/comments/${EXISTING_ID}" -f body="$BODY" >/dev/null
      echo "[reviewer] PR #${NUM}: updated review comment ${EXISTING_ID}"
    else
      gh api -X POST "repos/${REPO}/issues/${NUM}/comments" -f body="$BODY" >/dev/null
      echo "[reviewer] PR #${NUM}: posted review comment"
    fi
  else
    echo "[reviewer] PR #${NUM}: dry-run — no comment written"
  fi
done

echo "[reviewer] done"
