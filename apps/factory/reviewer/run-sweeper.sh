#!/bin/sh
# Factory stalled-PR sweeper (#242): convert stale ci-red factory PRs into
# queueable fix work. Companion to the reclaimer (#94) and the future medic
# (#239) — the stale-red path only fires when the medic gave up.
#
# Lives in the reviewer app (same image, gh + jq only, no k8s API) and runs
# as its own hourly CronJob. GitHub is the ledger (ADR-002): all sweep state
# is DERIVED from GitHub (marker comments, review requests, fix-issue search),
# so repeated ticks never re-file:
#
#   marker on PR            meaning
#   ----------------------  ----------------------------------------------
#   factory:sweep:filed:<n> fix issue already filed for PR #n (idempotency)
#   factory:sweep:drift:<n> rebase-warning comment (edited in place)
#   factory:medic:retry:<i> medic (#239) retry markers (counted vs max)
#
# Decision per open factory PR (head branch factory/issue-<N>/...; drafts skipped):
#   green + awaiting human, age < PING_AFTER_H  → no action
#   green + awaiting human, age >= PING_AFTER_H → one review-request ping
#   red, went red < RED_GRACE_H ago             → leave for medic; log only
#   red, stale + medic has retries left         → leave for medic
#   red, stale + retries exhausted (or none) or linked issue is factory/stuck
#                                               → file ONE factory/queued fix
#                                                 issue (refs the PR, failing
#                                                 checks, drift) + marker
#   main > DRIFT_COMMITS ahead of the PR base   → idempotent rebase warning
#
# NEVER closes or merges PRs — the human stays the merge gate. Every read is
# fail-closed: an unavailable API cannot trigger a write.
set -eu

REPOS="${FACTORY_REPOS:?FACTORY_REPOS required (comma-separated owner/name)}"
DRY_RUN="${FACTORY_SWEEP_DRY_RUN:-false}"
GH_BIN="${GH_BIN:-/usr/local/bin/gh}"
PING_AFTER_H="${SWEEP_PING_AFTER_H:-168}"        # courtesy ping age (7d)
PING_REVIEWER="${SWEEP_PING_REVIEWER:-gwkline}"  # human who stays the gate
RED_GRACE_H="${SWEEP_RED_GRACE_H:-24}"           # fresh red goes to medic
MEDIC_MAX="${SWEEP_MEDIC_MAX_RETRIES:-4}"        # exhausted when count >= max
DRIFT_COMMITS="${SWEEP_DRIFT_COMMITS:-50}"       # rebase-warning threshold
SWEEP_NOW="${SWEEP_NOW:-}"                       # test hook: fixed epoch "now"
LABEL_QUEUED="factory/queued"
LABEL_STUCK="factory/stuck"
MARKER_FILED="factory:sweep:filed:"
MARKER_DRIFT="factory:sweep:drift:"
MARKER_MEDIC="factory:medic:retry:"

gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$GH_BIN" "$@"
  else
    "$GH_BIN" "$@"
  fi
}

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || { echo "[sweeper] gh auth failed" >&2; exit 1; }
fi

now_epoch() {
  if [ -n "$SWEEP_NOW" ]; then printf '%s\n' "$SWEEP_NOW"; else date -u +%s; fi
}

epoch_of() {
  # $1 = ISO timestamp → epoch; empty output on unparseable input.
  if [ -n "${1:-}" ]; then
    python3 -c 'import sys, datetime
try:
    print(int(datetime.datetime.fromisoformat(sys.argv[1].replace("Z", "+00:00")).timestamp()))
except Exception:
    sys.exit(1)' "$1" 2>/dev/null || true
  fi
}

