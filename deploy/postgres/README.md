# PostgreSQL — primary cluster (pg-primary)

CloudNativePG-managed PostgreSQL 18 cluster shared by the factory and knowledge applications: pgvector for semantic retrieval, `pg_textsearch` (homelab extension image from #48) for BM25 ranked search.

**Availability target: one instance on one physical machine.** Storage is a local-path PVC on the durable server node; recovery is "reapply + reschedule", not automatic failover. This is a fast-recovery design, not HA — only describe it as HA once `instances: 3` runs on distinct failure hardware (see [Scaling](#scaling)).

## Prerequisites

1. **CloudNativePG operator >= 1.29** (issue #49) installed in `cnpg-system` — extension catalogs and the `Cluster`/`Database` CRDs used here need 1.29+.
2. **Kubernetes 1.35+ with containerd 2.1+** on the nodes (Kubernetes ImageVolume support, per the CNPG image-volume-extensions docs).
3. **pg-textsearch image published** (issue #48) and its digest pinned in `base/cluster.yaml`. The manifest ships an all-zero placeholder digest that cannot pull; `scripts/pg-smoke.sh` flags it with a pointed error.

## Secrets

Credentials never enter Git. The operator generates the cluster's internal Secrets (`pg-primary-ca`, `pg-primary-replication`, TLS certs); the two application owner roles read from basic-auth Secrets created once, out of band:

```sh
kubectl -n database create secret generic pg-primary-factory-owner \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=factory_owner \
  --from-literal=password="$(openssl rand -base64 24)"
kubectl -n database create secret generic pg-primary-knowledge-owner \
  --type=kubernetes.io/basic-auth \
  --from-literal=username=knowledge_owner \
  --from-literal=password="$(openssl rand -base64 24)"
```

Losing a Secret means rotating it: recreate the Secret with a new password and the operator applies the new password to the role on its next reconciliation.

## Isolation scheme

- Two databases (`factory`, `knowledge`), each owned by a dedicated non-superuser login role (`factory_owner`, `knowledge_owner`), declared in `base/databases.yaml` + `managed.roles`. No cross-grants: an app can only touch its own database.
- Superuser access is disabled (`enableSuperuserAccess: false`) — no `pg-primary-superuser` Secret exists; the operator manages the postgres role internally. Extension DDL runs declaratively through the `Database` resources instead of requiring app-side superuser.
- The operator's default `app` database exists but is unused by applications.
- Network: the `database` namespace is default-deny both directions; only the CNPG operator (8000/9187) and SQL clients from `agents`/`sandbox` (5432) are allowed in. Sandbox egress is still governed by `deploy/policies/base` — factory pods need their own egress allowance when they adopt this cluster.

## Bring-up

```sh
kubectl apply -f deploy/namespaces.yaml      # database namespace (restricted PSA)
kubectl apply -k deploy/postgres/base
kubectl get cluster pg-primary -n database -w # wait for "Cluster in healthy state"
```

Then prove it (see below): `scripts/pg-smoke.sh seed`, `restart`, `verify`.

## Smoke tests

`scripts/pg-smoke.sh` connects to the `knowledge` database as `knowledge_owner` (proving the credential workflow) and:

- `seed` — asserts both extensions are installed, creates a table with test rows, builds an HNSW vector index and a BM25 index, then runs a vector similarity query and a BM25 ranked query, asserting the expected top hits.
- `restart` — checks the PDB reports an allowed disruption, deletes the primary pod, and waits for the replacement to pass readiness and for the cluster to report healthy (this is the graceful-shutdown test).
- `verify` — after the restart: both extensions still installed, `shared_preload_libraries` still carries `pg_textsearch`, test rows intact, both indexes present and still serving the ranked queries.

```sh
scripts/pg-smoke.sh seed
scripts/pg-smoke.sh restart
scripts/pg-smoke.sh verify
```

## Connecting an application

From the `agents` namespace:

```
host=pg-primary-rw.database.svc port=5432 dbname=<factory|knowledge> user=<app>_owner
```

The `-rw` service always points at the primary. Traffic is TLS (operator-issued certs) with SCRAM password auth from the basic-auth Secret above; for `sslmode=verify-full`, fetch the cluster CA from Secret `pg-primary-ca`.

## Scaling

- **Replicas:** set `instances: 3` — streaming replication allowances are already in the netpols. Before bumping, delete `pg-primary-pdb`: the operator creates its own PDB (keeping n-2 replicas available) once a cluster has three instances.
- **Failure domains:** a second instance only adds real availability on distinct hardware. local-path volumes pin data to one node; moving the dataset means a `pg_basebackup`-style reseed onto the new node (CNPG storage-resize/migration docs), not a reschedule.
- **Backups:** not wired yet — WAL archiving/barman needs an egress allowance in `allow-instance-egress` beside the DNS/API rules when it lands.
