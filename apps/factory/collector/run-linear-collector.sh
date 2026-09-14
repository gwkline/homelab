#!/bin/sh
# Factory Linear input adapter (#87): Linear issues become factory Runs using
# the same durable contracts as GitHub inputs, without forking the pipeline.
#
# Design (docs/factory-linear-inputs.md):
#   1. POLL — Linear's GraphQL API over HTTPS (outbound only: no public
#      ingress, no webhook receiver required; signed webhooks remain an
#      optional optimization, deliberately not implemented here).
#   2. MAP — each eligible Linear issue is mirrored into the GitHub ledger
#      (the same repo the GitHub collector labels) as the provider-neutral
#      WorkItem: a regular issue carrying the hidden identity marker
#      `<!-- factory:linear:TEAM-N -->`, the declarative default profile and
#      the source URL. Identity → WorkItem mapping is exactly this marker
#      plus the `[TEAM-N]` title prefix; everything downstream (orchestrator
#      claim labels, run markers, branch naming `factory/issue-<n>/<profile>`,
#      worker brief, publisher) is reused verbatim — no Linear branch exists
#      in core runner/controller logic.
#   3. SYNC — run and draft-PR comments on mirrored issues are written back
#      to Linear, deduped by a sync marker so repeated polls never produce
#      duplicate comments.
#
# Idempotency by construction (ADR-002 discipline, no factory database):
#   - repeated polls: create only when no mirror exists; edit only when the
#     composed title/body actually differs; close only when open;
#   - cursor persistence: LINEAR_CURSOR_FILE stores the highest observed
#     updatedAt as epoch seconds; the ledger dedupe is the correctness
#     guarantee, the cursor is a bandwidth optimization (a lost cursor
#     re-scans the lookback window and still creates nothing twice);
#   - edits/cancellation: Linear edits update the mirror in place; a Linear
#     state in LINEAR_CANCELLED_STATUSES (or state type completed/canceled)
#     closes the mirror and drops factory/queued so the orchestrator never
#     claims it;
#   - retries: Linear API calls retry 429/5xx/RATELIMITED with backoff; any
#     other failure fails the whole tick before state changes (the CronJob
#     retries; the next tick is a no-op or completes the work).
#
# Untrusted data: Linear issue text is task context for the worker, never
# shell or config syntax — it is passed strictly as command arguments / jq
# --arg values and embedded in the mirror body verbatim.
#
# Credentials (least privilege, 1Password via ExternalSecret):
#   - LINEAR_TOKEN / LINEAR_TOKEN_FILE: Linear API key for a dedicated
#     integration/bot account that can read the mapped team and create
#     comments — nothing else;
#   - GH_TOKEN: the shared read/issue-write token every factory CronJob uses.
set -eu

LINEAR_API_URL="${LINEAR_API_URL:-https://api.linear.app/graphql}"
# Declarative input contract: team → ledger repo mapping, eligibility, and the
# default profile recorded on every mirrored WorkItem (the orchestrator's
# FACTORY_PROFILE governs execution; this value documents the mapping).
LINEAR_REPO_MAP="${LINEAR_REPO_MAP:?LINEAR_REPO_MAP required (TEAM=owner/name, comma-separated)}"
LINEAR_ELIGIBLE_STATUSES="${LINEAR_ELIGIBLE_STATUSES:-Todo,In Progress}"
LINEAR_CANCELLED_STATUSES="${LINEAR_CANCELLED_STATUSES:-Done,Canceled,Cancelled}"
LINEAR_REQUIRED_LABELS="${LINEAR_REQUIRED_LABELS:-}"
LINEAR_PROJECT="${LINEAR_PROJECT:-}"
FACTORY_PROFILE="${FACTORY_PROFILE:-code-pr}"
LINEAR_LEDGER_LABEL="${LINEAR_LEDGER_LABEL:-factory/linear}"
LINEAR_PAGE_SIZE="${LINEAR_PAGE_SIZE:-50}"
LINEAR_TIMEOUT="${LINEAR_TIMEOUT:-30}"
LINEAR_MAX_ATTEMPTS="${LINEAR_MAX_ATTEMPTS:-3}"
LINEAR_RETRY_SLEEP="${LINEAR_RETRY_SLEEP:-5}"
LINEAR_WRITE_SLEEP="${LINEAR_WRITE_SLEEP:-1}"
LINEAR_LOOKBACK_HOURS="${LINEAR_LOOKBACK_HOURS:-24}"
LINEAR_LEDGER_LIMIT="${LINEAR_LEDGER_LIMIT:-200}"
LINEAR_CURSOR_FILE="${LINEAR_CURSOR_FILE:-}"
LINEAR_DRY_RUN="${LINEAR_DRY_RUN:-false}"
GH_BIN="${GH_BIN:-/usr/local/bin/gh}"
DRY_RUN="$LINEAR_DRY_RUN"

