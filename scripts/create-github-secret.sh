#!/usr/bin/env sh
# DEPRECATED (issue #45): GitHub tokens are no longer created manually.
#
# Secrets `github-token` and `github-token-writer` are synced from the
# 1Password homelab vault by External Secrets Operator — see
# deploy/github-tokens/base/README.md.
#
# To rotate: update the `github-readonly` / `github-writer` item's `token`
# field in 1Password; it propagates within ~1h (restart env-var consumers).
set -eu

echo "create-github-secret.sh is DEPRECATED." >&2
echo "GitHub tokens are synced from 1Password by External Secrets:" >&2
echo "  kubectl apply -k deploy/github-tokens/base   # see deploy/github-tokens/base/README.md" >&2
echo "Rotate by updating the github-readonly / github-writer item in 1Password." >&2
exit 1
