# PostgreSQL (pg-primary)

CNPG-managed PostgreSQL 18 for the knowledge base, with pgvector and `pg_textsearch` (BM25; homelab-built image from `images/pg-textsearch`). One instance with a local-path PVC on the server node: recovery means reapply and reschedule. This is not HA.

## Prerequisites

- CNPG operator ([deploy/cnpg](../cnpg/README.md)) and Kubernetes ImageVolume support (k8s 1.35+, containerd 2.1+).
- 1Password item `knowledge-db` (vault `homelab`) with `username` (`knowledge_owner`) and a generated `password`. The ExternalSecret in `base/owner-secrets.yaml` syncs it into the owner-role Secret `pg-primary-knowledge-owner` (basic-auth); the operator generates everything else. `knowledge-db` is also what the knowledge services connect with, so the role and its clients share one source.

  To rotate, edit the password in 1Password. Within the hour ESO updates the Secret and the operator updates the role password. Restart the knowledge Deployments so they reconnect with the new value.

## Apply

Part of `clusters/home`. Standalone: `kubectl apply -k deploy/postgres/base`, then `kubectl -n database get cluster pg-primary -w` until it reports a healthy state.

## Verify

`scripts/pg-smoke.sh seed` checks the extensions, builds HNSW and BM25 indexes, and checks query results. `restart` deletes the primary pod gracefully. `verify` checks that data and indexes survived.

## Isolation

- Database `knowledge`, owned by the non-superuser login role `knowledge_owner`. A new app gets its own database and `<app>_owner` role, with no cross-grants. Superuser access is disabled; extensions are installed declaratively via the `Database` resources.
- The `database` namespace is default-deny. Allowed in: the CNPG operator (8000/9187) and the SQL clients named in `allow-sql-clients` (5432): cloudbeaver, knowledge-ingest and knowledge-retrieval in `agents`.
- Connect at `pg-primary-rw.database.svc:5432` over TLS. For `verify-full`, the CA is in Secret `pg-primary-ca`.

## Node drains

The operator's PodDisruptionBudget `pg-primary-primary` (minAvailable 1) blocks evicting the only instance, so a drain of the server node waits on it. Run `kubectl cnpg maintenance set pg-primary -n database --reusePVC` first, which lifts it, and `kubectl cnpg maintenance unset pg-primary -n database` after.

## Scaling

Extra instances add availability only on distinct hardware, and local-path data does not follow a reschedule. Backups are not wired up; WAL archiving would need an egress rule in `allow-instance-egress`.
