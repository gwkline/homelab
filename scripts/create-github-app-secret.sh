#!/bin/sh
# Creates the github-app Secret used by the #70 token service to mint
# short-lived factory installation tokens (replacing the writer PAT).
#
# Values come from the dedicated 1Password item (see docs/github-app.md):
#   app-id            numeric GitHub App ID
#   installation-id   numeric installation ID
#   private-key       the App .pem private key, verbatim
#   webhook-secret    optional; only if a webhook receiver is ever deployed
#
# Usage:
#   ./create-github-app-secret.sh <namespace>...
# Values are read from env (GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID,
# GITHUB_APP_PRIVATE_KEY, optional GITHUB_APP_WEBHOOK_SECRET) or prompted,
# and never stored in this repo.
set -eu

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <namespace>... (e.g. $0 sandbox)" >&2
  exit 1
fi

APP_ID="${GITHUB_APP_ID:-}"
INSTALLATION_ID="${GITHUB_APP_INSTALLATION_ID:-}"
PRIVATE_KEY="${GITHUB_APP_PRIVATE_KEY:-}"
WEBHOOK_SECRET="${GITHUB_APP_WEBHOOK_SECRET:-}"

if [ -z "${APP_ID}" ]; then
  printf "App ID: "
  read -r APP_ID
fi
if [ -z "${INSTALLATION_ID}" ]; then
  printf "Installation ID: "
  read -r INSTALLATION_ID
fi
if [ -z "${PRIVATE_KEY}" ]; then
  printf "paste private key PEM (multi-line ok, end with Ctrl-D):\n"
  PRIVATE_KEY="$(cat)"
fi

case "${APP_ID}" in
  ''|*[!0-9]*) echo "FATAL: App ID must be numeric" >&2; exit 1 ;;
esac
case "${INSTALLATION_ID}" in
  ''|*[!0-9]*) echo "FATAL: Installation ID must be numeric" >&2; exit 1 ;;
esac
case "${PRIVATE_KEY}" in
  *"PRIVATE KEY"*) ;;
  *) echo "FATAL: private key does not look like a PEM" >&2; exit 1 ;;
esac

# A PEM pasted as a single line carries \n escapes; expand them so the
# mounted key parses. A real multi-line PEM passes through untouched.
case "${PRIVATE_KEY}" in
  *"\n"*) PRIVATE_KEY="$(printf '%b' "${PRIVATE_KEY}")" ;;
esac

# Exact bytes for the numeric IDs; PEM gets the canonical trailing newline.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s\n' "${PRIVATE_KEY}" > "${work}/private-key"
printf '%s' "${APP_ID}" > "${work}/app-id"
printf '%s' "${INSTALLATION_ID}" > "${work}/installation-id"

for ns in "$@"; do
  kubectl create namespace "${ns}" --dry-run=client -o yaml | kubectl apply -f -
  if [ -n "${WEBHOOK_SECRET}" ]; then
    printf '%s' "${WEBHOOK_SECRET}" > "${work}/webhook-secret"
    kubectl create secret generic github-app \
      --namespace "${ns}" \
      --from-file=app-id="${work}/app-id" \
      --from-file=installation-id="${work}/installation-id" \
      --from-file=private-key="${work}/private-key" \
      --from-file=webhook-secret="${work}/webhook-secret" \
      --dry-run=client -o yaml | kubectl apply -f -
  else
    kubectl create secret generic github-app \
      --namespace "${ns}" \
      --from-file=app-id="${work}/app-id" \
      --from-file=installation-id="${work}/installation-id" \
      --from-file=private-key="${work}/private-key" \
      --dry-run=client -o yaml | kubectl apply -f -
  fi
  echo "==> github-app secret applied in namespace '${ns}'"
done
