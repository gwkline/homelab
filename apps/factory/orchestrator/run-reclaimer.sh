#!/bin/sh
# Factory reclaimer: retries failed issues when the worker stack moved on,
# parks them as factory/stuck when they keep failing (#94 follow-up).
#
# GitHub is the ledger (ADR-002). This job only relabels + comments:
#   factory/failed (+ no factory/stuck) + open + eligible  →  one action/tick
#   - requeue: remove failed, add queued (orchestrator picks it up next tick)
#   - stuck:   add factory/stuck (human review; collector/orchestrator skip it)
#
# Every GitHub read is fail-closed: an unavailable API cannot cause a label
# mutation. Only the current tick's single action is allowed to mutate state.
#
# Decision per issue (oldest updated first, ONE issue per tick):
#   skip   : has factory/stuck, queued, in-progress, or draft-pr already
#   skip   : closed (API lists open only, belt + suspenders)
#   skip   : open PR on factory/issue-<N>/code-pr exists → comment + stuck
#   requeue: last failure predates RECLAIMER_FIX_CUTOFF (known-bad worker era)
#            AND no reclaim marker since the cutoff (one bonus attempt each)
#   requeue: failure is post-cutoff but attempts < RECLAIMER_MAX_ATTEMPTS
#            AND last run older than RECLAIMER_COOLDOWN_H (transients settle)
#   stuck  : everything else (attempts exhausted, apply-conflict loops, etc.)
#
# Bounds: one issue per tick, hourly schedule → max ~24 worker re-runs/day.
# A requeued issue that fails again returns to failed with a new run marker,
# so the next reclaim sees a higher attempt count and converges to stuck.
set -eu

REPOS="${FACTORY_REPOS:?FACTORY_REPOS required (comma-separated owner/name)}"
DRY_RUN="${FACTORY_RECLAIM_DRY_RUN:-false}"
GH_BIN="${GH_BIN:-/usr/local/bin/gh}"
FIX_CUTOFF="${RECLAIMER_FIX_CUTOFF:-2026-09-03T17:43:00Z}"
MAX_ATTEMPTS="${RECLAIMER_MAX_ATTEMPTS:-4}"
COOLDOWN_H="${RECLAIMER_COOLDOWN_H:-24}"
LABEL_FAILED="factory/failed"
LABEL_QUEUED="factory/queued"
LABEL_WIP="factory/in-progress"
LABEL_DONE="factory/draft-pr"
LABEL_STUCK="factory/stuck"
PROFILE="code-pr"

gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$GH_BIN" "$@"
  else
    "$GH_BIN" "$@"
  fi
}

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || { echo "[reclaimer] gh auth failed" >&2; exit 1; }
fi

older_than() {
  python3 - "$1" "$2" << 'PYEOF'
import sys, datetime
try:
    now = int(sys.argv[1])
    ts = datetime.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00")).timestamp()
    sys.exit(0 if ts < now else 1)
except Exception:
    sys.exit(1)
PYEOF
}

now_epoch() { date -u +%s; }

ensure_stuck_label() {
  gh api -X POST "repos/$1/labels" \
    -f name="${LABEL_STUCK}" -f color=ededed \
    -f description="factory: needs human review" >/dev/null 2>&1 || true
}

list_candidates() {
  repo="$1"
  gh api --paginate --slurp \
    "repos/${repo}/issues?labels=${LABEL_FAILED}&state=open&per_page=100&sort=updated&direction=asc" \
    2>/dev/null \
  | jq -c '.[][] | select(.pull_request == null)' | while IFS= read -r issue; do
    labels="$(printf '%s' "$issue" | jq -r '[(.labels // [])[].name] | join(",")')"
    case ",$labels," in
      *",${LABEL_STUCK},"*|*",${LABEL_QUEUED},"*|*",${LABEL_WIP},"*|*",${LABEL_DONE},"*) continue ;;
    esac
    printf '%s\n' "$issue"
  done
}

run_markers() {
  comments_file="$(mktemp)"
  if ! gh api "repos/$1/issues/$2/comments?per_page=100" > "$comments_file" 2>/dev/null; then
    rm -f "$comments_file"
    return 2
  fi
  if ! markers="$(jq -r '[.[].body // "" | capture("factory:run:[0-9]+:(?<ts>[0-9T:Z-]+)")? | .ts // empty] | "\(length) \(.[-1] // empty)"' "$comments_file" 2>/dev/null)"; then
    rm -f "$comments_file"
    return 2
  fi
  first="${markers%% *}"
  case "$first" in
    ''|*[!0-9]*) rm -f "$comments_file"; return 2 ;;
    *) printf '%s' "$markers" ;;
  esac
  rm -f "$comments_file"
}

has_open_pr() {
  branch="factory/issue-$2/${PROFILE}"
  count="$(gh pr list -R "$1" --head "$branch" --state open --json number --jq 'length' 2>/dev/null)" || return 2
  case "$count" in
    0) return 1 ;;
    ''|*[!0-9]*) return 2 ;;
    *) return 0 ;;
  esac
}

