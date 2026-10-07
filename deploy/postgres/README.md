# PostgreSQL (pg-primary)

CNPG-managed PostgreSQL 18 shared by factory and knowledge, with pgvector and `pg_textsearch` (BM25; homelab-built image from `images/pg-textsearch`). One instance on the server node with a local-path PVC: fast recovery, not HA. Durability comes from continuous WAL archiving and daily base backups to Backblaze B2 via the [Barman Cloud CNPG-I plugin](https://cloudnative-pg.io/plugin-barman-cloud/) (`deploy/cnpg/barman`); see [Restore and PITR](#restore-and-pitr).

## Prerequisites

- CNPG operator ([deploy/cnpg](../cnpg/README.md)) and the Barman Cloud plugin with its mTLS Secrets ([deploy/cnpg/barman](../cnpg/barman/README.md)); Kubernetes ImageVolume support (k8s 1.35+, containerd 2.1+).
- ESO with the `onepassword` SecretStore in `database` (this base) and Secret `onepassword-service-account` (`scripts/create-onepassword-service-account.sh` provisions it in every default namespace, `database` included).
- Owner-role Secrets, created once out of band (the operator generates the rest):

  ```sh
  for app in factory knowledge; do
    kubectl -n database create secret generic pg-primary-$app-owner \
      --type=kubernetes.io/basic-auth \
      --from-literal=username=${app}_owner \
      --from-literal=password="$(openssl rand -base64 24)"
  done
  ```

  To rotate, recreate the Secret; the operator updates the role password on its next reconcile.

## Backblaze B2 bucket

One-time, in the B2 web console or CLI; the bucket and key are referenced by the ObjectStore:

1. Create a private bucket (e.g. `gwkline-homelab-pg`) and note its S3 endpoint region (bucket details → e.g. `s3.us-west-004.backblazeb2.com`). Set `endpointURL` and `destinationPath` in [objectstore.yaml](base/objectstore.yaml) to match.
2. Enable default server-side encryption (SSE-B2) on the bucket. The ObjectStore also forces `encryption: AES256` per object, which B2 maps to SSE-B2.
3. Create a bucket-scoped application key with file-name prefix `pg-primary/` and capabilities `listBuckets`, `listAllBucketNames`, `readFiles`, `writeFiles`, `deleteFiles` (`deleteFiles` is what the retention policy needs for DeleteObjects; the prefix keeps the key inside the pg-primary data).
4. Store the key in 1Password item `pg-primary-b2` (vault `homelab`), fields `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY` — the ExternalSecret in this base syncs it into Secret `pg-primary-b2` in `database`.

Lifecycle rules on the bucket are deliberately left off: the ObjectStore's `retentionPolicy: 30d` is the source of truth, and a bucket lifecycle rule racing barman's deletes can break the recovery window (see [Testing retention and delete compatibility](#testing-retention-and-delete-compatibility)). Object Lock/versioning is optional hardening; enabling it changes how the 30d retention deletes behave, so test with it on if you turn it on.

## Apply

Part of `clusters/home`. Order matters the first time: the plugin must be serving before the Cluster is created (the operator injects the sidecar), and the `pg-primary-b2` Secret must be synced before WAL archiving can start.

```sh
kubectl apply --server-side -k deploy/cnpg/base          # operator (once)
./scripts/create-barman-tls.sh                           # mTLS Secrets (once)
kubectl apply --server-side -k deploy/cnpg/barman        # plugin (once)
kubectl apply -k deploy/postgres/base                    # ObjectStore + Cluster
kubectl -n database get cluster pg-primary -w            # until healthy
```

Wiring backups into an existing pg-primary triggers one instance rollout (the plugin sidecar joins the pod); expected in the fast-recovery posture.

## Verify

WAL archiving must be green before the first base backup — a backup without a healthy WAL stream has a broken recovery window:

```sh
kubectl cnpg status pg-primary -n database --verbose
# "Continuous Backup status: OK" and a recent "last archived WAL" …
kubectl -n database get objectstore b2-store
kubectl -n database logs pg-primary-1 -c plugin-barman-cloud --tail=20   # no archiving errors
```

First base backup (on demand; the daily ScheduledBackup `pg-primary-daily` takes over from here):

```sh
kubectl cnpg backup -n database pg-primary --method=plugin --plugin-name=barman-cloud.cloudnative-pg.io
kubectl -n database get backup -w          # phase: completed
```

The plugin exposes `barman_cloud_cloudnative_pg_io_*` metrics (last backup, first recoverability point) through the instance's 9187 exporter, which VictoriaMetrics already scrapes.

## Restore and PITR

Two throwaway recovery Clusters live in `examples/` — `pg-recovery.yaml` (`pg-restore`: latest backup plus all archived WAL) and `pg-pitr.yaml` (`pg-pitr`: replay stopped just before a chosen instant). Apply one, verify, delete it. Never run both at once (two restores compete for the node and the B2 read bandwidth).

```sh
kubectl apply -f examples/pg-recovery.yaml
kubectl -n database get cluster pg-restore -w     # phase: Cluster in healthy state
# Role passwords come back with the backup, so pg-primary's owner Secret still
# authenticates against the restored cluster:
kubectl -n database exec pg-restore-1 -- env \
  PGPASSWORD="$(kubectl -n database get secret pg-primary-knowledge-owner -o jsonpath='{.data.password}' | base64 -d)" \
  psql -X -h 127.0.0.1 -U knowledge_owner -d knowledge -c 'select count(*) from smoke.docs;'
kubectl -n database delete cluster pg-restore
```

For PITR: before the destructive change, capture the target time and force one WAL archive so the instant is safely on B2:

```sh
date -u +"%Y-%m-%d %H:%M:%S+00"           # targetTime, captured BEFORE the damage
kubectl -n database exec -it pg-primary-1 -c postgres \
  -- psql -U postgres -c "select pg_switch_wal();"
# … destructive transaction happens now …
sed -i 's|targetTime: .*|targetTime: "<the captured time>"|' examples/pg-pitr.yaml
kubectl apply -f examples/pg-pitr.yaml
kubectl -n database get cluster pg-pitr -w
# the destructive change is absent; the data just before it is present
```

The restored cluster replays WAL from the base backup through `targetTime`; `pg-restore` instead replays to the end of the archive. After verifying, delete the recovery Cluster — it is a second Postgres on the same node and its PVC is scratch.

## RPO

- WAL ships at least every `archive_timeout: 60s` (set in [cluster.yaml](base/cluster.yaml); CNPG default 5min) or when a 16 MiB segment fills, whichever comes first: RPO ≈ 1 minute.
- Base backups are daily (02:17) with a 30-day recovery window (`retentionPolicy: 30d`).
- The practical floor is `barman_cloud_cloudnative_pg_io_first_recoverability_point` on the instance metrics endpoint; alert if it is more than ~10 minutes old.

## Testing retention and delete compatibility

Backblaze has had S3 checksum and HeadBucket/DeleteObjects gaps with some boto/barman versions; the ObjectStore pins `AWS_REQUEST_CHECKSUM_CALCULATION`/`AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` (plugin-barman-cloud#393). Prove the whole path before trusting it:

```sh
# List backups (read path, HeadBucket/ListObjects)
kubectl -n database exec pg-primary-1 -c plugin-barman-cloud -- \
  barman-cloud-backup-list s3://gwkline-homelab-pg/ pg-primary

# Retention plan without deleting anything (obsolete backups are named, not removed)
kubectl -n database exec pg-primary-1 -c plugin-barman-cloud -- \
  barman-cloud-backup-delete --dry-run s3://gwkline-homelab-pg/ pg-primary

# Real delete: after at least two completed base backups, obsolete ones are
# removed by the retention job — check the sidecar log for the delete batch
kubectl -n database logs pg-primary-1 -c plugin-barman-cloud | grep -i delete
```

If the dry run lists backups and the real run completes without boto errors, checksum headers and DeleteObjects work against the pinned plugin. Keep at least two completed backups at all times so the delete path is always exercised against a live obsolete backup, never against the only copy.

## Isolation

- Databases `factory` and `knowledge`, each owned by a non-superuser login role (`<app>_owner`) with no cross-grants. Superuser access is disabled; extensions are installed declaratively via the `Database` resources.
- The `database` namespace is default-deny. Allowed in: the CNPG operator (8000/9187) and SQL clients from `agents`/`sandbox` (5432). Allowed out: DNS, the Kubernetes API, peers on 5432, and HTTPS to the public internet (the B2 endpoint publishes no IP ranges; scoped to the plugin sidecar and recovery jobs in `allow-instance-egress`).
- Connect at `pg-primary-rw.database.svc:5432` over TLS. For `verify-full`, the CA is in Secret `pg-primary-ca`.
- B2 credentials live in Secret `pg-primary-b2` (1Password item `pg-primary-b2`, [docs/secrets-inventory.md](../docs/secrets-inventory.md)) and are mounted only by the plugin sidecar and recovery jobs.

## Scaling

Delete `pg-primary-pdb` before setting `instances: 3` (the operator then manages its own PDB). Extra instances add availability only on distinct hardware, and local-path data does not follow a reschedule — that is what the B2 backups are for.

## Validation log

Live evidence for the acceptance criteria, recorded from a real run (never paste credential or bucket-internal values):

| Check | Evidence (date, command output excerpt) |
| --- | --- |
| WAL archiving green before first backup | pending first run |
| On-demand + scheduled backup completed | pending first run |
| Latest-backup restore into pg-restore | pending first run |
| PITR before a destructive transaction | pending first run |
| Retention dry-run + real delete on B2 | pending first run |
