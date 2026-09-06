#!/bin/sh
# Offline fixture tests for scripts/k8s-smoke.sh (issue #16).
#
# Runs the smoke script against a stub kubectl that replays a canned
# mini-cluster — no real cluster, no network — and proves:
#   - the green path passes: every manifest target is applied, excluded
#     external integrations are skipped WITH explicit reasons, the smoke Job
#     is created and awaited, and the can-i permission matrix is asserted
#   - a known-bad RBAC fixture (RoleBinding whose ServiceAccount subject does
#     not exist) FAILS, names the offending binding, and dumps Kubernetes
#     events + pod logs (stub log records the diagnostic calls)
#   - the corrected fixture PASSES again (fails-then-passes proof)
#   - a malformed roleRef (target Role missing) fails
#   - a workload referencing a missing same-namespace ServiceAccount fails
#   - a cluster whose server version does not match the production k3s pin
#     fails before anything is applied
#   - a ServiceAccount losing an expected permission fails
#
# Usage: sh scripts/tests/k8s-smoke.test.sh
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TARGET="$SCRIPT_DIR/../k8s-smoke.sh"

die() { echo "FAIL: $1" >&2; exit 1; }
[ -f "$TARGET" ] || die "missing $TARGET"
command -v dash >/dev/null 2>&1 && dash -n "$TARGET" || true

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

TAB=$(printf '\t')
FAILURES=0
ok() { echo "ok - $1"; }
ko() { echo "FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }

# The stub kubectl records every invocation in $KCTL_LOG and replays canned
# cluster state from the KCTL_* environment variables set per scenario.
cat >"$WORK/kubectl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >>"${KCTL_LOG:?}"
case "$1" in
  get)
    case "$2" in
      nodes)
        printf '%s\n' "$KCTL_NODE_VERSION"
        ;;
      rolebindings)
        case "$5" in
          *roleRef*) printf '%b' "$KCTL_RB" ;;
          *) printf '%b' "$KCTL_RB_SUBJ" ;;
        esac
        ;;
      clusterrolebindings)
        case "$4" in
          *roleRef*) printf '%b' "$KCTL_CRB" ;;
          *) printf '%b' "$KCTL_CRB_SUBJ" ;;
        esac
        ;;
      serviceaccount)
        _sa_name=$3
        _sa_ns=$5
        case ",${KCTL_SA_MISSING:-}," in
          *",${_sa_name}@${_sa_ns},"*) exit 1 ;;
          *) exit 0 ;;
        esac
        ;;
      role)
        _role_name=$3
        case ",${KCTL_ROLE_MISSING:-}," in
          *",${_role_name},"*) exit 1 ;;
          *) exit 0 ;;
        esac
        ;;
      clusterrole)
        _cr_name=$3
        case ",${KCTL_ROLE_MISSING:-}," in
          *",${_cr_name},"*) exit 1 ;;
          *) exit 0 ;;
        esac
        ;;
      deployments,statefulsets,daemonsets) printf '%b' "$KCTL_PODLIKE" ;;
      jobs) printf '%b' "$KCTL_JOBS" ;;
      cronjobs) printf '%b' "$KCTL_CRONJOBS" ;;
      cronjob) exit 0 ;;
      pods|events|serviceaccounts) exit 0 ;;
      *) exit 0 ;;
    esac
    ;;
  apply)
    if [ "$2" = "-" ]; then exit 0; fi
    if [ -n "${KCTL_FAIL_APPLY:-}" ]; then
      case "$3" in
        *"$KCTL_FAIL_APPLY"*) exit 1 ;;
      esac
    fi
    exit 0
    ;;
  auth)
    _verb=$3
    _res=$4
    _ns=""
    _as=""
    _prev=""
    for _arg in "$@"
    do
      case "$_prev" in
        -n) _ns=$_arg ;;
        --as) _as=$_arg ;;
      esac
      _prev=$_arg
    done
    _ans=no
    while IFS='|' read -r v r n a expected
    do
      [ -n "$v" ] || continue
      if [ "$v" = "$_verb" ] && [ "$r" = "$_res" ] && [ "$n" = "$_ns" ] && [ "$a" = "$_as" ]; then
        _ans=$expected
      fi
    done <<EOF
