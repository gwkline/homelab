# Barman Cloud CNPG-I plugin

`plugin-barman-cloud` v0.15.1 in `cnpg-system`, next to the CNPG operator. It runs the `barman-cloud` suite: the operator drives it over mTLS gRPC for base backups and restores, and an instance sidecar (injected into every pg-primary pod and recovery job) streams WAL and uploads backups to Backblaze B2 ([deploy/postgres/base/objectstore.yaml](../../postgres/base/objectstore.yaml)). `base/upstream.yaml` is the verbatim v0.15.1 release manifest minus the three cert-manager objects (this cluster has no cert-manager — see below); `kustomization.yaml` digest-pins both the plugin and sidecar images and sets resource bounds.

## Prerequisites

The plugin's Deployment mounts mTLS Secrets named by the Service annotations. Upstream generates them with cert-manager; here they are self-signed leaves (the same shape cert-manager's `selfSigned` issuer produces — each leaf is its own trust anchor, which is exactly how the operator consumes them):

```sh
./scripts/create-barman-tls.sh   # kubectl + openssl; idempotent; --force rotates
```

10-year validity; rotate with `--force` on suspicion or operator upgrades that change cert handling, not on a clock.

## Apply

Server-side (the ObjectStore CRD is part of the bundle). Must be serving before `deploy/postgres` (the operator injects the sidecar from the plugin's Service):

```sh
./scripts/create-barman-tls.sh
kubectl apply --server-side -k deploy/cnpg/barman
kubectl wait --for=condition=Established crd/objectstores.barmancloud.cnpg.io
kubectl -n cnpg-system rollout status deploy/barman-cloud
```

The operator discovers the plugin by watching the `barman-cloud` Service (label `cnpg.io/pluginName`); no operator restart is needed on first install. Check registration in the operator logs (`Registered plugin barman-cloud.cloudnative-pg.io`).

## Verify

```sh
kubectl -n cnpg-system get secret barman-cloud-server-tls barman-cloud-client-tls
kubectl -n cnpg-system get crd objectstores.barmancloud.cnpg.io
kubectl -n cnpg-system logs deploy/cnpg-controller-manager | grep -m1 'Registered plugin'
```

## Upgrade

1. Replace `base/upstream.yaml` with the new release's `manifest.yaml`, again removing the three cert-manager objects (`Certificate` ×2, `Issuer` ×1) at the tail.
2. Update the digests and tag in `kustomization.yaml` (same GHCR lookup as [deploy/cnpg](../cnpg/README.md)), and re-encode the sidecar image into the `SIDECAR_IMAGE` Secret patch:
   ```sh
   printf 'ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar@sha256:<new digest>' | base64 -w0
   ```
3. Apply and verify as above; any Cluster using the plugin reconciles against the new pods automatically.

## Uninstall

No Cluster may reference the plugin first (remove `spec.plugins` from the Cluster; the sidecars go with the next rollout):

```sh
kubectl delete -k deploy/cnpg/barman
```
