#!/bin/sh
# Admission fixture tests for the sandbox Jobs policy (issue #28).
#
# Applies every fixture in deploy/sandbox-policy/fixtures against a live
# cluster with the policy from deploy/sandbox-policy/base installed, and
# asserts the admission result of each:
#   - allowed/*.yaml   must be ADMITTED when applied as an agent identity
#                      (impersonating the dispatcher ServiceAccount — the
#                      exact identity loop-manager RBAC gives Job-create)
#   - denied/*.yaml    must be REJECTED, and the rejection message must
#                      contain the fragment declared in the fixture's
#                      `# expect-deny: <fragment>` header
#   - break-glass.yaml must be REJECTED as an agent identity and ADMITTED
#                      as the plain cluster-admin user (system:masters)
#
# Every fixture Job carries the policy.gwkline.io/fixture=true label, so
# cleanup only ever touches fixture objects — never real workloads.
#
# Jobs are applied server-side (--server-side) per the issue's verification
# contract. The policy is installed first unless SKIP_POLICY_APPLY=1 (use on
# a cluster where the base is already applied and must not be touched).
#
# Intended to run in CI against a throwaway k3s (see ci.yaml
# sandbox-policy job); running it against the live homelab cluster is safe
# for the cluster but briefly creates and deletes fixture Jobs in `sandbox`.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
POLICY_DIR="$ROOT/deploy/sandbox-policy/base"
FIXTURE_DIR="$ROOT/deploy/sandbox-policy/fixtures"
JOBS_POLICY=sandbox-jobs-hardening
CRONJOBS_POLICY=sandbox-jobs-hardening-cronjobs
NS=sandbox
AS_AGENT="--as=system:serviceaccount:sandbox:dispatcher"
TMP=$(mktemp -d)
CHECKS=0
FAILURES=0
CLUSTER_SEEN=0

cleanup() {
  rm -rf "$TMP"
  if [ "$CLUSTER_SEEN" = "1" ]; then
    kubectl delete jobs,cronjobs -n "$NS" \
      -l policy.gwkline.io/fixture=true --ignore-not-found >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "FAIL: $1" >&2
  FAILURES=$((FAILURES + 1))
}

ok() {
  CHECKS=$((CHECKS + 1))
  echo "ok: $1"
}

# expect_allow <fixture-file> [extra kubectl args...]
expect_allow() {
  fix_file=$1
  shift
  if kubectl apply --server-side "$@" -f "$fix_file" >/dev/null 2>"$TMP/err"; then
    ok "admitted $(basename "$fix_file")"
    kubectl delete -f "$fix_file" --ignore-not-found >/dev/null 2>&1 || true
  else
    fail "fixture was rejected: $(basename "$fix_file")"
    sed 's/^/    /' "$TMP/err" >&2
  fi
}

# expect_deny <fixture-file> [extra kubectl args...]
expect_deny() {
  fix_file=$1
  shift
  want=$(sed -n 's/^# expect-deny: //p' "$fix_file" | head -n 1)
  if kubectl apply --server-side "$@" -f "$fix_file" >"$TMP/out" 2>"$TMP/err"; then
    fail "fixture was ADMITTED but must be denied: $(basename "$fix_file")"
    kubectl delete -f "$fix_file" --ignore-not-found >/dev/null 2>&1 || true
    return 0
  fi
  if [ -n "$want" ] && grep -q -e "$want" "$TMP/err"; then
    ok "denied $(basename "$fix_file") (message mentions '$want')"
  else
    fail "denied $(basename "$fix_file") but message lacks fragment '$want'"
    sed 's/^/    /' "$TMP/err" >&2
  fi
}

command -v kubectl >/dev/null 2>&1 || {
  echo "FAIL: kubectl not found; this test needs a cluster (see ci.yaml)" >&2
  exit 1
}
if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
  kubectl create namespace "$NS" >/dev/null
fi
CLUSTER_SEEN=1

if [ "${SKIP_POLICY_APPLY:-0}" != "1" ]; then
  kubectl kustomize "$POLICY_DIR" >"$TMP/policy.yaml"
  kubectl apply -f "$TMP/policy.yaml" >/dev/null
fi

# VAP admission is in-process: once the policies and bindings read back, the
# rules are live — no webhook propagation to wait for.
i=0
while [ "$i" -lt 30 ]; do
  if kubectl get validatingadmissionpolicy "$JOBS_POLICY" "$CRONJOBS_POLICY" >/dev/null 2>&1 &&
    kubectl get validatingadmissionbinding "$JOBS_POLICY" "$CRONJOBS_POLICY" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done
if ! kubectl get validatingadmissionpolicy "$JOBS_POLICY" "$CRONJOBS_POLICY" >/dev/null 2>&1 ||
  ! kubectl get validatingadmissionbinding "$JOBS_POLICY" "$CRONJOBS_POLICY" >/dev/null 2>&1; then
  echo "FAIL: $JOBS_POLICY / $CRONJOBS_POLICY policies+bindings not established after 30s" >&2
  exit 1
fi

echo "==> allowed fixtures (applied as agent identity $AS_AGENT)"
for fix in "$FIXTURE_DIR"/allowed/*.yaml; do
  expect_allow "$fix" "$AS_AGENT"
done

echo "==> denied fixtures (applied as agent identity $AS_AGENT)"
for fix in "$FIXTURE_DIR"/denied/*.yaml; do
  expect_deny "$fix" "$AS_AGENT"
done

echo "==> break-glass: agents denied, operators admitted"
expect_deny "$FIXTURE_DIR/break-glass.yaml" "$AS_AGENT"
expect_allow "$FIXTURE_DIR/break-glass.yaml"

if [ "$FAILURES" -ne 0 ]; then
  echo "==> $FAILURES of $((CHECKS + FAILURES)) admission checks FAILED" >&2
  exit 1
fi
echo "==> all $CHECKS admission checks passed"
