#!/bin/sh
# Offline tests for apps/factory/lib/factory.sh: check classification, verify
# commands, labels and markers, the gh retry, and that every factory shell
# component survives a first `gh auth status` failure.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FACTORY_LIB_DIR="${ROOT}/apps/factory/lib"
FIX="$(mktemp -d)"
trap 'rm -rf "${FIX}"' EXIT
# shellcheck source=../factory.sh
. "${FACTORY_LIB_DIR}/factory.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }

# --- classify_checks ---------------------------------------------------------
verdict() { printf '%s' "$1" | classify_checks; }
runs() { # conclusions/statuses → check-runs JSON (status-only entries are "s:<status>")
  printf '{"check_runs":['
  _sep=""
  for _c in "$@"; do
    case "${_c}" in
      s:*) printf '%s{"status":"%s","conclusion":null}' "${_sep}" "${_c#s:}" ;;
      *) printf '%s{"status":"completed","conclusion":"%s"}' "${_sep}" "${_c}" ;;
    esac
    _sep=","
  done
  printf ']}'
}
expect() { # $1 = expected verdict, $2 = JSON
  _got="$(verdict "$2")"
  [ "${_got}" = "$1" ] || fail "classify_checks $2: got ${_got}, want $1"
}
expect pending ""
expect pending "not json"
expect pending "$(runs)"
expect red "$(runs success failure)"
expect red "$(runs s:in_progress timed_out)"
expect red "$(runs cancelled)"
expect pending "$(runs success s:queued)"
expect pending "$(runs success s:in_progress)"
expect green "$(runs success)"
expect green "$(runs success skipped neutral)"
expect unknown "$(runs skipped skipped)"
expect unknown "$(runs success startup_failure)"
echo "PASS: classify_checks — red, pending, green, unknown; pending is never green"

# --- verify_for, labels, markers ------------------------------------------------
[ "$(verify_for gwkline/launchpad)" = "cargo check --workspace --all-targets" ] || fail "launchpad verify"
[ "$(verify_for gwkline/plantry)" = "npm run build" ] || fail "plantry verify"
case "$(verify_for gwkline/homelab)" in *"echo verify-ok") ;; *) fail "homelab verify" ;; esac
[ -z "$(verify_for someone/else)" ] || fail "unknown repo must have no verify command"

[ "$(printf '%s\n' "${LABEL_QUEUED}" "${LABEL_WIP}" "${LABEL_DONE}" "${LABEL_NEEDS_REVIEW}" "${LABEL_FAILED}" "${LABEL_CANCELLED}" "${LABEL_STUCK}")" \
  = "$(jq -r '.queued, .in_progress, .draft_pr, .needs_review, .failed, .cancelled, .stuck' "${FACTORY_LIB_DIR}/labels.json")" ] \
  || fail "label variables differ from labels.json"
[ "${LABEL_QUEUED}" = "factory/queued" ] && [ "${LABEL_STUCK}" = "factory/stuck" ] || fail "label values"
[ "$(factory_medic_marker abc123 failed)" = "factory:medic:abc123:failed" ] || fail "medic marker"
echo "PASS: one verify table, one label list, one medic marker"

# --- gh shim: `auth status` fails until AUTH_FAILS calls have been made -----------
mkdir -p "${FIX}/bin"
cat > "${FIX}/bin/gh" << 'EOF'
#!/bin/sh
case "$*" in
  "auth status")
    n=$(cat "${GH_STATE}/auth" 2>/dev/null || echo 0)
    echo $((n + 1)) > "${GH_STATE}/auth"
    if [ "${n}" -lt "${AUTH_FAILS:-1}" ]; then
      echo "error connecting to api.github.com" >&2
      exit 1
    fi
    ;;
  *--jq*) ;;       # filtered reads: nothing found
  *) echo '[]' ;;  # listings: no issues, no PRs
esac
EOF
chmod +x "${FIX}/bin/gh"

reset_auth() { rm -f "${FIX}/state-$1/auth"; mkdir -p "${FIX}/state-$1"; }

reset_auth lib
GH_STATE="${FIX}/state-lib" GH_BIN="${FIX}/bin/gh" FACTORY_RETRY_DELAY=0 AUTH_FAILS=2 factory_gh_auth \
  || fail "factory_gh_auth gave up before its attempts ran out"
[ "$(cat "${FIX}/state-lib/auth")" = 3 ] || fail "factory_gh_auth made $(cat "${FIX}/state-lib/auth") calls, want 3"
reset_auth lib
if GH_STATE="${FIX}/state-lib" GH_BIN="${FIX}/bin/gh" FACTORY_RETRY_DELAY=0 FACTORY_RETRY_ATTEMPTS=3 AUTH_FAILS=9 factory_gh_auth; then
  fail "factory_gh_auth must fail once attempts run out"
fi
[ "$(cat "${FIX}/state-lib/auth")" = 3 ] || fail "factory_gh_auth exceeded FACTORY_RETRY_ATTEMPTS"
echo "PASS: factory_gh_auth retries with backoff and gives up after FACTORY_RETRY_ATTEMPTS"

# --- every component retries a first auth failure ----------------------------------
component() { # $1 = name, $2 = script, rest = env assignments
  _name="$1" _script="$2"
  shift 2
  reset_auth "${_name}"
  _rc=0
  env GH_STATE="${FIX}/state-${_name}" GH_BIN="${FIX}/bin/gh" PATH="${FIX}/bin:${PATH}" \
    GH_TOKEN=test FACTORY_RETRY_DELAY=0 AUTH_FAILS=1 "$@" \
    sh "${ROOT}/${_script}" > "${FIX}/${_name}.log" 2>&1 || _rc=$?
  [ "${_rc}" -eq 0 ] || { cat "${FIX}/${_name}.log"; fail "${_name} exited ${_rc} after one auth failure"; }
  [ "$(cat "${FIX}/state-${_name}/auth")" = 2 ] || fail "${_name} did not retry gh auth"
}
component orchestrator apps/factory/orchestrator/run.sh FACTORY_REPO=gwkline/homelab
grep -q "nothing queued" "${FIX}/orchestrator.log" || fail "orchestrator did not reach its queue poll"
component reclaimer apps/factory/orchestrator/run-reclaimer.sh FACTORY_REPOS=gwkline/homelab
component reviewer apps/factory/reviewer/run-reviewer.sh FACTORY_REPO=gwkline/homelab
component sweeper apps/factory/reviewer/run-sweeper.sh FACTORY_REPOS=gwkline/homelab
component medic apps/factory/medic/run-medic.sh FACTORY_REPO=gwkline/homelab
echo "PASS: orchestrator, reclaimer, reviewer, sweeper and medic each survive a first gh auth failure"
