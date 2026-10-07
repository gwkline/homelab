#!/bin/sh
# Factory reviewer: logs a verdict for every open factory PR from its CI and
# review status, and keeps one status comment per PR (edited in place).
# Merges, ready-flips, and labels happen only with
# FACTORY_REVIEWER_AUTO_MERGE=true. gh + jq only; no LLM, no k8s API.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
FACTORY_LIB_DIR="${FACTORY_LIB_DIR:-/usr/local/lib/factory}"
[ -f "${FACTORY_LIB_DIR}/factory.sh" ] || FACTORY_LIB_DIR="${SCRIPT_DIR}/../lib"
# shellcheck source=apps/factory/lib/factory.sh
. "${FACTORY_LIB_DIR}/factory.sh"

REPO="${FACTORY_REPO:?FACTORY_REPO required}"
DRY="${FACTORY_REVIEWER_DRY_RUN:-false}"
AUTO_MERGE="${FACTORY_REVIEWER_AUTO_MERGE:-false}"

factory_gh_auth || { echo "[reviewer] gh auth failed"; exit 1; }

# Filter by branch, not label: lifecycle labels live on the linked issue.
# Use printf '%s', never echo, for JSON: echo can mangle escapes.
PRS_PAGES="$(factory_retry gh api --paginate --slurp "repos/${REPO}/pulls?state=open&per_page=100")" \
  || { echo "[reviewer] cannot list open PRs"; exit 1; }
PRS_JSON="$(printf '%s' "$PRS_PAGES" | jq '[.[][] | select((.head.ref // "") | startswith("factory/issue-"))]')"

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
  CHECKS_JSON="$(gh api "repos/${REPO}/commits/${SHA}/check-runs" 2>/dev/null)" || CHECKS_JSON=""
  CHECKS="$(printf '%s' "$CHECKS_JSON" | jq -r '.check_runs | map(.conclusion // .status) | join(",")' 2>/dev/null)" || CHECKS=""
  CHECKS_STATE="${CHECKS:-none}"
  CI="$(printf '%s' "$CHECKS_JSON" | classify_checks)"

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
    # CI is the gate; GitHub forbids self-approval anyway.
    VERDICT="auto-merge: CI green ✅ (CI-as-gate, auto mode)"
  elif [ "$DECISION" = "CHANGES_REQUESTED" ]; then
    VERDICT="changes-requested: address review feedback"
  else
    VERDICT="needs-review: awaiting human review (@gwkline)"
  fi

  echo "[reviewer] issue #${LINKED_ISSUE:-?} → PR #${NUM} (${HEAD_REF}) draft=${DRAFT} ci=${CI} review=${DECISION} labels=[${LABELS}] :: ${VERDICT}"

  # ── Write path (only when FACTORY_REVIEWER_AUTO_MERGE=true) ─────────────
  # Branch protection still gates the merge; a refusal is logged, never forced.
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
        :
        ;;
    esac
    if [ "$CI" = "green" ] && [ "$DRAFT" = "false" ] && [ "$DECISION" != "CHANGES_REQUESTED" ] \
       && ! printf '%s' "$LABELS" | grep -qF "${LABEL_NEEDS_REVIEW}"; then
      gh api -X POST "repos/${REPO}/issues/${NUM}/labels" -f "labels[]=${LABEL_NEEDS_REVIEW}" >/dev/null 2>&1 || true
      echo "[reviewer] PR #${NUM}: labeled ${LABEL_NEEDS_REVIEW}"
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
