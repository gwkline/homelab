#!/bin/sh
# Factory reclaimer: requeues failed issues after a cooldown and parks them
# as factory/stuck once attempts run out. GitHub is the ledger: this job only
# relabels and comments, at most one issue per tick (oldest updated first).
#
#   skip   : has factory/stuck, queued, in-progress, or draft-pr
#   stuck  : an open PR on factory/issue-<N>/code-pr exists (needs a human)
#   requeue: attempts < RECLAIMER_MAX_ATTEMPTS and last run older than
#            RECLAIMER_COOLDOWN_H
#   stuck  : everything else (attempts exhausted, no run marker)
#
# Every GitHub read is fail-closed: an unavailable API never mutates labels.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
FACTORY_LIB_DIR="${FACTORY_LIB_DIR:-/usr/local/lib/factory}"
[ -f "${FACTORY_LIB_DIR}/factory.sh" ] || FACTORY_LIB_DIR="${SCRIPT_DIR}/../lib"
# shellcheck source=apps/factory/lib/factory.sh
. "${FACTORY_LIB_DIR}/factory.sh"

REPOS="${FACTORY_REPOS:?FACTORY_REPOS required (comma-separated owner/name)}"
DRY_RUN="${FACTORY_RECLAIM_DRY_RUN:-false}"
MAX_ATTEMPTS="${RECLAIMER_MAX_ATTEMPTS:-4}"
COOLDOWN_H="${RECLAIMER_COOLDOWN_H:-24}"
PROFILE="code-pr"

factory_gh_auth || { echo "[reclaimer] gh auth failed" >&2; exit 1; }

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
  if ! markers="$(jq -r --arg m "${FACTORY_RUN_MARKER}" '[.[].body // "" | capture($m + "[0-9]+:(?<ts>[0-9T:Z-]+)")? | .ts // empty] | "\(length) \(.[-1] // empty)"' "$comments_file" 2>/dev/null)"; then
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

act() {
  repo="$1" num="$2" action="$3" reason="$4"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$action" in
    requeue)
      body="<!-- factory:reclaim:${num}:${ts} -->
## ♻️ Factory Reclaim

Re-queued for another attempt: ${reason}"
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
