#!/bin/sh
# Stalled-PR sweep (#242): revisit factory PRs the pipeline has stopped
# serving. Idempotent - action state is derived from repo facts (labels,
# comments, CI status), so repeated sweeps never duplicate work.
#
# Per open factory/* PR:
#   green, >7d old, no review yet      -> one review-request ping
#   ci-red, medic still has attempts   -> skip (medic #239 owns it)
#   ci-red, medic exhausted/stuck      -> ONE factory/queued fix issue
set -u

REPO="${FACTORY_REPO:-gwkline/homelab}"
GREEN_PING_DAYS="${SWEEP_GREEN_PING_DAYS:-7}"
BRANCH_PREFIX="factory/"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[sweep] %s %s\n' "$(timestamp)" "$*"; }

PRS=$(gh pr list -R "$REPO" --state open --json number,headRefName \
  --jq ".[] | select(.headRefName | startswith(\"${BRANCH_PREFIX}\")) | \"\(.number)\"" 2>/dev/null || true)
[ -n "$PRS" ] || { log "no open factory PRs"; exit 0; }

for NUM in $PRS; do
  META=$(gh pr view "$NUM" -R "$REPO" --json headRefOid,createdAt \
    --jq '"\(.headRefOid) \(.createdAt)"' 2>/dev/null) || continue
  set -- $META
  HEAD_SHA="$1"; CREATED="$2"

  LABELS=$(gh pr view "$NUM" -R "$REPO" --json labels --jq '[.labels[].name]|join(",")' 2>/dev/null)
  case ",${LABELS}," in *,factory/stuck,*) STUCK=1 ;; *) STUCK=0 ;; esac

  NFAIL=$(gh pr view "$NUM" -R "$REPO" --json statusCheckRollup \
    --jq '[.statusCheckRollup[] | select(.conclusion == "FAILURE")] | length' 2>/dev/null || echo 0)

  if [ "${NFAIL}" = "0" ]; then
    AGE_D=$(python3 -c "from datetime import datetime,timezone; print(int((datetime.now(timezone.utc)-datetime.fromisoformat('${CREATED}'.replace('Z','+00:00'))).total_seconds()//86400))" 2>/dev/null || echo 0)
    REVIEWS=$(gh pr view "$NUM" -R "$REPO" --json reviews --jq '[.reviews[]?] | length' 2>/dev/null || echo 0)
    if [ "${AGE_D}" -ge "${GREEN_PING_DAYS}" ] && [ "${REVIEWS}" = "0" ]; then
      PINGED=$(gh pr view "$NUM" -R "$REPO" --json comments --jq '[.comments[]? | select(.body | contains("sweep:green-ping"))] | length' 2>/dev/null || echo 0)
      if [ "${PINGED}" = "0" ]; then
        gh pr comment "$NUM" -R "$REPO" \
          --body "sweep:green-ping - green for ${AGE_D}d with no review yet. Friendly nudge for the merge gate." >/dev/null 2>&1 || true
        log "PR #${NUM}: green ${AGE_D}d, pinged"
      fi
    fi
    continue
  fi

  # Ci-red: only act when medic is done with this head.
  if [ "${STUCK}" != "1" ]; then
    ATTEMPTS=$(gh api "repos/${REPO}/pulls/${NUM}/issues/comments?per_page=50" 2>/dev/null \
      | python3 -c "
import json,sys
try: comments=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
print(sum(1 for c in comments if 'medic:attempt:' in (c.get('body') or '') and '${HEAD_SHA}'[:7] in (c.get('body') or '')))
") || ATTEMPTS=0
    [ "${ATTEMPTS}" -ge 3 ] || { log "PR #${NUM}: red, medic owns it (${ATTEMPTS} attempts)"; continue; }
  fi

  # Idempotency: fix issue already exists for this head?
  EXISTING=$(gh issue list -R "$REPO" --label factory/queued --state open \
    --search "in:body sweep:fix ${HEAD_SHA}" --json number --jq 'length' 2>/dev/null || echo 0)
  if [ "${EXISTING}" != "0" ]; then
    log "PR #${NUM}: fix issue already queued for ${HEAD_SHA:0:7}"
    continue
  fi

  FAILING=$(gh pr checks "$NUM" -R "$REPO" 2>/dev/null | awk -F'\t' '$2=="fail"{printf "- %s\n",$1}' | head -6)

  gh issue create -R "$REPO" --label "factory/queued,area:factory" \
    --title "sweep: fix ci-red on factory PR #${NUM}" \
    --body "sweep:fix ${HEAD_SHA}

PR #${NUM} is ci-red and the medic has exhausted retries (or the PR is factory/stuck). Repair the failing checks on the PR branch, or open a replacement PR from a new branch if history is unsalvageable.

Failing checks:
${FAILING}

Fix rule: smallest correct change. Do not weaken tests or CI." >/dev/null 2>&1 \
    && log "PR #${NUM}: filed fix issue (head ${HEAD_SHA:0:7})"
done
