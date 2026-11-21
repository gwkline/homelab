# PostgreSQL (pg-primary)

CNPG-managed PostgreSQL 18 for the knowledge base, with pgvector and `pg_textsearch` (BM25; homelab-built image from `images/pg-textsearch`). One instance with a local-path PVC on the server node: recovery means reapply and reschedule. This is not HA.

## Prerequisites

- CNPG operator ([deploy/cnpg](../cnpg/README.md)) and Kubernetes ImageVolume support (k8s 1.35+, containerd 2.1+).
- 1Password item `knowledge-db` (vault `homelab`) with `username` (`knowledge_owner`) and a generated `password`. The ExternalSecret in `base/owner-secrets.yaml` syncs it into the owner-role Secret `pg-primary-knowledge-owner` (basic-auth); the operator generates everything else. `knowledge-db` is also what the knowledge services connect with, so the role and its clients share one source.

  To rotate, edit the password in 1Password. Within the hour ESO updates the Secret and the operator updates the role password. Restart the knowledge Deployments so they reconnect with the new value.

## Apply

Part of `clusters/home`. Standalone: `kubectl apply -k deploy/postgres/base`, then `kubectl -n database get cluster pg-primary -w` until it reports a healthy state.

## Upgrade the operand and extensions

The PostgreSQL catalog and `images/pg-textsearch/Dockerfile` use the same PG 18 operand. A catalog change is **not ready to apply** until the extension image built for that operand has been published by successful `main` CI and its immutable digest is recorded in `base/cluster.yaml`. PR builds validate the image but do not publish the signed main build; never guess its digest or reuse the old extension pin for a new operand.

After merging an operand/extension upgrade:

1. Wait for successful main CI publication of `ghcr.io/gwkline/homelab/pg-textsearch`.
2. Resolve that main build's immutable digest, update `spec.postgresql.extensions[name=pg-textsearch].image.reference` in `base/cluster.yaml` through a separately verified PR, and wait for its required CI. Keep the catalog unapplied until this pin is merged.
3. Take and verify a database backup before the single-instance restart: run `scripts/pg-backup-verify.sh` (below) and require its PASS. A dump is the data rollback plan for an operand or extension change the old image cannot safely re-read; do not treat re-pinning the old image as one.
4. Apply only fresh merged manifests in the maintenance window. Check PostgreSQL and extension versions, preload, BM25/vector query results and stored indexes. Extension binaries and SQL definitions can differ: review upstream upgrade scripts before any `ALTER EXTENSION UPDATE`; do not run it blindly.

There is one database instance, so operand changes interrupt the knowledge services. An extension major or PostgreSQL major needs a separate migration, not a tag edit.

## Verify

`scripts/pg-smoke.sh seed` checks the extensions, builds HNSW and BM25 indexes, and checks query results. `restart` deletes the primary pod gracefully. `verify` checks that data and indexes survived.

## Backups

`base/backup.yaml`: `CronJob/pg-backup` (02:30 UTC daily) dumps the `knowledge` database in custom format to the dedicated `pg-backup` PVC (5Gi budget, 14-day retention pruned in-job) and prints `backup ok <file> sha256:<digest> <size>` on success. Credentials are the owner-role Secret; TLS is `verify-full` against `pg-primary-ca`. The dump image is the operand pin from `cluster-image-catalog.yaml` — bump the two together.

Proof, not hope: `KUBECONFIG=~/kubeconfig-homelab ./scripts/pg-backup-verify.sh` runs one backup now, restores the newest dump into a scratch database, compares every table's row count (plus the smoke indexes, when seeded), then drops the scratch database. Run it after first deploy, after each operand bump, and whenever the backup path is touched. For deterministic row-count parity, quiet the ingest writer first — `kubectl -n agents scale deploy knowledge-ingest --replicas=0`, restore it after: a live ingest that lands rows between the dump and the count can produce a churn false-fail (seen live once; the paused run passed clean twice).

This is v1: same-disk copies only. Off-node/offsite base backups and WAL archiving (PITR) are open on #53; the remaining PVCs are open on #358. Until #53 lands, the dump protects against logical disasters (bad migration, dropped objects, operator error), not against the disk or the node.

## Isolation

- Database `knowledge`, owned by the non-superuser login role `knowledge_owner`. A new app gets its own database and `<app>_owner` role, with no cross-grants. Superuser access is disabled; extensions are installed declaratively via the `Database` resources.
- The `database` namespace is default-deny. Allowed in: the CNPG operator (8000/9187) and the SQL clients named in `allow-sql-clients` (5432): cloudbeaver, knowledge-ingest and knowledge-retrieval in `agents`.
- Connect at `pg-primary-rw.database.svc:5432` over TLS. For `verify-full`, the CA is in Secret `pg-primary-ca`.

## Node drains

The operator's PodDisruptionBudget `pg-primary-primary` (minAvailable 1) blocks evicting the only instance, so a drain of the server node waits on it. Run `kubectl cnpg maintenance set pg-primary -n database --reusePVC` first, which lifts it, and `kubectl cnpg maintenance unset pg-primary -n database` after.

## Scaling

Extra instances add availability only on distinct hardware, and local-path data does not follow a reschedule. Nightly dumps (`base/backup.yaml`) stay on the same disk; WAL archiving would need an egress rule in `allow-instance-egress`.
