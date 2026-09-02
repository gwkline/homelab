# cloudbeaver deployment

CloudBeaver (DBeaver's web client) as a tailnet-only GUI for the factory PostgreSQL cluster: inspect schemas, browse table data, run harmless reads. StatefulSet, one replica, 1Gi workspace PVC; exposed via the Tailscale operator at `https://cloudbeaver.<tailnet>` (port 80 -> container 8978). No superuser path runs through this UI - see "Administrative path".

## Security chain

```
password manager (1Password / macOS Keychain)
  └─> scripts/create-cloudbeaver-secret.sh  ->  Secret cloudbeaver-db (agents ns, keys user/password)
        └─> typed once into the UI connection (least-privilege role)
              └─> CloudBeaver encrypts it into the workspace, strips plaintext
admin password (first UI open, from the password manager)
  └─> CloudBeaver admin account (workspace, encrypted)
```

- Connection credentials never live in git, argv, or the image. They enter the cluster through the secret script and the UI once. This is the documented stand-in for External Secrets: when #41 (ESO + 1Password SDK provider) lands, replace `cloudbeaver-db` with an `ExternalSecret` pointing at the 1Password item - nothing else changes.
- `CLOUDBEAVER_APP_ANONYMOUS_ACCESS_ENABLED=false` (default upstream is true): every session must log in as a workspace user.
- Tailnet identity (Tailscale ACLs) is the network gate; the admin account is the application gate; the database role is the data gate.

## Least-privilege connection

The default connection (ConfigMap `cloudbeaver-initial-datasources`, seeded on first boot) points at the factory database with `read-only: true` and expects the dedicated role below - never the cluster owner/superuser. Run this once on the PostgreSQL cluster (adjust database/schema names to what #52 deploys):

```sql
CREATE ROLE cloudbeaver_ro LOGIN PASSWORD '<from Secret cloudbeaver-db>';
-- deliberately NOT superuser/createdb/createrole - defaults deny all of it
GRANT CONNECT ON DATABASE factory TO cloudbeaver_ro;
GRANT USAGE ON SCHEMA factory, knowledge TO cloudbeaver_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA factory, knowledge TO cloudbeaver_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA factory GRANT SELECT ON TABLES TO cloudbeaver_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge GRANT SELECT ON TABLES TO cloudbeaver_ro;
```

Verify in the UI (acceptance for #55): log in, open the Factory PostgreSQL connection, browse the `factory`/`knowledge` schemas, run `SELECT 1;`. INSERT/UPDATE/DDL must fail for this role.

## Administrative path

Deliberate, out-of-band, never through CloudBeaver: superuser work (migrations, role grants, dangerous fixes) happens via the PostgreSQL cluster itself:

```sh
kubectl exec -it <postgres-pod> -n <postgres-ns> -- psql   # or: kubectl cnpg psql <cluster>
```

CloudBeaver's own admin account is for workspace administration (users, connections), not for database superuser work; the default connection cannot escalate because the role cannot.

## Backup / recovery

Only state: PVC `workspace-cloudbeaver-0` (`/opt/cloudbeaver/workspace`) - server config, users, encrypted credentials, saved SQL scripts, and the embedded H2 metadata DB (`workspace/.data/cb.h2v2.dat`). Everything else converges from git (ConfigMaps re-seed only an empty workspace).

- Backup: nightly restic pattern (runbook section 11) - add a `/mnt/cloudbeaver` mount with claimName `workspace-cloudbeaver-0` to `deploy/backup/base/cronjob.yaml` when backups are enabled.
- Recovery: restore the snapshot into a fresh PVC (runbook section 11 restore command) and re-apply this directory. No workspace = re-seeded defaults: create the admin again (password manager) and re-enter the connection credentials from Secret `cloudbeaver-db`; saved SQL scripts are lost.
- Rotation: update the password in the password manager, re-run `scripts/create-cloudbeaver-secret.sh`, update the role in PostgreSQL (`ALTER ROLE ... PASSWORD`), then update the connection in the UI (admin -> connections). Admin password: use CloudBeaver's user management.

## Upgrades

Bump the digest pin in `statefulset.yaml` (tag + digest together), back up the workspace first; upstream does not support downgrades. The panel dev-tools catalog (CloudBeaver card) goes healthy automatically once the pod is ready.