# One read of the PR's comments, reduced to the sweep markers:
# "<filed true|false> <drift_comment_id|-> <medic_retries>". 2 = read failure.
pr_markers() {
  _pm_file="$(mktemp)"
  if ! gh api "repos/$1/issues/$2/comments?per_page=100" > "$_pm_file" 2>/dev/null; then
    rm -f "$_pm_file"; return 2
  fi
  if ! _pm_out="$(jq -r --arg m1 "$MARKER_FILED" --arg m2 "$MARKER_DRIFT" --arg m3 "$MARKER_MEDIC" '
    [ ([.[] | (.body // "") | contains($m1)] | any),
      ([.[] | select((.body // "") | contains($m2))][0].id // "-"),
      ([.[] | (.body // "" | (split($m3) | length - 1))] | add // 0)
    ] | join(" ")' "$_pm_file" 2>/dev/null)"; then
    rm -f "$_pm_file"; return 2
  fi
  rm -f "$_pm_file"
  printf '%s\n' "$_pm_out"
}

# CI verdict for a head sha + epoch the PR went red; failing-check summary
# lines are written to $3. Prints "<ci> <red_epoch|->". 2 = read failure.
# Same classification contract as the reviewer: pending is NEVER green.
ci_state() {
  _cs_file="$(mktemp)"
  if ! gh api "repos/$1/commits/$2/check-runs" > "$_cs_file" 2>/dev/null; then
    rm -f "$_cs_file"; return 2
  fi
  _cs_out="$(python3 - "$_cs_file" "$3" << 'PYEOF'
import sys, json, datetime
runs = (json.load(open(sys.argv[1])).get("check_runs") or [])
concls = [(r.get("conclusion") or r.get("status") or "") for r in runs]
red_states = ("failure", "timed_out", "action_required", "stale", "cancelled")
pending_states = ("", "pending", "queued", "in_progress", "waiting")
ci = "green"
if any(c in red_states for c in concls):
    ci = "red"
elif any(c in pending_states for c in concls):
    ci = "pending"
elif any(c not in ("success", "skipped", "neutral") for c in concls):
    ci = "unknown"
elif not concls:
    ci = "pending"
red_epoch = "-"
latest = ""
summary = []
for r in runs:
    c = r.get("conclusion") or ""
    if c in red_states:
        summary.append("- %s: %s" % (r.get("name") or "check", c))
        ts = r.get("completed_at") or ""
        if ts > latest:
            latest = ts
if latest:
    try:
        red_epoch = str(int(datetime.datetime.fromisoformat(
            latest.replace("Z", "+00:00")).timestamp()))
    except Exception:
        pass
with open(sys.argv[2], "w") as f:
    f.write("\n".join(summary))
print("%s %s" % (ci, red_epoch))
PYEOF
)" || { rm -f "$_cs_file"; return 2; }
  rm -f "$_cs_file"
  printf '%s\n' "$_cs_out"
}

linked_issue_stuck() {
  # $1 = repo, $2 = linked issue number. rc0 = stuck, rc1 = not, rc2 = read
  # failure (fail-closed: caller skips the PR).
  _lis_file="$(mktemp)"
  if ! gh api "repos/$1/issues/$2" > "$_lis_file" 2>/dev/null; then
    rm -f "$_lis_file"; return 2
  fi
  if ! labels="$(jq -r '[(.labels // [])[].name] | join(",")' "$_lis_file" 2>/dev/null)"; then
    rm -f "$_lis_file"; return 2
  fi
  rm -f "$_lis_file"
  case ",$labels," in
    *",${LABEL_STUCK},"*) return 0 ;;
    *)                    return 1 ;;
  esac
}

# Commits main advanced past the PR base; empty output = unknown (fail-closed).
base_drift() {
  gh api "repos/$1/compare/$2...main" 2>/dev/null | jq -r '.ahead_by // empty' 2>/dev/null || true
}

post_or_update_drift_comment() {
  # $1=repo $2=pr $3=existing_comment_id("-"|id) $4=drift $5=base_ref
  _dc_body="<!-- ${MARKER_DRIFT}${2} -->
## ⏳ Base drift warning (factory sweeper)

Main has advanced $4 commits past this PR's base (\`$5\`). The patch may stop
applying — rebase onto main.

_Auto-managed by factory-sweeper (do not edit)._"
  if [ "$DRY_RUN" = "true" ]; then
    echo "[sweeper] would warn $1#$2: base drift $4 commits"
    return 0
  fi
  if [ "$3" != "-" ] && [ -n "$3" ]; then
    gh api -X PATCH "repos/$1/issues/comments/$3" -f body="$_dc_body" >/dev/null
    echo "[sweeper] updated drift warning $1#$2 ($4 commits)"
  else
    gh api -X POST "repos/$1/issues/$2/comments" -f body="$_dc_body" >/dev/null
    echo "[sweeper] posted drift warning $1#$2 ($4 commits)"
  fi
}

file_fix_issue() {
  # $1=repo $2=pr $3=linked_issue $4=reason $5=checks_summary $6=drift $7=head_ref
  _ff_repo="$1" _ff_num="$2" _ff_linked="$3" _ff_reason="$4"
  _ff_summary="$5" _ff_drift="$6" _ff_ref="$7"

  # Idempotency backstop: search issues for the marker too, so a lost PR
  # marker comment (comment write failed last tick) still does not re-file.
  _ff_existing="$(gh api -X GET search/issues \
    -f q="repo:${_ff_repo} is:issue \"${MARKER_FILED}${_ff_num}\" in:body" \
    --jq '.total_count // 0' 2>/dev/null || true)"
  case "${_ff_existing:-0}" in
    ''|0) ;;
    *)
      echo "[sweeper] skip filing ${_ff_repo}#${_ff_num}: fix issue already exists (search)"
      return 0
      ;;
  esac

  _ff_linked_cell="n/a"
  if [ -n "$_ff_linked" ]; then
    _ff_linked_cell="#${_ff_linked}"
  fi
  _ff_drift_row=""
  if [ "${_ff_drift:-0}" -gt "$DRIFT_COMMITS" ]; then
    _ff_drift_row="| Base drift | main is ${_ff_drift} commits ahead of the PR base — rebase before fixing |
"
  fi
  _ff_checks_block=""
  if [ -n "$_ff_summary" ]; then
    _ff_checks_block="
**Failing checks:**
$_ff_summary
"
  fi
  _ff_body="<!-- ${MARKER_FILED}${_ff_num} -->
## 🔧 Factory Fix Queued

Stalled factory PR #${_ff_num} (linked issue: ${_ff_linked_cell}) is ci-red and the medic gave up: ${_ff_reason}

| | |
|---|---|
| Stalled PR | #${_ff_num} (\`${_ff_ref}\`) |
| Linked issue | ${_ff_linked_cell} |
${_ff_drift_row}${_ff_checks_block}
**Scope:** repair the stalled change so CI passes. Land the fix as a **new PR**
for this issue — do not push to #${_ff_num}; a human stays the merge gate there.

_Auto-filed by factory-sweeper (idempotent via the HTML marker above)._"
  _ff_title="[factory] repair stalled PR #${_ff_num} (ci-red)"
  if [ "$DRY_RUN" = "true" ]; then
    echo "[sweeper] would file fix issue for ${_ff_repo}#${_ff_num}: ${_ff_reason}"
    return 0
  fi
  ensure_queued_label "$_ff_repo"
  _ff_issue="$(gh api -X POST "repos/${_ff_repo}/issues" \
    -f title="$_ff_title" -f body="$_ff_body" \
    -F 'labels[]=factory/queued' 2>/dev/null | jq -r '.number // empty')" || _ff_issue=""
  case "${_ff_issue:-}" in
    ''|null|*[!0-9]*)
      echo "[sweeper] ${_ff_repo}#${_ff_num}: fix-issue write failed" >&2
      return 2
      ;;
  esac
  if ! gh api -X POST "repos/${_ff_repo}/issues/${_ff_num}/comments" \
    -f body="<!-- ${MARKER_FILED}${_ff_num} -->
🔧 Factory sweeper: PR stuck ci-red (${_ff_reason}) — filed fix issue #${_ff_issue} (factory/queued). The human merge gate is untouched." >/dev/null 2>&1; then
    echo "[sweeper] warn: PR marker comment write failed for ${_ff_repo}#${_ff_num} (search backstop prevents re-file)" >&2
  fi
  echo "[sweeper] filed fix issue #${_ff_issue} for ${_ff_repo}#${_ff_num}: ${_ff_reason}"
}

ensure_queued_label() {
  gh api -X POST "repos/$1/labels" \
    -f name="${LABEL_QUEUED}" -f color=0e8a16 \
    -f description="factory: queued work (orchestrator picks up)" >/dev/null 2>&1 || true
}

NOW="$(now_epoch)"

old_ifs="$IFS"
IFS=,
for repo in $REPOS; do
  IFS="$old_ifs"
  repo="$(printf '%s' "$repo" | tr -d '[:space:]')"
  if [ -z "$repo" ]; then continue; fi
  echo "[sweeper] scanning ${repo}"
  # Filter factory branches locally (same convention as the reviewer).
  PRS_JSON="$(gh api --paginate --slurp "repos/${repo}/pulls?state=open&per_page=100" 2>/dev/null \
    | jq '[.[][] | select((.head.ref // "") | startswith("factory/issue-"))]')" || PRS_JSON="[]"
  printf '%s' "$PRS_JSON" | jq -c '.[]' | while IFS= read -r PR; do
    NUM="$(printf '%s' "$PR" | jq -r '.number')"
    DRAFT="$(printf '%s' "$PR" | jq -r '.draft')"
    HEAD_REF="$(printf '%s' "$PR" | jq -r '.head.ref')"
    HEAD_SHA="$(printf '%s' "$PR" | jq -r '.head.sha')"
    BASE_REF="$(printf '%s' "$PR" | jq -r '.base.ref')"
    BASE_SHA="$(printf '%s' "$PR" | jq -r '.base.sha')"
    CREATED_AT="$(printf '%s' "$PR" | jq -r '.created_at')"
    LINKED=""
    case "$HEAD_REF" in
      factory/issue-*/*) LINKED="$(printf '%s' "$HEAD_REF" | sed 's|^factory/issue-\([0-9]*\)/.*|\1|')" ;;
    esac

    if [ "$DRAFT" = "true" ]; then
      echo "[sweeper] skip ${repo}#${NUM}: draft (worker still drafting)"
      continue
    fi

    if ! MARKERS="$(pr_markers "$repo" "$NUM")"; then
      echo "[sweeper] skip ${repo}#${NUM}: comment read failed" >&2
      continue
    fi
    FILED="$(printf '%s' "$MARKERS" | cut -d' ' -f1)"
    DRIFT_ID="$(printf '%s' "$MARKERS" | cut -d' ' -f2)"
    RETRIES="$(printf '%s' "$MARKERS" | cut -d' ' -f3)"

    FAILS_FILE="$(mktemp)"
    if ! CS="$(ci_state "$repo" "$HEAD_SHA" "$FAILS_FILE")"; then
      rm -f "$FAILS_FILE"
      echo "[sweeper] skip ${repo}#${NUM}: check-runs read failed" >&2
      continue
    fi
    CI="$(printf '%s' "$CS" | cut -d' ' -f1)"
    RED_EPOCH="$(printf '%s' "$CS" | cut -d' ' -f2 | tr -d '-')"
    FAIL_SUMMARY="$(tr -d '\r' < "$FAILS_FILE" | grep -v '^[[:space:]]*$' || true)"
    rm -f "$FAILS_FILE"

    DRIFT="$(base_drift "$repo" "$BASE_SHA")"
    case "$DRIFT" in ''|*[!0-9]*) DRIFT="" ;; esac

    # Base drift: independent check, idempotent comment (edited in place).
    if [ -n "$DRIFT" ] && [ "$DRIFT" -gt "$DRIFT_COMMITS" ]; then
      post_or_update_drift_comment "$repo" "$NUM" "$DRIFT_ID" "$DRIFT" "$BASE_REF"
    fi

    AGE_H=""
    CREATED_EPOCH="$(epoch_of "$CREATED_AT")"
    if [ -n "$CREATED_EPOCH" ]; then
      AGE_H=$(( (NOW - CREATED_EPOCH) / 3600 ))
    fi

    if [ "$CI" = "green" ]; then
      if [ "$FILED" = "true" ]; then
        echo "[sweeper] skip ${repo}#${NUM}: fix issue already filed"
        continue
      fi
      REVIEWS="$(gh api "repos/${repo}/pulls/${NUM}/reviews" 2>/dev/null \
        | jq -r '[.[] | select(.state=="APPROVED")] | length > 0' 2>/dev/null)" || REVIEWS=""
      CHANGES="$(gh api "repos/${repo}/pulls/${NUM}/reviews" 2>/dev/null \
        | jq -r '[.[] | select(.state=="CHANGES_REQUESTED")] | length > 0' 2>/dev/null)" || CHANGES=""
      if [ "${REVIEWS:-}" = "true" ] || [ "${CHANGES:-}" = "true" ]; then
        echo "[sweeper] skip ${repo}#${NUM}: green, human gate in motion"
        continue
      fi
      if [ -z "$AGE_H" ] || [ "$AGE_H" -lt "$PING_AFTER_H" ]; then
        echo "[sweeper] skip ${repo}#${NUM}: green, awaiting human (${AGE_H:-?}h < ${PING_AFTER_H}h)"
        continue
      fi
      RREQ="$(gh api "repos/${repo}/pulls/${NUM}/requested_reviewers" 2>/dev/null \
        | jq -r '[.users[].login] | join(",")' 2>/dev/null)" || RREQ=""
      case ",${RREQ:-}," in
        *",${PING_REVIEWER},"*)
          echo "[sweeper] skip ${repo}#${NUM}: review already requested from ${PING_REVIEWER}"
          continue
          ;;
      esac
      if [ "$DRY_RUN" = "true" ]; then
        echo "[sweeper] would ping ${repo}#${NUM}: green ${AGE_H}h awaiting human"
        continue
      fi
      if gh api -X POST "repos/${repo}/pulls/${NUM}/requested_reviewers" \
           -F "reviewers[]=${PING_REVIEWER}" >/dev/null 2>&1; then
        echo "[sweeper] pinged ${repo}#${NUM}: green ${AGE_H}h, requested review from ${PING_REVIEWER}"
      else
        echo "[sweeper] skip ${repo}#${NUM}: review-request write refused" >&2
      fi
      continue
    fi

    if [ "$CI" = "red" ]; then
      if [ "$FILED" = "true" ]; then
        echo "[sweeper] skip ${repo}#${NUM}: fix issue already filed"
        continue
      fi
      if [ -z "$RED_EPOCH" ]; then
        RED_EPOCH="$CREATED_EPOCH"
      fi
      if [ -z "$RED_EPOCH" ]; then
        echo "[sweeper] skip ${repo}#${NUM}: red but no usable timestamp" >&2
        continue
      fi
      RED_AGE_H=$(( (NOW - RED_EPOCH) / 3600 ))
      if [ "$RED_AGE_H" -lt "$RED_GRACE_H" ]; then
        echo "[sweeper] fresh-red ${repo}#${NUM}: red ${RED_AGE_H}h < ${RED_GRACE_H}h — leaving for medic (#239)"
        continue
      fi
      # Stale red: fire only when the medic gave up. `factory/stuck` on the
      # linked issue (the reclaimer's park verdict) is that signal outright;
      # otherwise count the medic's retry markers.
      STUCK="no"
      if [ -n "$LINKED" ]; then
        case "$LINKED" in
          *[!0-9]*) LINKED="" ;;
          *)
            LSTUCK_RC=0
            linked_issue_stuck "$repo" "$LINKED" || LSTUCK_RC=$?
            if [ "$LSTUCK_RC" -eq 2 ]; then
              echo "[sweeper] skip ${repo}#${NUM}: linked-issue read failed" >&2
              continue
            fi
            if [ "$LSTUCK_RC" -eq 0 ]; then
              STUCK="yes"
            fi
            ;;
        esac
      fi
      if [ "$STUCK" = "yes" ]; then
        REASON="linked issue #${LINKED} is factory/stuck (medic exhausted)"
      elif [ "${RETRIES:-0}" -ge "$MEDIC_MAX" ]; then
        REASON="medic retries exhausted (${RETRIES}/${MEDIC_MAX})"
      elif [ "${RETRIES:-0}" -eq 0 ]; then
        REASON="no medic retry markers exist (nothing is tending this PR)"
      else
        echo "[sweeper] skip ${repo}#${NUM}: stale red, medic still retrying (${RETRIES}/${MEDIC_MAX})"
        continue
      fi
      DRIFT_LINE="0"
      if [ -n "$DRIFT" ]; then
        DRIFT_LINE="$DRIFT"
      fi
      file_fix_issue "$repo" "$NUM" "$LINKED" "$REASON" "$FAIL_SUMMARY" "$DRIFT_LINE" "$HEAD_REF" \
        || echo "[sweeper] ${repo}#${NUM}: could not file fix issue" >&2
      continue
    fi

    echo "[sweeper] skip ${repo}#${NUM}: ci=${CI}"
  done
done
IFS="$old_ifs"

echo "[sweeper] done"