# Hidden marker namespaces (one per concern, machine-parsed, never shell).
LINEAR_ID_MARKER_PREFIX='<!-- factory:linear:'
LINEAR_SYNC_PREFIX='factory:linear:sync:'

# shellcheck disable=SC2016  # GraphQL $variables are not shell expansions
ISSUES_QUERY='query Collector($filter: IssueFilter!, $after: String, $first: Int!) { issues(first: $first, after: $after, filter: $filter) { nodes { id identifier title description url updatedAt state { name type } labels { nodes { name } } } pageInfo { hasNextPage endCursor } } }'
# shellcheck disable=SC2016
ISSUE_COMMENTS_QUERY='query LinearComments($id: String!) { issue(id: $id) { id comments(first: 100) { nodes { body } } } }'
# shellcheck disable=SC2016
COMMENT_CREATE_MUTATION='mutation LinearComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }'

log() { printf '[linear] %s\n' "$*"; }
die() { printf '[linear] FATAL: %s\n' "$*" >&2; exit 1; }

# A hung Linear request must fail this tick, not consume the whole CronJob.
gh() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 "$GH_BIN" "$@"
  else
    "$GH_BIN" "$@"
  fi
}

iso_to_epoch() {
  _ite=$(date -u -d "$1" +%s 2>/dev/null) || _ite=0
  printf '%s' "${_ite:-0}"
}

epoch_to_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

