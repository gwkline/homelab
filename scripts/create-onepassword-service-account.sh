#!/usr/bin/env bash
# Create Secret onepassword-service-account, the one hand-entered secret ESO
# needs. Idempotent; never logs the token.
#
# Usage (token from env, stdin, or a hidden prompt; default namespaces:
# agents sandbox work tailscale database):
#   ./create-onepassword-service-account.sh [ns]...
#   op read op://.../token | ./create-onepassword-service-account.sh [ns]...
set -euo pipefail

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

if [ "$#" -eq 0 ]; then
  set -- agents sandbox work tailscale database
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
