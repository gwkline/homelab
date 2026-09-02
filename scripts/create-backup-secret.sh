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
# Usage: ./create-backup-secret.sh <bucket-name> [bucket-path]
# Prompts for values (input hidden); nothing is stored in this repo.
set -euo pipefail

BUCKET="${1:?usage: $0 <bucket-name> [bucket-path]}"
PREFIX="${2:-homelab}"

# Reads hidden input and echoes it; caller captures via command substitution.
prompt_hidden() {
  local msg="$1" val
  read -rsp "$msg" val; echo
  printf '%s' "$val"
}

: "${B2_ACCOUNT_ID:=$(prompt_hidden "B2 keyID: ")}"
: "${B2_ACCOUNT_KEY:=$(prompt_hidden "B2 applicationKey: ")}"
: "${RESTIC_PASSWORD:=$(prompt_hidden "restic repo password (invent one, save it elsewhere too): ")}"

[[ -n "$B2_ACCOUNT_ID" && -n "$B2_ACCOUNT_KEY" && -n "$RESTIC_PASSWORD" ]] \
  || { echo "empty value" >&2; exit 1; }

kubectl create namespace backup --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic backup-target \
  --namespace backup \
  --from-literal=RESTIC_REPOSITORY="b2:${BUCKET}/${PREFIX}" \
  --from-literal=B2_ACCOUNT_ID="$B2_ACCOUNT_ID" \
  --from-literal=B2_ACCOUNT_KEY="$B2_ACCOUNT_KEY" \
  --from-literal=RESTIC_PASSWORD="$RESTIC_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -
echo "==> backup-target secret applied in namespace 'backup'"
