# GitHub tokens via External Secrets (1Password)

Declarative replacement for the manually created `github-token` / `github-token-writer` Secrets ([issue #45](https://github.com/gwkline/homelab/issues/45)). `scripts/create-github-secret.sh` is **deprecated** — do not use it to create these Secrets; ESO owns them (`creationPolicy: Owner` reverts manual edits on the next refresh).

```sh
kubectl apply -k deploy/github-tokens/base
```

## Prerequisites

1. External Secrets Operator installed with the `onepasswordSDK` provider, pinned version (issue #38/#41).
2. The 1Password **service-account token** — the only manually bootstrapped secret for this provider — in Secret `onepassword-service-account` (key `token`), restricted to the dedicated `homelab` vault. Bootstrap it with `scripts/create-onepassword-secret.sh` (idempotent; token via `OP_SERVICE_ACCOUNT_TOKEN` or a hidden stdin prompt, never logged); never log or commit it.

## 1Password item contract

| Item | Field | → Secret | Namespaces | Permissions |
| --- | --- | --- | --- | --- |
| `github-readonly` | `token` | `github-token` | agents, sandbox | fine-grained PAT, Contents: read-only on every private repo agents read |
| `github-writer` | `token` | `github-token-writer` | sandbox | fine-grained PAT, Contents + Pull requests: write on target repos **only** |

Read and writer credentials are separate 1Password items with separate permissions; the read token never gets write scopes and the writer never grants access to the read token's repos. The writer item is **optional**: if it is absent, the `github-token-writer` ExternalSecret reports `Ready=False` and keeps retrying — the expected state. Every consumer mounts it with `optional: true`, so read-only jobs are unaffected.

The `token` field must contain the raw PAT (a trailing newline would break git auth — the ExternalSecret template trims it defensively).

## Rotation

Update the item's `token` field in 1Password. Propagation:

| Stage | Interval |
| --- | --- |
| ESO re-reads the item | ≤ `refreshInterval` = **1h** |
| 1Password SDK cache | ≤ 5m |
| kubelet updates mounted Secret volumes (`/secrets/token`) | ≤ ~1m after ESO writes |

Total worst case ≈ **1h 6m** from the 1Password change to updated Secret data.

### Workload pickup

- **File-mount readers** (`/secrets/token`, `GITHUB_TOKEN_FILE`): pick up the new value automatically (~1m kubelet sync) on the next read.
- **Env-var readers** (`GH_TOKEN`/`GITHUB_TOKEN` via `secretKeyRef`, e.g. hermes, t3code, panel, factory CronJobs): env never updates in a running pod. CronJobs get fresh pods (and the fresh token) on their next run automatically; long-running workloads need a restart:

```sh
kubectl -n agents rollout restart statefulset hermes t3code
kubectl -n agents rollout restart deploy panel
```

## Verification

```sh
# 1. Stores and ExternalSecrets Ready
kubectl get secretstore -A
kubectl get externalsecret -A   # github-token (agents, sandbox) and github-token-writer (sandbox)

# 2. Read-only gh call as a workload
kubectl -n agents exec hermes-0 -- gh api user -q .login

# 3. Private repository clone from a sandbox workload
kubectl -n sandbox exec -it deploy/... -- git clone https://github.com/gwkline/launchpad /tmp/launchpad
```

## Provider smoke (issue #41)

`onepassword-smoke.yaml` is the harmless end-to-end proof of the 1Password SDK connection: item `eso-smoke` (field `password`, any non-sensitive value) in the `homelab` vault syncs into Secret `onepassword-smoke-output` in `agents`, touching no real credential. Until the item exists the ExternalSecret reports `Ready=False` and retries — expected, same as `github-token-writer`.

```sh
# 1. store health and sync status
kubectl -n agents get secretstore onepassword           # Ready=True
kubectl -n agents get externalsecret onepassword-smoke  # Ready=True

# 2. the synced (non-sensitive) value
kubectl -n agents get secret onepassword-smoke-output -o jsonpath='{.data.password}' | base64 -d; echo

# 3. delete-and-restore: ESO recreates the Secret from the vault
kubectl -n agents delete secret onepassword-smoke-output
kubectl -n agents annotate externalsecret onepassword-smoke \
  external-secrets.io/force-sync="$(date +%s)" --overwrite
kubectl -n agents get externalsecret onepassword-smoke -w
```

Without the `force-sync` annotation the restore happens at the next refresh (≤ `refreshInterval` = 1h). Rotating the service-account token itself: re-run `scripts/create-onepassword-secret.sh` — see `deploy/eso/base/README.md`.

## Security notes

- Only item/field **names** live in git — no token value is ever committed or printed. CI's secret-pattern scan (scripts/verify.sh) guards this.
- The service-account token is limited to the `homelab` vault and is the only secret entered by hand.
- Deleting the generated Secret is safe: ESO recreates it from 1Password on the next reconcile.
