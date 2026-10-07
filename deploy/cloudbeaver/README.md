# CloudBeaver

CloudBeaver (DBeaver's web client) as a tailnet-only read-only GUI for PostgreSQL, at `https://cloudbeaver.<tailnet>`. Single replica. All state (users, connections, encrypted credentials, saved scripts) lives on PVC `workspace-cloudbeaver-0`, which is not backed up. Anonymous access is off.

## Prerequisites

1. `scripts/create-cloudbeaver-secret.sh` creates Secret `cloudbeaver-db` (keys `user`/`password`) from your password manager.
2. A read-only role on the cluster (`kubectl cnpg psql pg-primary -n database`):

   ```sql
   CREATE ROLE cloudbeaver_ro LOGIN PASSWORD '<from Secret cloudbeaver-db>';
   GRANT CONNECT ON DATABASE factory TO cloudbeaver_ro;
   GRANT USAGE ON SCHEMA public TO cloudbeaver_ro;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO cloudbeaver_ro;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO cloudbeaver_ro;
   ```

## Apply

```sh
kubectl apply -k deploy/cloudbeaver/base
```

On first open, create the admin account. Then type the role's credentials into the seeded connection once; CloudBeaver stores them encrypted.

## Verify

Log in, open the connection, and run `SELECT 1;`. INSERT, UPDATE, and DDL must fail.

## Notes

- Superuser work never goes through CloudBeaver. Use `kubectl cnpg psql`.
- Recovery: re-apply. An empty workspace is re-seeded, so you recreate the admin and re-enter the connection credentials; saved scripts are lost.
- Rotation: update the password manager entry, re-run the secret script, `ALTER ROLE ... PASSWORD`, then update the connection in the admin UI.