# Case-insensitive membership in a comma-separated list (status and label
# names may contain spaces; commas are the only separator).
list_has_ci() {  # <comma-list> <value>
  _lhc_list=$1
  _lhc_val=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  _lhc_old=$IFS
  IFS=,
  for _lhc_item in $_lhc_list; do
    IFS=$_lhc_old
    _lhc_item=$(printf '%s' "$_lhc_item" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    [ "$_lhc_item" = "$_lhc_val" ] && return 0
  done
  IFS=$_lhc_old
  return 1
}

# Linear GraphQL with bounded transient retry: curl failures, HTTP 429/5xx and
# RATELIMITED GraphQL errors are retried with linear backoff; everything else
# fails the tick immediately (fail closed, no partial state).
linear_api() {  # <query> <variables-json> → response on stdout
  _la_query=$1
  _la_vars=$2
  _la_tmp="${LINEAR_WORK}/api-resp.json"
  _la_attempt=1
  while :; do
    _la_body=$(jq -cn --arg q "$_la_query" --argjson v "$_la_vars" '{query:$q,variables:$v}')
    _la_code=$(curl -sS --max-time "$LINEAR_TIMEOUT" \
      -H "Authorization: ${LINEAR_TOKEN}" \
      -H 'Content-Type: application/json' \
      -o "$_la_tmp" -w '%{http_code}' \
      --data-binary "$_la_body" "$LINEAR_API_URL") && _la_rc=0 || _la_rc=$?
    _la_transient=0
    _la_reason=""
    if [ "$_la_rc" -ne 0 ]; then
      _la_transient=1
      _la_reason="curl exit ${_la_rc}"
    else
      case "$_la_code" in
        2??)
          if jq -e '(.errors // []) | length > 0' "$_la_tmp" >/dev/null 2>&1; then
            if jq -e '[.errors[]?] | any(((.extensions.code // "") | ascii_downcase) == "ratelimited"
              or ((.message // "") | ascii_downcase | contains("rate limit")))' "$_la_tmp" >/dev/null 2>&1; then
              _la_transient=1
              _la_reason="Linear rate limit"
            else
              printf '[linear] Linear API error: ' >&2
              jq -c '.errors' "$_la_tmp" >&2 || true
              return 1
            fi
          fi
          ;;
        429|5??)
          _la_transient=1
          _la_reason="HTTP ${_la_code}"
          ;;
        *)
          printf '[linear] Linear API HTTP failure: %s\n' "$_la_code" >&2
          return 1
          ;;
      esac
    fi
    if [ "$_la_transient" -eq 1 ]; then
      if [ "$_la_attempt" -ge "$LINEAR_MAX_ATTEMPTS" ]; then
        printf '[linear] Linear API failed after %s attempts (%s)\n' \
          "$_la_attempt" "${_la_reason:-unknown}" >&2
        return 1
      fi
      printf '[linear] transient Linear API failure (%s) — attempt %s/%s, backing off\n' \
        "${_la_reason:-unknown}" "$_la_attempt" "$LINEAR_MAX_ATTEMPTS" >&2
      sleep $((_la_attempt * LINEAR_RETRY_SLEEP))
      _la_attempt=$((_la_attempt + 1))
      continue
    fi
    cat "$_la_tmp"
    return 0
  done
}

# Load the ledger's mirrored WorkItems (one JSON object per line) into
# LEDGER_CACHE. A listing failure must fail the tick: an empty cache would
# look like "nothing mirrored yet" and create duplicates.
load_ledger() {  # <repo>
  gh issue list -R "$1" --label "$LINEAR_LEDGER_LABEL" --state all \
    --limit "$LINEAR_LEDGER_LIMIT" --json number,title,body,state,url \
    > "${LINEAR_WORK}/ledger-raw.json" || die "ledger listing failed for ${1}"
  jq -c '.[]' "${LINEAR_WORK}/ledger-raw.json" > "$LEDGER_CACHE"
}

# Find the mirror for one Linear identifier; result in SHADOW_LINE (empty = none).
# The identity marker is the exact generated string at the start of the body.
find_shadow() {  # <identifier>
  jq -c --arg m "${LINEAR_ID_MARKER_PREFIX}$1 -->" \
    'select((.body // "") | startswith($m))' "$LEDGER_CACHE" \
    > "${LINEAR_WORK}/shadow.jsonl"
  SHADOW_LINE=""
  read -r SHADOW_LINE < "${LINEAR_WORK}/shadow.jsonl" || SHADOW_LINE=""
  return 0
}

ensure_label() {  # <repo> <label>
  gh label create "$2" -R "$1" --color 5319e7 >/dev/null 2>&1 || true
}

# Compose the provider-neutral WorkItem from Linear identity: title prefix
# plus a body that leads with the identity marker, records the declarative
# default profile, and embeds the Linear text verbatim (untrusted task
# context — never shell/config syntax).
compose_workitem() {  # <identifier> <title> <description> <url>
  WORK_TITLE=$(printf '[%s] %s' "$1" "$2")
  WORK_BODY=$(printf '%s%s -->\n<!-- factory:linear:profile=%s -->\n\n%s\n\n---\nSource: %s\n_Mirrored by the factory Linear input adapter (#87); issue text is untrusted task context and is never interpreted as shell or config syntax._\n' \
    "$LINEAR_ID_MARKER_PREFIX" "$1" "$FACTORY_PROFILE" "$3" "$4")
}

