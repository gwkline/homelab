#!/usr/bin/env bash
# Bootstrap the ONLY manually created Kubernetes secret in this stack: the
# 1Password service-account token External Secrets Operator uses to reach the
# dedicated `homelab` vault (issue #41). It cannot be synced by ESO itself
# (circular dependency), so it enters the cluster exactly once, here.
#
# Create the token first: a least-privilege 1Password service account
# restricted to the `homelab` vault only (1Password -> Developer -> service
# accounts, "ops_..." token). The value lives in 1Password's operator
# storage and in the Secrets this script writes — never in git, issues,
# shell history, or terminal output: input is hidden, and the token is
# piped into kubectl on stdin rather than passed on argv (where `ps` would
# expose it).
#
# Idempotent: every run renders the same Secret with
# `--dry-run=client -o yaml | kubectl apply`, so re-running is safe and is
# also the documented rotation path — re-run with a new token to swap it
# in place (ESO rebuilds its provider client from the changed Secret).
#
# Input: the OP_SERVICE_ACCOUNT_TOKEN environment variable, or a hidden
# stdin prompt when it is unset (piping the token in works too).
#
# Writes Secret `onepassword-service-account` (key `token`) into every
# namespace hosting a `onepassword` SecretStore:
#   agents, sandbox — deploy/github-tokens/base/secretstore.yaml
#   tailscale       — deploy/tailscale/secretstore.yaml
# Keep that list in sync with those stores.
#
# Usage: ./create-onepassword-secret.sh
set -euo pipefail

TOKEN="${OP_SERVICE_ACCOUNT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  IFS= read -rsp "1Password service-account token (input hidden): " TOKEN
  printf '\n' >&2
fi
[ -n "$TOKEN" ] || { echo "empty token" >&2; exit 1; }
case "$TOKEN" in
ops_*) ;;
*)
  echo "WARN: token does not start with 'ops_' — 1Password service-account tokens normally do; continuing" >&2
  ;;
esac

command -v kubectl >/dev/null 2>&1 || { echo "kubectl not found" >&2; exit 1; }

for NS in agents sandbox tailscale; do
  # Virgin-cluster tolerance: the rebuild runbook bootstraps this secret
  # before deploy/namespaces.yaml and the tailscale manifests, so create a
  # missing namespace here; the later applies add their PSA labels.
  kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"
  printf '%s' "$TOKEN" | kubectl create secret generic onepassword-service-account \
    --namespace "$NS" \
    --from-file=token=/dev/stdin \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "==> onepassword-service-account applied in namespace '$NS'"
done
