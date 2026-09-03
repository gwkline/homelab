# External Secrets Operator (ESO)

Pinned ESO install for issue #38. Provider credentials (1Password Connect)
are intentionally absent — see "Credentials" below (issue #41).

## Pinned versions

| Artifact | Pin |
|---|---|
| Helm chart | `external-secrets` **2.10.0** (OCI `ghcr.io/external-secrets/charts/external-secrets:2.10.0`, digest `sha256:09c65bc51967e5bca9aa295e196d365f843eceb3be5600ef77f279ff814b6af2`) |
| App / controller image | `ghcr.io/external-secrets/external-secrets:v2.10.0@sha256:814117b0fd6d121b03e8ba3b6db1cecbe7449a354fc0fc9c4faf73a37aa221b1` (all three Deployments: controller, webhook, cert-controller) |

`eso.yaml` is `helm template ... --version 2.10.0 --include-crds` output with
the image rewritten to the digest pin above and resource bounds set at render
time (controller 10m/64Mi req, 500m/256Mi lim; webhook and cert-controller
10m/32Mi req, 200m/128Mi lim). All containers run as non-root uid 1000 with
`readOnlyRootFilesystem` (chart defaults). CRDs use `external-secrets.io/v1`.

To upgrade: pull the new chart, re-render with the same `--set resources.*`
flags, re-pin the image digest (resolve via the GHCR token + manifest HEAD
recipe), replace `eso.yaml`, re-apply.

## Files

- `namespace.yaml` — `external-secrets` namespace (PSA baseline).
- `eso.yaml` — full chart render (CRDs, RBAC, 3 Deployments, webhook configs).
- `secretstore-placeholder.yaml` — `SecretStore/eso-placeholder` on the ESO
  **fake** provider (static pairs, no credentials). Stand-in until #41.
- `externalsecret-smoke.yaml` — `ExternalSecret/eso-smoke` syncing
  `smoke-password` into Secret `eso-smoke-output`. Proves reconciliation.
- `README.md` — this file.

## Install / recover (plain kubectl, no Flux)

Fresh installs converge in three passes — CRDs must be Established before
the stores apply, and the webhook must have endpoints before its
ValidatingWebhookConfigurations admit the stores. Re-running the same
command is the recovery path (idempotent):

```sh
export KUBECONFIG=~/kubeconfig-homelab
kubectl apply --server-side -k deploy/eso/base   # 1: CRDs, RBAC, Deployments
kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/secretstores.external-secrets.io
kubectl -n external-secrets rollout status deploy/external-secrets
kubectl -n external-secrets rollout status deploy/external-secrets-webhook
kubectl -n external-secrets rollout status deploy/external-secrets-cert-controller
kubectl apply --server-side -k deploy/eso/base   # 2: SecretStore + ExternalSecret
kubectl -n external-secrets get secretstore,externalsecret
kubectl -n external-secrets get secret eso-smoke-output -o jsonpath='{.data.password}' | base64 -d
# expect: eso-smoke-ok
```

`--server-side` is required: CRD annotations exceed the client-side size
limit (same reason as the CNPG operator install).

Flux compatibility: the layout is a plain kustomize base, so a later Flux
`Kustomization` (or `HelmRelease` pinned to chart 2.10.0 + the same values)
can point at `deploy/eso/base` unchanged.

## Ordering vs ExternalSecret resources

Other apps' `ExternalSecret` manifests must declare readiness on ESO: apply
`deploy/eso/base` first and wait for the controller + CRDs
(`kubectl wait --for=condition=Established crd/externalsecrets.external-secrets.io`)
before applying any namespaced `ExternalSecret`/`SecretStore`.

## Credentials (issue #41)

No real provider credentials exist on this machine (no 1Password CLI), so
nothing here authenticates to 1Password. When they do:

1. Create the credential Secret out-of-band (never commit values):
   `kubectl -n external-secrets create secret generic onepassword-creds
   --from-literal=token=<token> --from-literal=connect-host=<url>`.
2. Add a `SecretStore` (or `ClusterSecretStore`) with
   `provider.onePasswordSDK` referencing that Secret — new file in this dir,
   added to `kustomization.yaml`.
3. Repoint consumers at it. Keep the fake placeholder until the last consumer
   migrates, then delete the placeholder files.

## Uninstall

```sh
export KUBECONFIG=~/kubeconfig-homelab
kubectl delete -k deploy/eso/base
# If CRDs should survive (other apps still reference the API types), delete
# workloads only:
#   kubectl -n external-secrets delete deploy/external-secrets \
#     deploy/external-secrets-webhook deploy/external-secrets-cert-controller
# Full purge incl. CRDs + namespace:
kubectl delete crd -l app.kubernetes.io/instance=external-secrets
kubectl delete ns external-secrets
```

Note: deleting the `ExternalSecret` CRD orphans Secrets it previously
created (`eso-smoke-output` survives by design — clean up by hand).