upsert_shadow() {  # <repo> <node-json> <identifier>
  _us_repo=$1
  _us_node=$2
  _us_ident=$3
  _us_title=$(printf '%s' "$_us_node" | jq -r '.title // ""')
  _us_desc=$(printf '%s' "$_us_node" | jq -r '.description // ""')
  _us_url=$(printf '%s' "$_us_node" | jq -r '.url // ""')
  compose_workitem "$_us_ident" "$_us_title" "$_us_desc" "$_us_url"
  find_shadow "$_us_ident"
  if [ -z "$SHADOW_LINE" ]; then
    if [ "$DRY_RUN" = "true" ]; then
      log "would queue ${_us_ident} → ${_us_repo}: ${WORK_TITLE}"
      return 0
    fi
    ensure_label "$_us_repo" "$LINEAR_LEDGER_LABEL"
    ensure_label "$_us_repo" "factory/queued"
    gh issue create -R "$_us_repo" --title "$WORK_TITLE" --body "$WORK_BODY" \
      --label "$LINEAR_LEDGER_LABEL" --label "factory/queued" >/dev/null
    log "queued ${_us_ident} → ${_us_repo} (profile ${FACTORY_PROFILE}): ${WORK_TITLE}"
    return 0
  fi
  _us_state=$(printf '%s' "$SHADOW_LINE" | jq -r '.state // ""')
  if [ "$_us_state" != "OPEN" ]; then
    # Terminal on the ledger (merged/canceled) wins; never resurrect.
    return 0
  fi
  _us_num=$(printf '%s' "$SHADOW_LINE" | jq -r '.number')
  _us_stitle=$(printf '%s' "$SHADOW_LINE" | jq -r '.title // ""')
  _us_sbody=$(printf '%s' "$SHADOW_LINE" | jq -r '.body // ""')
  # Idempotent edits: only PATCH when the Linear edit actually changed text.
  if [ "$_us_stitle" = "$WORK_TITLE" ] && [ "$_us_sbody" = "$WORK_BODY" ]; then
    return 0
  fi
  if [ "$DRY_RUN" = "true" ]; then
    log "would update ${_us_ident} (#${_us_num}) from Linear edit"
    return 0
  fi
  gh issue edit "${_us_num}" -R "$_us_repo" --title "$WORK_TITLE" --body "$WORK_BODY" >/dev/null
  log "updated ${_us_ident} (#${_us_num}) from Linear edit"
}

close_shadow() {  # <repo> <identifier> <linear-state-name>
  _cs_repo=$1
  _cs_ident=$2
  _cs_state=$3
  find_shadow "$_cs_ident"
  [ -n "$SHADOW_LINE" ] || return 0
  _cs_gh_state=$(printf '%s' "$SHADOW_LINE" | jq -r '.state // ""')
  [ "$_cs_gh_state" = "OPEN" ] || return 0
  _cs_num=$(printf '%s' "$SHADOW_LINE" | jq -r '.number')
  if [ "$DRY_RUN" = "true" ]; then
    log "would close #${_cs_num} (${_cs_ident}) — ${_cs_state} in Linear"
    return 0
  fi
  # Drop the queue label before closing: a mid-claim race must not let the
  # orchestrator pick work Linear already canceled.
  gh issue edit "${_cs_num}" -R "$_cs_repo" --remove-label "factory/queued" >/dev/null 2>&1 || true
  gh issue close "${_cs_num}" -R "$_cs_repo" \
    --comment "⛔ Canceled upstream: Linear state is now **${_cs_state}** — closing the mirrored work item." >/dev/null
  log "closed #${_cs_num} (${_cs_ident}) — ${_cs_state} in Linear"
}

