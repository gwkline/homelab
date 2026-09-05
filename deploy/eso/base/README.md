# External Secrets Operator (ESO)

Pinned ESO install for issue #38. The 1Password **SDK** provider connection (issue #41 — no Connect server) is documented under "Credentials" below.

## Pinned versions

| Artifact | Pin |
| --- | --- |
| Helm chart | `external-secrets` **2.10.0** (OCI `ghcr.io/external-secrets/charts/external-secrets:2.10.0`, digest `sha256:09c65bc51967e5bca9aa295e196d365f843eceb3be5600ef77f279ff814b6af2`) |
| App / controller image | `ghcr.io/external-secrets/external-secrets:v2.10.0@sha256:814117b0fd6d121b03e8ba3b6db1cecbe7449a354fc0fc9c4faf73a37aa221b1` (all three Deployments: controller, webhook, cert-controller) |

`eso.yaml` is `helm template ... --version 2.10.0 --include-crds` output with the image rewritten to the digest pin above and resource bounds set at render time (controller 10m/64Mi req, 500m/256Mi lim; webhook and cert-controller 10m/32Mi req, 200m/128Mi lim). All containers run as non-root uid 1000 with `readOnlyRootFilesystem` (chart defaults). CRDs use `external-secrets.io/v1`.

To upgrade: pull the new chart, re-render with the same `--set resources.*` flags, re-pin the image digest (resolve via the GHCR token + manifest HEAD recipe), replace `eso.yaml`, re-apply.

## Files

- `namespace.yaml` — `external-secrets` namespace (PSA baseline).
- `eso.yaml` — full chart render (CRDs, RBAC, 3 Deployments, webhook configs).
- `secretstore-placeholder.yaml` — `SecretStore/eso-placeholder` on the ESO **fake** provider (static pairs, no credentials). Credential-free reconciliation canary; the real 1Password path lives per namespace (see Credentials).
- `externalsecret-smoke.yaml` — `ExternalSecret/eso-smoke` syncing `smoke-password` into Secret `eso-smoke-output`. Proves reconciliation without credentials. The provider-path smoke (`onepassword-smoke`, issue #41) lives in `deploy/github-tokens/base/onepassword-smoke.yaml`, next to the stores it exercises.
- `README.md` — this file.

## Install / recover (plain kubectl, no Flux)

Fresh installs converge in three passes — CRDs must be Established before the stores apply, and the webhook must have endpoints before its ValidatingWebhookConfigurations admit the stores. Re-running the same command is the recovery path (idempotent):

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

`--server-side` is required: CRD annotations exceed the client-side size limit (same reason as the CNPG operator install).

Flux compatibility: the layout is a plain kustomize base, so a later Flux `Kustomization` (or `HelmRelease` pinned to chart 2.10.0 + the same values) can point at `deploy/eso/base` unchanged.

## Ordering vs ExternalSecret resources

Other apps' `ExternalSecret` manifests must declare readiness on ESO: apply `deploy/eso/base` first and wait for the controller + CRDs (`kubectl wait --for=condition=Established crd/externalsecrets.external-secrets.io`) before applying any namespaced `ExternalSecret`/`SecretStore`.

## Credentials — 1Password SDK provider (issue #41)

ESO reads the one dedicated 1Password vault **`homelab`** through the official `onepasswordSDK` provider (the pinned build above ships it — `onepasswordSDK` is in the rendered CRDs). No Connect server, no in-cluster 1Password dependency, no circular secret problem.

- Namespace-scoped `SecretStore`s named `onepassword`, each pinned to exactly that one vault, wire the provider per namespace: `agents` + `sandbox` (`deploy/github-tokens/base/secretstore.yaml`), `tailscale` (`deploy/tailscale/secretstore.yaml`). No store spans vaults; no ClusterSecretStore is needed.
- The 1Password **service-account token** (least-privilege, restricted to the `homelab` vault) is the only manually bootstrapped Kubernetes secret for this provider. Create it in 1Password (Developer → service accounts); never commit or paste it into issues.

### Bootstrap

`scripts/create-onepassword-secret.sh` writes Secret `onepassword-service-account` (key `token`) into every namespace hosting a `onepassword` SecretStore, creating missing namespaces on a virgin cluster:

```sh
export OP_SERVICE_ACCOUNT_TOKEN=... # or leave unset: hidden stdin prompt
./scripts/create-onepassword-secret.sh
```

The script is idempotent (`--dry-run=client` + `kubectl apply`) and never logs the token: input is hidden and it is piped to kubectl on stdin, never on argv. Re-running is the rotation path (below).

### Verification (harmless test item)

1. In vault `homelab`, create item `eso-smoke` with a text field labeled `password` holding any harmless value.
2. Store health: `kubectl -n agents get secretstore onepassword` → `READY=True`.
3. Sync (`external-secrets.io/v1`): `kubectl -n agents get externalsecret onepassword-smoke` → `Ready=True`, and Secret `onepassword-smoke-output` carries the value:

```sh
kubectl -n agents get secret onepassword-smoke-output -o jsonpath='{.data.password}' | base64 -d; echo
```

4. Delete-and-restore: `kubectl -n agents delete secret onepassword-smoke-output`, then force the reconcile and watch it flip back to `Ready=True`:

```sh
kubectl -n agents annotate externalsecret onepassword-smoke \
  external-secrets.io/force-sync="$(date +%s)" --overwrite
kubectl -n agents get externalsecret onepassword-smoke -w
```

(Without the annotation ESO restores it at the next refresh, ≤ `refreshInterval` = 1h.)

On a fresh cluster the smoke stays `Pending` until the token is bootstrapped and `kubectl apply -k deploy/github-tokens/base` has created the `agents` store — then it converges on its own.

### Rotation

**Service-account token** (the bootstrap secret): create a new least-privilege service account in 1Password first (create-then-swap — the old token keeps working until revoked), then re-run `scripts/create-onepassword-secret.sh` with the new token. It updates the same Secrets in place; ESO rebuilds its provider client from the changed Secret on the next reconcile. Force a proof on one ExternalSecret with the `external-secrets.io/force-sync` annotation above and confirm the store reports `READY=True`. Revoke the old service account only after a synced Secret refreshes successfully.

**Vault item values** (github tokens, tailscale OAuth, backup credentials): update the item in 1Password; ESO converges within the ExternalSecret's `refreshInterval` (1h) plus the ~5m SDK cache. Per-workload pickup and drills: `deploy/github-tokens/base/README.md`, `deploy/tailscale/README.md`, `docs/runbook-server-cluster.md` §11.

### Disaster recovery

- The token is a documented prerequisite (`docs/rebuild-runbook.md` §1) and step 1 of the rebuild re-runs `scripts/create-onepassword-secret.sh`; every synced Secret is then recreated from the vault automatically (`creationPolicy: Owner` — deleting one is safe, ESO restores it).
- If ESO itself is unavailable during a rebuild, `scripts/create-backup-secret.sh` is the documented emergency fallback for `backup-target` (`docs/runbook-server-cluster.md` §11); ESO reconciles the Secret back to vault state once healthy.

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

Note: deleting the `ExternalSecret` CRD orphans Secrets it previously created (`eso-smoke-output` survives by design — clean up by hand).
