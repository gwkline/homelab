#!/bin/sh
# Creates the github-token Secret used by all workloads for private repo access.
#
# Token requirements: GitHub fine-grained PAT with "Contents: read-only" on the
# repos you list in ConfigMaps. Create one at:
#   https://github.com/settings/personal-access-tokens/new
#
# Usage:  ./create-github-secret.sh <namespace>...
# Token is read from GITHUB_PAT env var or stdin, never stored in this repo.
set -eu

if [ $# -eq 0 ]; then
  echo "usage: $0 <namespace>... (e.g. $0 agents)" >&2
  exit 1
fi

if [ -n "${GITHUB_PAT:-}" ]; then
  TOKEN="${GITHUB_PAT}"
else
  printf "paste PAT (input hidden): "
  read -rs TOKEN
  echo
fi

[ -n "$TOKEN" ] || { echo "empty token" >&2; exit 1; }

# Exact bytes, no trailing newline (a newline in the secret breaks git auth).
token_file="$(mktemp)"
trap 'rm -f "$token_file"' EXIT
printf '%s' "$TOKEN" > "$token_file"

for ns in "$@"; do
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic github-token \
    --namespace "$ns" \
    --from-file=token="$token_file" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "==> github-token secret applied in namespace '$ns'"
done