process_node() {  # <repo> <node-json>
  _pn_repo=$1
  _pn_node=$2
  _pn_ident=$(printf '%s' "$_pn_node" | jq -r '.identifier // empty')
  [ -n "$_pn_ident" ] || return 0
  _pn_state=$(printf '%s' "$_pn_node" | jq -r '.state.name // ""')
  _pn_stype=$(printf '%s' "$_pn_node" | jq -r '.state.type // ""')
  _pn_terminal=0
  case "$_pn_stype" in
    completed|canceled) _pn_terminal=1 ;;
    *) ;;
  esac
  if [ "$_pn_terminal" -eq 0 ] && list_has_ci "$LINEAR_CANCELLED_STATUSES" "$_pn_state"; then
    _pn_terminal=1
  fi
  if [ "$_pn_terminal" -eq 1 ]; then
    close_shadow "$_pn_repo" "$_pn_ident" "$_pn_state"
    return 0
  fi
  list_has_ci "$LINEAR_ELIGIBLE_STATUSES" "$_pn_state" || return 0
  if [ -n "$LINEAR_REQUIRED_LABELS" ]; then
    _pn_labels=$(printf '%s' "$_pn_node" | jq -r '[(.labels.nodes // [])[].name] | join(",")')
    _pn_ok=0
    _pn_old=$IFS
    IFS=,
    for _pn_req in $LINEAR_REQUIRED_LABELS; do
      IFS=$_pn_old
      if list_has_ci "$_pn_labels" "$_pn_req"; then
        _pn_ok=1
        break
      fi
    done
    IFS=$_pn_old
    [ "$_pn_ok" -eq 1 ] || return 0
  fi
  upsert_shadow "$_pn_repo" "$_pn_node" "$_pn_ident"
}

# One team scan: cursor pagination over the Linear issue filter, then the
# max updatedAt is persisted as the next tick's starting point.
collect_team() {  # <team-key> <repo> <updated-after-iso>
  _ct_team=$1
  _ct_repo=$2
  _ct_after_iso=$3
  _ct_after=""
  _ct_max=0
  while :; do
    _ct_filter=$(jq -cn --arg team "$_ct_team" --arg ua "$_ct_after_iso" \
      '{team:{key:{eq:$team}},updatedAt:{gte:$ua}}')
    if [ -n "$LINEAR_PROJECT" ]; then
      _ct_filter=$(jq -cn --argjson f "$_ct_filter" --arg p "$LINEAR_PROJECT" \
        '$f + {project:{name:{eq:$p}}}')
    fi
    _ct_vars=$(jq -cn --argjson f "$_ct_filter" --arg after "$_ct_after" \
      --argjson first "$LINEAR_PAGE_SIZE" \
      '{filter:$f, after:(if $after=="" then null else $after end), first:$first}')
    _ct_resp=$(linear_api "$ISSUES_QUERY" "$_ct_vars") || return 1
    printf '%s' "$_ct_resp" | jq -c '.data.issues.nodes[]?' > "${LINEAR_WORK}/nodes.jsonl"
    while IFS= read -r _ct_node; do
      [ -n "$_ct_node" ] || continue
      process_node "$_ct_repo" "$_ct_node" || return 1
      _ct_e=$(iso_to_epoch "$(printf '%s' "$_ct_node" | jq -r '.updatedAt // ""')")
      if [ "$_ct_e" -gt "$_ct_max" ]; then
        _ct_max=$_ct_e
      fi
    done < "${LINEAR_WORK}/nodes.jsonl"
    _ct_next=$(printf '%s' "$_ct_resp" | jq -r '.data.issues.pageInfo.hasNextPage // false')
    _ct_after=$(printf '%s' "$_ct_resp" | jq -r '.data.issues.pageInfo.endCursor // ""')
    [ "$_ct_next" = "true" ] || break
  done
  if [ -n "$LINEAR_CURSOR_FILE" ] && [ "$_ct_max" -gt 0 ]; then
    if printf '%s\n' "$_ct_max" > "${LINEAR_CURSOR_FILE}.tmp" 2>/dev/null &&
      mv "${LINEAR_CURSOR_FILE}.tmp" "$LINEAR_CURSOR_FILE" 2>/dev/null; then
      log "cursor advanced to $(epoch_to_iso "$_ct_max")"
    else
      log "WARN: cursor not persisted to ${LINEAR_CURSOR_FILE} (non-fatal; ledger dedupe keeps polls idempotent)"
    fi
  fi
  return 0
}

