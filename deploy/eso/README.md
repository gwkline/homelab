# External Secrets Operator

ESO syncs Kubernetes Secrets from the `homelab` 1Password vault via the 1Password SDK provider (no Connect server). `base/eso.yaml` is a vendored `helm template --include-crds` render of chart `external-secrets` 2.10.0 with the image digest-pinned and resource bounds set at render time.

This base holds only the operator. The `onepassword` SecretStores live next to their consumers: `deploy/github-tokens/base/secretstore.yaml` (agents, sandbox, work), `deploy/tailscale/secretstore.yaml`, and `deploy/postgres/base/secretstore.yaml` (database).

## Prerequisites

Secret `onepassword-service-account` (key `token`) in every namespace with a store. Create a 1Password service account restricted to the `homelab` vault, then run `scripts/create-onepassword-service-account.sh` (token from env, stdin, or a hidden prompt; idempotent).

## Apply

Server-side is required because two CRDs exceed the client-side annotation limit. Apply before `clusters/home`:

```sh
kubectl apply --server-side -k deploy/eso/base
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/secretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets-webhook
kubectl -n external-secrets rollout status deploy/external-secrets
```

## Verify

```sh
kubectl -n agents get secretstore onepassword           # READY True
kubectl -n agents get externalsecret github-token       # Ready True
```

## Rotate the service-account token

1. Create a new service account restricted to the `homelab` vault.
2. Re-run `scripts/create-onepassword-service-account.sh`; it updates every namespace in place.
3. `kubectl -n external-secrets rollout restart deploy/external-secrets` to re-authenticate now (otherwise within the hour).
4. Revoke the old service account.

Until the token exists, stores stay unauthenticated and ExternalSecrets retry; Secrets already synced keep workloads running.

## Upgrade

Re-render the new chart version with the same `--set resources.*` flags, digest-pin the image, replace `base/eso.yaml`, re-apply server-side.
