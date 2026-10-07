# PostgreSQL (pg-primary)

CNPG-managed PostgreSQL 18 shared by factory and knowledge, with pgvector and `pg_textsearch` (BM25; homelab-built image from `images/pg-textsearch`). One instance with a local-path PVC on the server node: recovery means reapply and reschedule. This is not HA.

## Prerequisites

- CNPG operator ([deploy/cnpg](../cnpg/README.md)) and Kubernetes ImageVolume support (k8s 1.35+, containerd 2.1+).
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

## Apply

Part of `clusters/home`. Standalone: `kubectl apply -k deploy/postgres/base`, then `kubectl -n database get cluster pg-primary -w` until it reports a healthy state.

## Verify

`scripts/pg-smoke.sh seed` checks the extensions, builds HNSW and BM25 indexes, and checks query results. `restart` deletes the primary pod gracefully. `verify` checks that data and indexes survived.

## Isolation

- Databases `factory` and `knowledge`, each owned by a non-superuser login role (`<app>_owner`) with no cross-grants. Superuser access is disabled; extensions are installed declaratively via the `Database` resources.
- The `database` namespace is default-deny. Allowed in: the CNPG operator (8000/9187) and the SQL clients named in `allow-sql-clients` (5432): cloudbeaver, knowledge-ingest and knowledge-retrieval in `agents`.
- Connect at `pg-primary-rw.database.svc:5432` over TLS. For `verify-full`, the CA is in Secret `pg-primary-ca`.

## Scaling

Delete `pg-primary-pdb` before setting `instances: 3` (the operator then manages its own PDB). Extra instances add availability only on distinct hardware, and local-path data does not follow a reschedule. Backups are not wired up; WAL archiving would need an egress rule in `allow-instance-egress`.