${KCTL_CANI:-}
EOF
    printf '%s\n' "$_ans"
    ;;
  rollout | wait | logs | describe) exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$WORK/kubectl"

# run_scenario <name> <out-file> — runs the smoke script with the current
# KCTL_* fixtures; echoes the exit code.
run_scenario() {
  _name=$1
  _out=$2
  : >"$WORK/stub-log"
  KCTL_LOG="$WORK/stub-log"
  export KCTL_LOG
  (
    export KUBECTL="$WORK/kubectl" KUBECONFIG=/dev/null
    sh "$TARGET"
  ) >"$_out" 2>&1
  echo $?
}

# Default green-fixture cluster state (all ServiceAccounts resolve, all
# roleRef targets exist, can-i answers as designed).
NODE_OK='v1.36.4+k3s1'
RB_OK="agents${TAB}panel-loop-manager${TAB}Role${TAB}loop-manager
sandbox${TAB}dispatcher-loop-manager${TAB}Role${TAB}loop-manager
agents${TAB}hermes-self-viewer${TAB}Role${TAB}hermes-self-viewer
sandbox${TAB}chaos-monkey${TAB}Role${TAB}chaos-monkey"
RB_SUBJ_OK="agents${TAB}panel-loop-manager${TAB}ServiceAccount${TAB}panel${TAB}agents
sandbox${TAB}dispatcher-loop-manager${TAB}ServiceAccount${TAB}dispatcher${TAB}sandbox
agents${TAB}hermes-self-viewer${TAB}ServiceAccount${TAB}hermes${TAB}agents
sandbox${TAB}chaos-monkey${TAB}ServiceAccount${TAB}chaos-monkey${TAB}sandbox"
CRB_OK="hermes-cluster-reader${TAB}ClusterRole${TAB}hermes-cluster-reader"
CRB_SUBJ_OK="hermes-cluster-reader${TAB}ServiceAccount${TAB}hermes${TAB}agents"
PODLIKE_OK="agents${TAB}headlamp${TAB}headlamp
agents${TAB}alloy${TAB}alloy
agents${TAB}auto-deploy${TAB}auto-deploy
agents${TAB}no-sa-deployment${TAB}"
CRONJOBS_OK="sandbox${TAB}dispatch-watcher${TAB}dispatcher
sandbox${TAB}factory-orchestrator${TAB}factory-orchestrator"
CANI_OK='create|jobs|sandbox|system:serviceaccount:agents:panel|yes
create|jobs|sandbox|system:serviceaccount:sandbox:dispatcher|yes
delete|pods|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:sandbox:dispatcher|no
delete|pods|sandbox|system:serviceaccount:sandbox:dispatcher|no
get|nodes||system:serviceaccount:agents:hermes|yes
delete|pods|sandbox|system:serviceaccount:agents:hermes|no
get|secrets|agents|system:serviceaccount:agents:hermes|no
delete|pods|sandbox|system:serviceaccount:sandbox:chaos-monkey|yes
delete|pods|agents|system:serviceaccount:sandbox:chaos-monkey|yes
get|secrets|sandbox|system:serviceaccount:sandbox:chaos-monkey|no
delete|pods|kube-system|system:serviceaccount:sandbox:chaos-monkey|no
patch|deployments|agents|system:serviceaccount:agents:auto-deploy|yes
patch|deployments|sandbox|system:serviceaccount:agents:auto-deploy|no
get|secrets|agents|system:serviceaccount:agents:auto-deploy|no'
JOBS_OK=''