# Write-back: mirror run + draft-PR comments from the ledger to Linear,
# deduped by the sync marker so retries/repolls never duplicate comments.
linear_sync_comment() {  # <linear-identifier> <dedupe-key> <markdown>
  _lsc_ident=$1
  _lsc_key=$2
  _lsc_text=$3
  _lsc_vars=$(jq -cn --arg id "$_lsc_ident" '{id:$id}')
  _lsc_resp=$(linear_api "$ISSUE_COMMENTS_QUERY" "$_lsc_vars") || return 1
  _lsc_uuid=$(printf '%s' "$_lsc_resp" | jq -r '.data.issue.id // empty')
  [ -n "$_lsc_uuid" ] || return 0
  if printf '%s' "$_lsc_resp" | jq -e --arg k "${LINEAR_SYNC_PREFIX}${_lsc_key}" \
    'any(.data.issue.comments.nodes[].body; contains($k))' >/dev/null 2>&1; then
    return 0
  fi
  if [ "$DRY_RUN" = "true" ]; then
    log "would comment on ${_lsc_ident}: ${_lsc_key}"
    return 0
  fi
  _lsc_body=$(printf '<!-- %s%s -->\n\n%s' "$LINEAR_SYNC_PREFIX" "$_lsc_key" "$_lsc_text")
  _lsc_vars=$(jq -cn --arg issue "$_lsc_uuid" --arg body "$_lsc_body" \
    '{input:{issueId:$issue, body:$body}}')
  linear_api "$COMMENT_CREATE_MUTATION" "$_lsc_vars" >/dev/null || return 1
  case "$LINEAR_WRITE_SLEEP" in
    ''|*[!0-9]*) ;;
    *) if [ "$LINEAR_WRITE_SLEEP" -gt 0 ]; then sleep "$LINEAR_WRITE_SLEEP"; fi ;;
  esac
  log "synced to Linear ${_lsc_ident}: ${_lsc_key}"
}

