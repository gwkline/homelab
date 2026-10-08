# CloudBeaver

CloudBeaver (DBeaver's web client) is a tailnet-only, read-only GUI for PostgreSQL, at `https://cloudbeaver.<tailnet>`. It runs as a single replica and is part of the core set (`clusters/home`). All state (users, connections, encrypted credentials, saved scripts) lives on PVC `workspace-cloudbeaver-0`, which is not backed up. Anonymous access is off.

## Credentials

| What | 1Password item (vault `homelab`) | How it is used |
| --- | --- | --- |
| Admin login | `cloudbeaver-admin`, fields `username`, `password` | ExternalSecret → Secret `cloudbeaver-admin` → `CB_ADMIN_NAME`/`CB_ADMIN_PASSWORD`. Read only when the workspace is empty; the pod does not start until the Secret exists. |
| Read-only database role | `cloudbeaver-db`, fields `username` (`cloudbeaver_ro`), `password` | Not synced. Type it into the seeded connection once; CloudBeaver stores it encrypted. |

No credential appears in the StatefulSet or a ConfigMap.

## Prerequisites

1. Create both 1Password items.
2. Create the read-only role. `kubectl cnpg psql pg-primary -n database -- -d knowledge`:

   ```sql
   CREATE ROLE cloudbeaver_ro LOGIN PASSWORD '<cloudbeaver-db password>';
   GRANT CONNECT ON DATABASE knowledge TO cloudbeaver_ro;
   GRANT USAGE ON SCHEMA public TO cloudbeaver_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO cloudbeaver_ro;
   ALTER DEFAULT PRIVILEGES FOR ROLE knowledge_owner IN SCHEMA public GRANT SELECT ON TABLES TO cloudbeaver_ro;
   ```

## First start

On an empty workspace, CloudBeaver:

- configures itself as server `homelab` with the 1Password admin;
- copies `initial-datasources.yaml` in as connection "Postgres (knowledge)": `pg-primary-rw.database.svc:5432`, database `knowledge`, read-only.

Log in as the admin, open the connection, and enter the `cloudbeaver-db` credentials once.

## Verify

Run `SELECT 1;` on the connection. INSERT, UPDATE, and DDL must fail.

## Network

- Ingress: Tailscale proxies only, on 8978.
- Egress: DNS, plus TCP 5432 to the CNPG primary pod in `database`. Postgres's `allow-sql-clients` must admit the `app: cloudbeaver` pod.

## Notes

- Superuser work never goes through CloudBeaver. Use `kubectl cnpg psql`.
- **Recovery:** delete the PVC and the pod. You get the seeded admin and connection back, then re-enter the role credentials; saved scripts are lost.
- **Admin rotation:** update `cloudbeaver-admin` in 1Password, then set the same password in Administration → Users. The env var only seeds an empty workspace.
- **Role rotation:** update `cloudbeaver-db` in 1Password, run `ALTER ROLE cloudbeaver_ro PASSWORD ...`, then edit the connection's credentials.
