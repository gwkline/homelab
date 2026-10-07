#!/bin/sh
# Proves the sandbox Job admission policy
# (deploy/policies/base/job-admission.yaml) against a live cluster.
#
# Every fixture under deploy/policies/fixtures/ is applied server-side with
# --dry-run=server, so admission runs but nothing persists:
#   allowed-*.yaml   agent identity          -> must be admitted
#   denied-*.yaml    agent identity          -> must be rejected, naming the rule
#   exempt-*.yaml    agent identity          -> must be rejected (it automounts)
#   exempt-*.yaml    kube-controller-manager -> must be admitted (the CronJob
#                    controller materializes operator-managed Jobs)
#   denied-foreign-image-job.yaml unimpersonated (operator, system:masters)
#                    -> must be admitted (break-glass bypasses this policy)
#
# On a cluster where the sandbox namespace also enforces Pod Security baseline
# (the production layout), fixtures PSS rejects too may be denied by
# PodSecurity before this policy runs; that counts as a rejection as well.
#
# Usage: ./scripts/job-policy-test.sh
# Needs: a kubeconfig whose current context is a cluster-admin holding group
# system:masters (the break-glass identity, which cluster-admins have
# impersonate rights for), with the policy already applied.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIXTURES="$REPO_ROOT/deploy/policies/fixtures"
AGENT="--as=job-policy-agent --as-group=system:serviceaccounts:sandbox"
CONTROLLER="--as=system:kube-controller-manager"
FAILED=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ok() { echo "ok: $1"; }

fail() {
  echo "FAIL: $1" >&2
  FAILED=$((FAILED + 1))
}

show_err() {
  sed 's/^/  /' "$TMP/err"
}

# VAP message substring expected per fixture. All denials also accept a
# PodSecurity denial (it runs first on production namespaces).
vap_message() {
  case "$1" in
    denied-host-namespaces-job.yaml) echo "must not share host network, PID, or IPC namespaces" ;;
    denied-host-port-job.yaml) echo "must not declare host ports" ;;
    denied-service-account-job.yaml) echo "must use an approved ServiceAccount" ;;
    denied-automount-job.yaml) echo "must set automountServiceAccountToken: false" ;;
    denied-sa-token-volume-job.yaml) echo "must not mount projected ServiceAccount tokens" ;;
    denied-privileged-job.yaml) echo "must not be privileged" ;;
    denied-escalation-job.yaml) echo "must not set allowPrivilegeEscalation: true" ;;
    denied-foreign-image-job.yaml) echo "must use ghcr.io/gwkline/homelab images" ;;
    denied-hostpath-job.yaml) echo "may only use emptyDir, secret, configMap, projected, or" ;;
    denied-pvc-job.yaml) echo "may only use emptyDir, secret, configMap, projected, or" ;;
    denied-writable-secret-job.yaml) echo "must mount secret volumes readOnly" ;;
    denied-no-mem-limit-job.yaml) echo "must set a memory limit of 16Gi or less" ;;
    denied-mem-limit-ceiling-job.yaml) echo "must set a memory limit of 16Gi or less" ;;
    denied-cpu-limit-ceiling-job.yaml) echo "cpu limits must be 4 or less" ;;
    denied-emptydir-no-limit-job.yaml) echo "must set an emptyDir sizeLimit of 10Gi or less" ;;
    exempt-chaos-cronjob-job.yaml) echo "must set automountServiceAccountToken: false" ;;
    *) echo "" ;;
  esac
}

expect_admitted() { # fixture, kubectl args...
  f=$1
  shift
  base=${f##*/}
  if kubectl apply --server-side --dry-run=server -f "$f" "$@" >"$TMP/out" 2>"$TMP/err"; then
    ok "$base admitted"
  else
    fail "$base expected admitted:"
    show_err
  fi
}

expect_denied() { # fixture, expected message, kubectl args...
  f=$1
  want=$2
  shift 2
  base=${f##*/}
  if kubectl apply --server-side --dry-run=server -f "$f" "$@" >"$TMP/out" 2>"$TMP/err"; then
    fail "$base expected rejected but was admitted"
    return 0
  fi
  if [ -n "$want" ] && grep -q "$want" "$TMP/err"; then
    ok "$base rejected: $want"
  elif grep -q "pod-security.kubernetes.io" "$TMP/err"; then
    ok "$base rejected by PodSecurity (runs before this policy)"
  else
    fail "$base rejected but without expected message '$want':"
    show_err
  fi
}

echo '==> policy present'
if ! kubectl get validatingadmissionpolicy sandbox-job-guard >/dev/null 2>&1; then
  echo 'FAIL: ValidatingAdmissionPolicy sandbox-job-guard not found; apply it first:' >&2
  echo '  kubectl apply -f deploy/policies/base/job-admission.yaml' >&2
  exit 1
fi

echo '==> approved shapes are admitted (agent identity)'
for f in "$FIXTURES"/allowed-*.yaml; do
  # shellcheck disable=SC2086 # two impersonation flags, word splitting wanted
  expect_admitted "$f" $AGENT
done

echo '==> malicious shapes are rejected (agent identity)'
for f in "$FIXTURES"/denied-*.yaml; do
  want=$(vap_message "${f##*/}")
  # shellcheck disable=SC2086 # two impersonation flags, word splitting wanted
  expect_denied "$f" "$want" $AGENT
done

echo '==> CronJob-controller identity materializes operator-managed Jobs'
for f in "$FIXTURES"/exempt-*.yaml; do
  want=$(vap_message "${f##*/}")
  # shellcheck disable=SC2086 # two impersonation flags, word splitting wanted
  expect_denied "$f" "$want" $AGENT
  # shellcheck disable=SC2086 # one impersonation flag, word splitting wanted
  expect_admitted "$f" $CONTROLLER
done

echo '==> operator break-glass bypasses the policy'
expect_admitted "$FIXTURES/denied-foreign-image-job.yaml"

if [ "$FAILED" -ne 0 ]; then
  echo "FAIL: $FAILED fixture assertion(s) failed" >&2
  exit 1
fi
echo 'ALL FIXTURE ASSERTIONS PASSED'