export KCTL_NODE_VERSION="$NODE_OK" KCTL_RB="$RB_OK" KCTL_RB_SUBJ="$RB_SUBJ_OK"
export KCTL_CRB="$CRB_OK" KCTL_CRB_SUBJ="$CRB_SUBJ_OK"
export KCTL_PODLIKE="$PODLIKE_OK" KCTL_JOBS="$JOBS_OK" KCTL_CRONJOBS="$CRONJOBS_OK"
export KCTL_SA_MISSING='' KCTL_ROLE_MISSING='' KCTL_FAIL_APPLY='' KCTL_CANI="$CANI_OK"

# Scenario 1 — green cluster: passes, applies every target, skips externals
# with explicit reasons, awaits the smoke Job.
rc=$(run_scenario green "$WORK/green.out") || true
if [ "$rc" -eq 0 ]; then ok "green fixture passes"; else ko "green fixture failed (rc=$rc)"; cat "$WORK/green.out" >&2; fi
grep -q "APPLY -k deploy/factory/base" "$WORK/green.out" && ok "applies the normal manifest set" || ko "factory base not applied"
grep -q "APPLY -f deploy/namespaces.yaml" "$WORK/green.out" && ok "applies namespaces first" || ko "namespaces not applied"
for _skip in tailscale eso github-tokens backup image-policy cnpg postgres gvisor; do
  _skips=$(grep -c "SKIP deploy/.*$_skip" "$WORK/green.out" || true)
  case "$_skips" in
    0) ko "no explicit SKIP line for $_skip" ;;
    *) ok "skips $_skip with explicit reason" ;;
  esac
done
grep -q "smoke Job completed" "$WORK/green.out" && ok "smoke Job awaited" || ko "smoke Job not awaited"
grep -q "k8s-smoke: PASS" "$WORK/green.out" && ok "prints PASS" || ko "no PASS marker"
if grep -q "get events" "$WORK/stub-log"; then ko "diagnostics ran on the green path"; else ok "no spurious diagnostics on the green path"; fi

# Scenario 2 — known-bad RBAC: a RoleBinding subject references a
# ServiceAccount that does not exist (admission accepts this silently).
RB_SUBJ_BAD="$RB_SUBJ_OK
agents${TAB}panel-loop-manager${TAB}ServiceAccount${TAB}ghost-sa${TAB}agents"
export KCTL_RB_SUBJ="$RB_SUBJ_BAD" KCTL_SA_MISSING='ghost-sa@agents'
rc=$(run_scenario "bad-subject-sa" "$WORK/bad.out") || true
if [ "$rc" -ne 0 ]; then ok "known-bad RBAC (missing subject SA) FAILS"; else ko "known-bad RBAC passed the smoke"; fi
grep -q "BROKEN RoleBinding agents/panel-loop-manager" "$WORK/bad.out" && ok "names the offending binding" || ko "offending binding not named"
grep -q "ghost-sa" "$WORK/bad.out" && ok "names the missing ServiceAccount" || ko "missing SA not named"
grep -q "get events" "$WORK/stub-log" && ok "failure output includes Kubernetes events" || ko "no event dump on failure"
grep -q "logs -n sandbox" "$WORK/stub-log" && ok "failure output includes pod logs" || ko "no pod-log dump on failure"
grep -q "get pods -A" "$WORK/stub-log" && ok "failure output includes pod status" || ko "no pod-status dump on failure"

# Scenario 2b — correction: the subject points back at the real ServiceAccount
# and the same cluster passes (fails-then-passes proof).
export KCTL_RB_SUBJ="$RB_SUBJ_OK" KCTL_SA_MISSING=''
rc=$(run_scenario "corrected-subject-sa" "$WORK/fixed.out") || true
if [ "$rc" -eq 0 ]; then ok "corrected RBAC passes again"; else ko "corrected RBAC still fails (rc=$rc)"; cat "$WORK/fixed.out" >&2; fi

