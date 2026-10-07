# CloudNativePG operator

CNPG 1.30.0 in `cnpg-system`; it manages the `pg-primary` cluster in `deploy/postgres` (whose `pg-textsearch` ImageVolume extension needs CNPG 1.29+). The Barman Cloud CNPG-I plugin that provides its backups lives beside it in [barman/](barman/README.md). `base/upstream.yaml` is the verbatim release bundle; `base/kustomization.yaml` carries the only local changes.

## Apply

Server-side is required (the Cluster CRD alone is >1MB). Apply before `clusters/home`; re-running is the recovery path.

```sh
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager
```

The admission webhooks are `failurePolicy: Fail`: `Cluster`/`Database` creates fail until the controller is Ready.

## Notes

- `cnpg-system` has no NetworkPolicy on purpose. The API server must always reach the webhooks; a default-deny here blocks every Cluster create/update. Isolation lives in `deploy/postgres/base/netpol.yaml`.
- Metrics: the manager serves Prometheus text on port 8080 and carries `prometheus.io/scrape` annotations, which VictoriaMetrics discovers. Per-Cluster `PodMonitor` stays off (no Prometheus-operator CRDs here).

## Upgrade

1. Replace `base/upstream.yaml` with the new release's `cnpg-<version>.yaml`. CRDs and controller update in the same apply.
2. Resolve the multi-arch digest and update `digest:` and `OPERATOR_IMAGE_NAME` in `base/kustomization.yaml`:
   ```sh
   TOKEN=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:cloudnative-pg/cloudnative-pg:pull" | jq -r .token)
   curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     https://ghcr.io/v2/cloudnative-pg/cloudnative-pg/manifests/<version> | grep -i docker-content-digest
   ```
3. Apply and verify as above. A rollback downgrades the CRDs too, so prefer fixing forward.

## Uninstall

Delete `Cluster` objects first: their finalizers clean up PVCs and pods, and deleting the CRD orphans them.

```sh
kubectl delete cluster,database -A --all   # deletes all PostgreSQL data
kubectl delete -k deploy/cnpg/base
```
