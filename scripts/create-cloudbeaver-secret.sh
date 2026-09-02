#!/bin/sh
# Creates the cloudbeaver-db Secret for CloudBeaver's default PostgreSQL
# connection (agents namespace, keys: user, password).
#
# The role must be least-privilege (no superuser) - see the grants in
# deploy/cloudbeaver/base/README.md. Values are pasted from your password
# manager at the prompt and are never stored in this repo, argv, or history.
#
# Usage: ./create-cloudbeaver-secret.sh [namespace]
set -eu

NS="${1:-agents}"
DEFAULT_USER=cloudbeaver_ro

printf 'namespace [%s]: ' "$NS"
read -r NS_INPUT
[ -n "${NS_INPUT:-}" ] && NS="$NS_INPUT"

printf 'PostgreSQL username [%s]: ' "$DEFAULT_USER"
read -r DB_USER
[ -n "${DB_USER:-}" ] || DB_USER="$DEFAULT_USER"

printf 'Paste %s password (input hidden): ' "$DB_USER"
if [ -t 0 ]; then
  TTY_STATE=$(stty -g </dev/tty)
  stty -echo </dev/tty
  read -r DB_PASSWORD
  stty "$TTY_STATE" </dev/tty
  printf '\n'
else
  read -r DB_PASSWORD
fi

[ -n "${DB_PASSWORD:-}" ] || { echo "empty password" >&2; exit 1; }

# Exact bytes via a temp file, like create-github-secret.sh - the password
# must not appear in the process list.
pw_file=$(mktemp)
trap 'rm -f "$pw_file"' EXIT
printf '%s' "$DB_PASSWORD" > "$pw_file"

kubectl create secret generic cloudbeaver-db \
  --namespace "$NS" \
  --from-literal=user="$DB_USER" \
  --from-file=password="$pw_file" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "==> cloudbeaver-db secret applied in namespace '$NS'"
