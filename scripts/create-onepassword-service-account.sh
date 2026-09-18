#!/bin/sh
# Creates the onepassword-service-account Secret — the only manually
# bootstrapped secret for the External Secrets Operator 1Password connection
# (issue #41). The token authenticates a least-privilege 1Password service
# account restricted to the dedicated `homelab` vault; it is shown once when
# the service account is created and must never be committed, pasted into an
# issue, or logged.
#
# Idempotent: re-running converges the same Secret (kubectl create
# --dry-run=client | kubectl apply), so it is safe on rebuilds and rotations.
#
# Token sources (first match wins):
#   1. OP_SERVICE_ACCOUNT_TOKEN environment variable
#   2. stdin (e.g. `op read op://.../token | $0`), or a hidden prompt on a TTY
#
# Namespace arguments default to every namespace with a committed `onepassword`
# SecretStore: agents + sandbox (deploy/github-tokens/base/secretstore.yaml)
# and tailscale (deploy/tailscale/secretstore.yaml).
#
# Usage:
#   OP_SERVICE_ACCOUNT_TOKEN=... ./create-onepassword-service-account.sh [ns]...
#   op read op://.../token | ./create-onepassword-service-account.sh [ns]...
#   ./create-onepassword-service-account.sh [ns]...   # hidden prompt
set -eu

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

TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"

if [ -z "${TOKEN}" ] && [ -t 0 ]; then
  printf 'Paste 1Password service-account token (input hidden): ' >&2
  tty_state=$(stty -g </dev/tty)
  stty -echo </dev/tty
  read -r TOKEN || true
  stty "${tty_state}" </dev/tty
  tty_state=''
  printf '\n' >&2
elif [ -z "${TOKEN}" ]; then
  read -r TOKEN || true
fi

case "${TOKEN}" in
  '') echo "FATAL: no token — set OP_SERVICE_ACCOUNT_TOKEN, pipe it, or paste it" >&2; exit 1 ;;
  ops_*) ;;
  *) echo "FATAL: value does not look like a 1Password service-account token (expected the ops_... secret shown once at SA creation)" >&2; exit 1 ;;
esac

if [ "$#" -eq 0 ]; then
  set -- agents sandbox tailscale
fi

# Byte-exact token via a temp file: never in argv, the process list, or echoed
# output. --from-file (not --from-literal) for the same reason.
token_file=$(mktemp)
printf '%s' "${TOKEN}" > "${token_file}"

for ns in "$@"; do
  kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic onepassword-service-account \
    --namespace "${ns}" \
    --from-file=token="${token_file}" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "==> onepassword-service-account applied in namespace '${ns}'"
done
echo "==> done. Verify: kubectl get secretstore -A   (the onepassword stores must reach Ready)"
