#!/bin/sh
# Medic sweep (#239): find factory-authored PRs with failing CI and spawn a
# constrained medic run per red PR. The medic worker may ONLY push commits to
# the PR's existing branch — never open PRs, never touch main, never force-push.
# After MEDIC_MAX_ATTEMPTS failures on the same head SHA, the run marks the PR
# factory/stuck and stops retrying (a human takes it).
set -u

REPO="${FACTORY_REPO:-gwkline/homelab}"
MAX_ATTEMPTS="${MEDIC_MAX_ATTEMPTS:-3}"
# Factory-authored = branch prefixed factory/
BRANCH_PREFIX="${MEDIC_BRANCH_PREFIX:-factory/}"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[medic] %s %s\n' "$(timestamp)" "$*"; }

# Prereq hashes (sha256 of PR head) of past failed medic attempts live as
# issue comments with this marker on the linked issue — idempotent, no k8s state.
attempts_for() { # $1=pr_number  $2=head_sha  -> count
  gh api "repos/${REPO}/pulls/$1/issues/comments?per_page=50" 2>/dev/null \
    | python3 -c "
import json,sys
try: comments=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
marker=f'medic:attempt:'
n=sum(1 for c in comments if marker in (c.get('body') or '') and '${2}' in (c.get('body') or ''))
print(n)
"
}

# Open PRs authored on factory branches
PRS=$(gh pr list -R "$REPO" --state open --json number,headRefName,statusCheckRollup \
  --jq ".[] | select(.headRefName | startswith(\"${BRANCH_PREFIX}\")) | \"\(.number) \(.headRefName) \([.statusCheckRollup[] | select(.conclusion == \"FAILURE\")] | length)\"" 2>/dev/null || true)
[ -n "$PRS" ] || { log "no factory PRs with failing checks"; exit 0; }

echo "$PRS" | while IFS=' ' read -r NUM BRANCH NFAIL; do
  [ "${NFAIL:-0}" -gt 0 ] || continue

  HEAD_SHA=$(gh pr view "$NUM" -R "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null) || continue
  LINKED_ISSUE=$(gh pr view "$NUM" -R "$REPO" --json body --jq '.body' 2>/dev/null \
    | sed -n 's/.*Closes #\([0-9]*\).*/\1/p' | head -1)

  ATTEMPTS=$(attempts_for "$NUM" "$HEAD_SHA")
  if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
    log "PR #${NUM}: ${ATTEMPTS} failed attempts on ${HEAD_SHA} — factory/stuck"
    gh pr edit "$NUM" -R "$REPO" --add-label "factory/stuck" >/dev/null 2>&1 || true
    if [ -n "${LINKED_ISSUE}" ]; then
      gh issue comment "${LINKED_ISSUE}" -R "$REPO" \
        --body "🚑 Medic gave up on PR #${NUM} after ${ATTEMPTS} attempts at head ${HEAD_SHA:0:7} — human review needed." >/dev/null 2>&1 || true
    fi
    continue
  fi

  # Spawn the medic run: reuse the code-pr worker stack, but the brief pins
  # the agent to the PR branch and only-push-that-branch rules.
  log "PR #${NUM}: ${NFAIL} failing check(s), attempt $((ATTEMPTS + 1))/${MAX_ATTEMPTS} — dispatching medic"
  MEDIC_PR="${NUM}" MEDIC_BRANCH="${BRANCH}" MEDIC_HEAD="${HEAD_SHA}" \
  MEDIC_ATTEMPT="$((ATTEMPTS + 1))" LINKED_ISSUE="${LINKED_ISSUE}" \
    /orch/medic-dispatch.sh || log "PR #${NUM}: dispatch failed"
done
