#!/usr/bin/env bash
# Create Secret external-secrets/onepassword-service-account, the one
# hand-entered secret: ClusterSecretStore onepassword authenticates with it.
# It lives only in external-secrets, where only ESO runs. Idempotent; never
# logs the token. Server-side apply, so the value never lands in a
# last-applied-configuration annotation.
#
# Usage (token from env, stdin, or a hidden prompt; ESO must be installed):
#   ./create-onepassword-service-account.sh
#   op read op://.../token | ./create-onepassword-service-account.sh
set -euo pipefail

NAMESPACE=external-secrets

tty_state=''
token_file=''

cleanup() {
  if [ -n "${tty_state}" ]; then
    stty "${tty_state}" </dev/tty >/dev/null 2>&1 || true
  fi
  if [ -n "${token_file}" ]; then
    rm -f "${token_file}"
  fi
}
trap cleanup EXIT

if [ "$#" -ne 0 ]; then
  echo "usage: $0   (takes no arguments; the Secret goes only to namespace ${NAMESPACE})" >&2
  exit 2
fi

if ! kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1; then
  echo "FATAL: namespace ${NAMESPACE} not found; install ESO first (kubectl apply --server-side -k deploy/eso/base)" >&2
  exit 1
fi

TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"

if [ -z "${TOKEN}" ] && [ -t 0 ]; then
  printf 'Paste 1Password service-account token (input hidden): ' >&2
  tty_state=$(stty -g </dev/tty)
  stty -echo </dev/tty
  IFS= read -r TOKEN || true
  stty "${tty_state}" </dev/tty
  tty_state=''
  printf '\n' >&2
elif [ -z "${TOKEN}" ]; then
  IFS= read -r TOKEN || true
fi

case "${TOKEN}" in
  '') echo "FATAL: no token — set OP_SERVICE_ACCOUNT_TOKEN, pipe it, or paste it" >&2; exit 1 ;;
  ops_*) ;;
  *) echo "FATAL: value does not look like a 1Password service-account token (expected the ops_... secret shown once at SA creation)" >&2; exit 1 ;;
esac

# Byte-exact token via a temp file: never in argv, the process list, or echoed
# output. --from-file (not --from-literal) for the same reason.
token_file=$(mktemp)
printf '%s' "${TOKEN}" > "${token_file}"

kubectl create secret generic onepassword-service-account \
  --namespace "${NAMESPACE}" \
  --from-file=token="${token_file}" \
  --dry-run=client -o yaml |
  kubectl apply --server-side --field-manager=onepassword-bootstrap --force-conflicts -f - >/dev/null
echo "==> onepassword-service-account applied in namespace '${NAMESPACE}'"
echo "==> verify: kubectl get clustersecretstore onepassword   (READY True)"
