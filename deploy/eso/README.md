# External Secrets Operator

ESO syncs Kubernetes Secrets from the `homelab` 1Password vault via the 1Password SDK provider (no Connect server). `base/eso.yaml` is a vendored `helm template --include-crds` render of chart `external-secrets` 2.10.0 with the image digest-pinned and resource bounds set at render time.

This base holds only the operator. The single store, `ClusterSecretStore` `onepassword`, is in `deploy/github-tokens/base/secretstore.yaml` (part of `clusters/home`). Its `spec.conditions` lists the namespaces whose ExternalSecrets may use it; an ExternalSecret anywhere else is refused.

## Prerequisites

Secret `onepassword-service-account` (key `token`) in namespace `external-secrets`, and nowhere else. Create a 1Password service account restricted to the `homelab` vault, then run `scripts/create-onepassword-service-account.sh` after the operator is installed (token from env, stdin, or a hidden prompt; idempotent; server-side apply, so the token never lands in a `last-applied-configuration` annotation).

## Apply

Server-side is required because two CRDs exceed the client-side annotation limit. Apply before `clusters/home`, after the PriorityClasses its pods use:

```sh
kubectl apply -f deploy/policies/base/priorityclasses.yaml
kubectl apply --server-side -k deploy/eso/base
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/clustersecretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets-webhook
kubectl -n external-secrets rollout status deploy/external-secrets
```

## Verify

```sh
kubectl get clustersecretstore onepassword           # READY True
kubectl get externalsecret -A                        # every row Ready True
```

## Rotate the service-account token

1. Create a new service account restricted to the `homelab` vault.
2. Re-run `scripts/create-onepassword-service-account.sh`; it updates the Secret in place.
3. `kubectl -n external-secrets rollout restart deploy/external-secrets` to re-authenticate now (otherwise within the hour).
4. Revoke the old service account.

Until the token exists, the store stays unauthenticated and ExternalSecrets retry; Secrets already synced keep workloads running.

## Upgrade

Re-render the new chart version with the same `--set resources.*` flags, digest-pin the image, replace `base/eso.yaml`, re-apply server-side.
