#!/usr/bin/env bash
# EMERGENCY FALLBACK for the ExternalSecret-managed backup-target Secret
# (deploy/backup/base/externalsecret.yaml). The normal path is 1Password +
# External Secrets Operator: put the values in the `restic-backup` vault item
# and `kubectl apply -k deploy/backup/base`.
#
# Use this script only when ESO or the vault is unavailable (e.g. a cold
# rebuild before the operator is installed). It creates the same Secret
# imperatively; once ESO is healthy again it reconciles the Secret back to
# the vault state (creationPolicy: Owner), so hand-made values do not stick.
# Re-store the values in the 1Password item as soon as you can.
#
# You need a Backblaze B2 (or any S3-compatible) bucket. For S3 set
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY instead of the B2 pair and use an
# s3: repository URL.
#
# Byte-safe input: values are read with `IFS= read -r` directly into their
# variables — no command substitution in between, which would strip trailing
# newlines (and, in a `$(...)` prompt helper, inject a leading blank line
# into every captured value), and no bare `read`, which would strip
# leading/trailing spaces and tabs. `-r` keeps backslashes. Every byte you
# paste reaches the Secret. Prompts and the visual newline after each hidden
# read go to stderr only (`read -p` writes there natively; the newline is
# `printf '\n' >&2`), so stdout never carries captured residue.
# Regression test: scripts/tests/create-backup-secret.test.sh
#
# Usage: ./create-backup-secret.sh <bucket-name> [bucket-path]
# Prompts for values (input hidden); nothing is stored in this repo.
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket-name> [bucket-path]}"
PREFIX="${2:-homelab}"

# Namespace where the restic CronJob runs (co-located with the PVCs it reads).
NS=agents

if [ -z "${B2_ACCOUNT_ID:-}" ]; then
  IFS= read -rsp "B2 keyID: " B2_ACCOUNT_ID; printf '\n' >&2
fi
if [ -z "${B2_ACCOUNT_KEY:-}" ]; then
  IFS= read -rsp "B2 applicationKey: " B2_ACCOUNT_KEY; printf '\n' >&2
fi
if [ -z "${RESTIC_PASSWORD:-}" ]; then
  IFS= read -rsp "restic repo password (invent one, save it elsewhere too): " RESTIC_PASSWORD; printf '\n' >&2
fi

[ -n "$B2_ACCOUNT_ID" ] && [ -n "$B2_ACCOUNT_KEY" ] && [ -n "$RESTIC_PASSWORD" ] \
  || { echo "empty value" >&2; exit 1; }

kubectl get namespace "$NS" >/dev/null 2>&1 \
  || { echo "namespace '$NS' not found — run: kubectl apply -f deploy/namespaces.yaml" >&2; exit 1; }

kubectl create secret generic backup-target \
  --namespace "$NS" \
  --from-literal=RESTIC_REPOSITORY="b2:${BUCKET}/${PREFIX}" \
  --from-literal=B2_ACCOUNT_ID="$B2_ACCOUNT_ID" \
  --from-literal=B2_ACCOUNT_KEY="$B2_ACCOUNT_KEY" \
  --from-literal=RESTIC_PASSWORD="$RESTIC_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "==> backup-target secret applied in namespace '$NS'"
