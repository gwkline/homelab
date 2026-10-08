# shellcheck shell=sh
# Factory shell library, sourced by every factory shell component
# (orchestrator, reclaimer, reviewer, sweeper, medic) so each rule has one
# definition: the gh wrapper and its retries, check classification, the
# per-repo verify command, and the label and marker names.
#
# Callers set FACTORY_LIB_DIR to this file's directory before sourcing; images
# ship it at /usr/local/lib/factory, a checkout at apps/factory/lib.

# ---- gh -------------------------------------------------------------------------
# Every gh call gets a hard timeout: a hung connection fails the step instead
# of burning the Job's activeDeadlineSeconds. The binary is GH_BIN, else `gh`
# on PATH at call time, so tests can shim either.
gh() {
  if command -v timeout > /dev/null 2>&1; then
    timeout "${FACTORY_GH_TIMEOUT:-60}" "${GH_BIN:-gh}" "$@"
  elif [ -n "${GH_BIN:-}" ]; then
    "${GH_BIN}" "$@"
  else
    command gh "$@"
  fi
}

# factory_retry <cmd...>: rerun with exponential backoff (2s, 4s, 8s, 16s by
# default) until it succeeds or attempts run out. Only for idempotent calls: a
# write that timed out after GitHub applied it would apply twice.
factory_retry() {
  _fr_try=1
  _fr_delay="${FACTORY_RETRY_DELAY:-2}"
  until "$@"; do
    [ "${_fr_try}" -lt "${FACTORY_RETRY_ATTEMPTS:-5}" ] || return 1
    sleep "${_fr_delay}"
    _fr_try=$((_fr_try + 1))
    _fr_delay=$((_fr_delay * 2))
  done
}

# A tick's first call can land before DNS and the egress policy are ready:
# retry the auth probe instead of failing the tick.
factory_gh_auth() {
  [ -z "${GH_AUTH_SKIP:-}" ] || return 0
  factory_retry gh auth status > /dev/null 2>&1
}

# ---- labels and markers ------------------------------------------------------
# labels.json is the one label list; the TypeScript collector reads it too.
# shellcheck disable=SC2034  # used by the scripts that source this file
{
  read -r LABEL_QUEUED
  read -r LABEL_WIP
  read -r LABEL_DONE
  read -r LABEL_NEEDS_REVIEW
  read -r LABEL_FAILED
  read -r LABEL_CANCELLED
  read -r LABEL_STUCK
} << EOF
$(jq -r '.queued, .in_progress, .draft_pr, .needs_review, .failed, .cancelled, .stuck' "${FACTORY_LIB_DIR:?FACTORY_LIB_DIR required}/labels.json")
EOF
if [ -z "${LABEL_STUCK}" ] || [ "${LABEL_STUCK}" = "null" ]; then
  echo "factory.sh: cannot read the label list from ${FACTORY_LIB_DIR}/labels.json" >&2
  exit 78
fi

# Run marker comment: <!-- factory:run:<issue>:<ts> --> (orchestrator/marker.sh).
# shellcheck disable=SC2034  # used by the scripts that source this file
FACTORY_RUN_MARKER="factory:run:"

# Medic ledger markers on a PR, one comment each: `queued` when a repair is
# dispatched for a head SHA, `failed` when that head is still red afterwards.
# The sweeper counts the failed ones against the medic's retry budget.
factory_medic_marker() { # $1 = head sha, $2 = queued|failed
  printf 'factory:medic:%s:%s' "${1:?head sha}" "${2:?queued|failed}"
}

# ---- checks and verification ---------------------------------------------------
# classify_checks: verdict for a commit's check runs, from the check-runs API
# JSON on stdin: red | pending | green | unknown. Empty or unreadable input is
# pending; green needs at least one success and nothing but success, skipped
# or neutral, so pending is never green.
classify_checks() {
  _cc_verdict=$(jq -r '
    [(.check_runs // [])[] | (.conclusion // .status // "")] as $c
    | if any($c[]; IN("failure", "timed_out", "action_required", "stale", "cancelled")) then "red"
      elif ($c | length) == 0 or any($c[]; IN("", "pending", "queued", "in_progress", "waiting", "requested")) then "pending"
      elif all($c[]; IN("success", "skipped", "neutral")) and any($c[]; . == "success") then "green"
      else "unknown" end' 2> /dev/null) || _cc_verdict=""
  printf '%s\n' "${_cc_verdict:-pending}"
}

# verify_for <owner/name>: a repo's verify command, the worker's stop condition
# and the medic's repair target. Pipe-free on purpose: dash reports a
# pipeline's last exit status, so `cmd | tail` always passes.
verify_for() {
  case "${1:-}" in
    *launchpad*) echo "cargo check --workspace --all-targets" ;;
    *plantry* | *personal-site* | *pr-czar* | *kline-services-bot* | *discord-bot*) echo "npm run build" ;;
    # Syntax-check every changed .sh (shellcheck when present, else dash -n).
    *homelab*) echo "for f in \$(git diff --name-only HEAD -- '*.sh'); do shellcheck -s sh \"\$f\" 2>/dev/null || dash -n \"\$f\" || exit 1; done; echo verify-ok" ;;
    *) echo "" ;;
  esac
}