sync_run_links() {  # <repo>
  _sr_repo=$1
  while IFS= read -r _sr_issue; do
    [ -n "$_sr_issue" ] || continue
    _sr_ident=$(printf '%s' "$_sr_issue" | jq -r '.body // "" | capture("^<!-- factory:linear:(?<id>[A-Za-z0-9]+-[0-9]+) -->") | .id' 2>/dev/null) || _sr_ident=""
    [ -n "$_sr_ident" ] || continue
    _sr_num=$(printf '%s' "$_sr_issue" | jq -r '.number')
    _sr_iurl=$(printf '%s' "$_sr_issue" | jq -r '.url // ""')
    gh api "repos/${_sr_repo}/issues/${_sr_num}/comments?per_page=100" \
      > "${LINEAR_WORK}/gh-comments.json" || return 1
    jq -c '.[]' "${LINEAR_WORK}/gh-comments.json" > "${LINEAR_WORK}/gh-comments.jsonl"
    while IFS= read -r _sr_c; do
      [ -n "$_sr_c" ] || continue
      _sr_key=""
      _sr_text=""
      if printf '%s' "$_sr_c" | jq -e '.body | contains("<!-- factory:run:")' >/dev/null 2>&1; then
        _sr_key=$(printf '%s' "$_sr_c" | jq -r '.body | capture("factory:run:(?<k>[0-9]+:[0-9TZ:+-]+)") | .k' 2>/dev/null) || _sr_key=""
        _sr_curl=$(printf '%s' "$_sr_c" | jq -r '.html_url // ""')
        _sr_status=$(printf '%s' "$_sr_c" | sed -n 's/^| Status | \([^|]*\) |.*/\1/p' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        _sr_text=$(printf '🏭 [Factory Run %s](%s) — status: %s\n\nLedger issue: %s' \
          "${_sr_key:-run}" "$_sr_curl" "${_sr_status:-unknown}" "$_sr_iurl")
      elif printf '%s' "$_sr_c" | jq -e '.body | contains("Draft PR ready: ")' >/dev/null 2>&1; then
        _sr_key=$(printf '%s' "$_sr_c" | jq -r '.body | capture("Draft PR ready: (?<k>\\S+)") | .k' 2>/dev/null) || _sr_key=""
        _sr_text=$(printf '📦 [Draft PR](%s) — produced by the factory run on ledger issue %s' \
          "${_sr_key:-}" "$_sr_iurl")
      else
        continue
      fi
      [ -n "$_sr_key" ] || continue
      linear_sync_comment "$_sr_ident" "$_sr_key" "$_sr_text" || return 1
    done < "${LINEAR_WORK}/gh-comments.jsonl"
  done < "$LEDGER_CACHE"
  return 0
}

# ---- credentials: least-privilege Linear token, 1Password-backed -----------
if [ -n "${LINEAR_TOKEN_FILE:-}" ]; then
  [ -r "$LINEAR_TOKEN_FILE" ] || die "LINEAR_TOKEN_FILE not readable: ${LINEAR_TOKEN_FILE}"
  LINEAR_TOKEN=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$LINEAR_TOKEN_FILE")
fi
[ -n "${LINEAR_TOKEN:-}" ] || die "Linear credentials missing (set LINEAR_TOKEN or LINEAR_TOKEN_FILE)"
[ -n "${GH_TOKEN:-}" ] || [ -n "${GH_AUTH_SKIP:-}" ] || die "GH_TOKEN missing"

LINEAR_WORK=$(mktemp -d "${TMPDIR:-/tmp}/linear-collector.XXXXXX")
trap 'rm -rf "${LINEAR_WORK}"' EXIT

LEDGER_CACHE="${LINEAR_WORK}/ledger.jsonl"

if [ -z "${GH_AUTH_SKIP:-}" ]; then
  gh auth status >/dev/null 2>&1 || die "gh auth failed"
fi

# Cursor: resume where the last successful scan stopped; without a persisted
# cursor (fresh deploy, wiped volume) fall back to the lookback window.
CURSOR_START=""
if [ -n "$LINEAR_CURSOR_FILE" ] && [ -r "$LINEAR_CURSOR_FILE" ]; then
  CURSOR_START=$(head -n 1 "$LINEAR_CURSOR_FILE" | tr -dc '0-9')
fi
if [ -z "$CURSOR_START" ]; then
  CURSOR_START=$(( $(date -u +%s) - LINEAR_LOOKBACK_HOURS * 3600 ))
fi
UPDATED_AFTER=$(epoch_to_iso "$CURSOR_START")

old_ifs=$IFS
IFS=,
for entry in $LINEAR_REPO_MAP; do
  IFS=$old_ifs
  entry=$(printf '%s' "$entry" | tr -d '[:space:]')
  [ -n "$entry" ] || continue
  case "$entry" in
    *=*) ;;
    *) die "bad LINEAR_REPO_MAP entry (want TEAM=owner/name): ${entry}" ;;
  esac
  team=${entry%%=*}
  repo=${entry#*=}
  [ -n "$team" ] && [ -n "$repo" ] || die "bad LINEAR_REPO_MAP entry (want TEAM=owner/name): ${entry}"
  log "scanning team ${team} → ${repo} (updatedAfter ${UPDATED_AFTER})"
  load_ledger "$repo"
  collect_team "$team" "$repo" "$UPDATED_AFTER" || die "collection failed for team ${team}"
  sync_run_links "$repo" || die "run-link write-back failed for ${repo}"
  IFS=,
done
IFS=$old_ifs

log "done"