# Scenario 3 — malformed roleRef: the Role a RoleBinding points at is missing.
export KCTL_RB="agents${TAB}panel-loop-manager${TAB}Role${TAB}no-such-role"
export KCTL_ROLE_MISSING='no-such-role'
rc=$(run_scenario "bad-roleref" "$WORK/roleref.out") || true
if [ "$rc" -ne 0 ]; then ok "malformed roleRef FAILS"; else ko "missing roleRef target passed the smoke"; fi
grep -q "roleRef Role/no-such-role" "$WORK/roleref.out" && ok "names the missing roleRef target" || ko "roleRef target not named"

# Scenario 4 — workload references a ServiceAccount missing in its namespace.
export KCTL_ROLE_MISSING=''
export KCTL_CRONJOBS="sandbox${TAB}dispatch-watcher${TAB}ghost-writer"
export KCTL_SA_MISSING='ghost-writer@sandbox'
rc=$(run_scenario "workload-missing-sa" "$WORK/wsa.out") || true
if [ "$rc" -ne 0 ]; then ok "missing workload ServiceAccount FAILS"; else ko "missing workload SA passed the smoke"; fi
grep -q "CronJob sandbox/dispatch-watcher" "$WORK/wsa.out" && ok "names the affected workload" || ko "affected workload not named"

# Scenario 5 — server version off the production pin: fail before any apply.
export KCTL_SA_MISSING=''
export KCTL_NODE_VERSION='v1.31.6+k3s1'
rc=$(run_scenario "version-mismatch" "$WORK/ver.out") || true
if [ "$rc" -ne 0 ]; then ok "version mismatch FAILS"; else ko "version mismatch passed the smoke"; fi
grep -q "production k3s pin" "$WORK/ver.out" && ok "reports the pin mismatch" || ko "pin mismatch not reported"
if grep -q "APPLY" "$WORK/ver.out"; then ko "applied manifests despite version mismatch"; else ok "no applies before the pin matches"; fi

# Scenario 6 — a ServiceAccount loses an expected permission (binding broken
# or deleted): the positive can-i assertion must fail the smoke.
export KCTL_NODE_VERSION="$NODE_OK"
export KCTL_CANI='create|jobs|sandbox|system:serviceaccount:agents:panel|no
create|jobs|sandbox|system:serviceaccount:sandbox:dispatcher|yes
delete|pods|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:agents:panel|no
get|secrets|sandbox|system:serviceaccount:sandbox:dispatcher|no
delete|pods|sandbox|system:serviceaccount:sandbox:dispatcher|no
get|nodes||system:serviceaccount:agents:hermes|yes
delete|pods|sandbox|system:serviceaccount:agents:hermes|no
get|secrets|agents|system:serviceaccount:agents:hermes|no
delete|pods|sandbox|system:serviceaccount:sandbox:chaos-monkey|yes
delete|pods|agents|system:serviceaccount:sandbox:chaos-monkey|yes
get|secrets|sandbox|system:serviceaccount:sandbox:chaos-monkey|no
delete|pods|kube-system|system:serviceaccount:sandbox:chaos-monkey|no
patch|deployments|agents|system:serviceaccount:agents:auto-deploy|yes
patch|deployments|sandbox|system:serviceaccount:agents:auto-deploy|no
get|secrets|agents|system:serviceaccount:agents:auto-deploy|no'
rc=$(run_scenario "cani-regression" "$WORK/cani.out") || true
if [ "$rc" -ne 0 ]; then ok "lost ServiceAccount permission FAILS"; else ko "permission regression passed the smoke"; fi
grep -q "RBAC PERMISSION DRIFT" "$WORK/cani.out" && ok "reports the permission drift" || ko "permission drift not reported"

[ "$FAILURES" -eq 0 ] || die "$FAILURES fixture assertion(s) failed"
echo "k8s-smoke fixture tests: PASS"