reclaimed_since_cutoff() {
  comments_file="$(mktemp)"
  if ! gh api "repos/$1/issues/$2/comments?per_page=100" > "$comments_file" 2>/dev/null; then
    rm -f "$comments_file"
    return 1
  fi
  count="$(jq -r '.[].body // ""' "$comments_file" | grep -c "factory:reclaim:$2:" || true)"
  rm -f "$comments_file"
  [ "$count" -gt 0 ]
}

act() {
  repo="$1" num="$2" action="$3" reason="$4"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$action" in
    requeue)
      body="<!-- factory:reclaim:${num}:${ts} -->
## ♻️ Factory Reclaim

Re-queued for another attempt: ${reason}

_Last failure predates the worker fix or attempts remain — one bonus run._"
      if [ "$DRY_RUN" = "true" ]; then
        echo "[reclaimer] would requeue ${repo}#${num}: ${reason}"
        return 0
      fi
      gh issue edit "$num" -R "$repo" --remove-label "$LABEL_FAILED" --add-label "$LABEL_QUEUED" >/dev/null
      gh issue comment "$num" -R "$repo" --body "$body" >/dev/null
      echo "[reclaimer] requeued ${repo}#${num}: ${reason}"
      ;;
    stuck)
      body="<!-- factory:reclaim:${num}:${ts} -->
## 🛑 Factory Stuck

Parked for human review: ${reason}

_Remove \`factory/stuck\` + \`factory/failed\` (or relabel \`factory/queued\`) to retry._"
      if [ "$DRY_RUN" = "true" ]; then
        echo "[reclaimer] would park ${repo}#${num}: ${reason}"
        return 0
      fi
      ensure_stuck_label "$repo"
      gh issue edit "$num" -R "$repo" --add-label "$LABEL_STUCK" >/dev/null
      gh issue comment "$num" -R "$repo" --body "$body" >/dev/null
      echo "[reclaimer] stuck ${repo}#${num}: ${reason}"
      ;;
  esac
}

CUTOFF_EPOCH="$(python3 -c "import datetime;print(int(datetime.datetime.fromisoformat('${FIX_CUTOFF}'.replace('Z','+00:00')).timestamp()))")"
NOW="$(now_epoch)"
ACTED=0
ACT_FILE="$(mktemp)"
trap 'rm -f "$ACT_FILE"' EXIT

old_ifs="$IFS"
IFS=,
for repo in $REPOS; do
  IFS="$old_ifs"
  repo="$(printf '%s' "$repo" | tr -d '[:space:]')"
  [ -n "$repo" ] || continue
  echo "[reclaimer] scanning ${repo}"
  CAND_FILE="$(mktemp)"
  list_candidates "$repo" > "$CAND_FILE"
  while IFS= read -r issue; do
    [ -e "$ACT_FILE" ] || break
    num="$(printf '%s' "$issue" | jq -r '.number')"
    title="$(printf '%s' "$issue" | jq -r '.title')"
    if has_open_pr "$repo" "$num"; then
      act "$repo" "$num" stuck "open PR on factory/issue-${num}/${PROFILE} needs a human (rebase/merge/close)"
      rm -f "$ACT_FILE"
      ACTED=1
      continue
    elif [ "$?" -eq 2 ]; then
      echo "[reclaimer] skip ${repo}#${num}: open-PR read failed" >&2
      continue
    fi
    if ! markers="$(run_markers "$repo" "$num")"; then
      echo "[reclaimer] skip ${repo}#${num}: comment read failed" >&2
      continue
    fi
    attempts="${markers%% *}"
    last_ts="${markers#* }"
    [ "$markers" = "$attempts" ] && last_ts=""
    if [ -n "$last_ts" ] && older_than "$CUTOFF_EPOCH" "$last_ts" \
       && ! reclaimed_since_cutoff "$repo" "$num"; then
      act "$repo" "$num" requeue "last run ${last_ts} predates worker fix ${FIX_CUTOFF} (attempt ${attempts})"
      rm -f "$ACT_FILE"
      ACTED=1
      continue
    fi
    if [ "${attempts:-0}" -lt "$MAX_ATTEMPTS" ] && [ -n "$last_ts" ]; then
      last_epoch="$(python3 -c "import datetime;print(int(datetime.datetime.fromisoformat('${last_ts}'.replace('Z','+00:00')).timestamp()))" 2>/dev/null || echo "$NOW")"
      age_h=$(( (NOW - last_epoch) / 3600 ))
      if [ "$age_h" -ge "$COOLDOWN_H" ]; then
        act "$repo" "$num" requeue "attempt ${attempts}/${MAX_ATTEMPTS}, last run ${age_h}h ago"
        rm -f "$ACT_FILE"
        ACTED=1
        continue
      fi
      echo "[reclaimer] skip ${repo}#${num}: cooling down (${age_h}h < ${COOLDOWN_H}h)"
      continue
    fi
    act "$repo" "$num" stuck "attempts exhausted (${attempts}/${MAX_ATTEMPTS}): ${title}"
    rm -f "$ACT_FILE"
    ACTED=1
  done < "$CAND_FILE"
  rm -f "$CAND_FILE"
  [ -e "$ACT_FILE" ] || break
done
IFS="$old_ifs"

echo "[reclaimer] done (acted: ${ACTED})"
