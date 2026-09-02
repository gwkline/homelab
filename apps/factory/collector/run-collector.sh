#!/bin/sh
# Factory collector: every open GitHub issue becomes queued factory work.
# GitHub is the ledger; this job only adds factory/queued when an issue has no
# other factory lifecycle label. It never requeues failed or already-claimed work.
set -eu

REPOS="${FACTORY_REPOS:?FACTORY_REPOS required (comma-separated owner/name)}"
DRY_RUN="${FACTORY_COLLECTOR_DRY_RUN:-false}"
GH_BIN="${GH_BIN:-/usr/local/bin/gh}"

# A hung GitHub request must fail this tick, not consume the whole CronJob.
gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$GH_BIN" "$@"
  else
    "$GH_BIN" "$@"
  fi
}

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || { echo "[collector] gh auth failed" >&2; exit 1; }
fi

queue_repo() {
  repo="$1"
  echo "[collector] scanning ${repo}"
  issues="$(gh api --paginate --slurp "repos/${repo}/issues?state=open&per_page=100")"
  printf '%s' "$issues" | jq -c '.[][] | select(.pull_request == null)' | while IFS= read -r issue; do
    number="$(printf '%s' "$issue" | jq -r '.number')"
    labels="$(printf '%s' "$issue" | jq -r '[(.labels // [])[].name] | join(",")')"
    case ",$labels," in
      *,factory/queued,*|*,factory/in-progress,*|*,factory/draft-pr,*|*,factory/failed,*)
        continue
        ;;
    esac

    title="$(printf '%s' "$issue" | jq -r '.title')"
    if [ "$DRY_RUN" = "true" ]; then
      echo "[collector] would queue ${repo}#${number}: ${title}"
    else
      gh api -X POST "repos/${repo}/issues/${number}/labels" \
        -f 'labels[]=factory/queued' >/dev/null
      echo "[collector] queued ${repo}#${number}: ${title}"
    fi
  done
}

old_ifs="$IFS"
IFS=,
for repo in $REPOS; do
  IFS="$old_ifs"
  repo="$(printf '%s' "$repo" | tr -d '[:space:]')"
  [ -n "$repo" ] || continue
  queue_repo "$repo"
  IFS=,
done
IFS="$old_ifs"

echo "[collector] done"
