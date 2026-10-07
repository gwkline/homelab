# GitHub App for the software factory

Short-lived GitHub App installation tokens, scoped to selected repositories and operations, replace long-lived PATs in the factory path. The token service is `apps/factory/github-app/`. Today only the collector uses it (with a `github-token` PAT fallback); the orchestrator's publish step still uses the PAT.

## Creating the App (operator, once)

1. Create a **GitHub App** (not an OAuth App). Deactivate webhooks — there is no receiver.
2. Grant only the permissions below. Repository access: **only select repositories** — the factory allowlist (`gwkline/homelab`, `gwkline/launchpad`, `gwkline/plantry`, `gwkline/personal-site`, `gwkline/kline-services-bot`, `gwkline/discord-bot`, `gwkline/pr-czar`). Never "All repositories".
3. Download the private key straight into 1Password. Never paste it into an issue, PR, chat, or file in this repo.
4. Install the App on those repos; note the App ID and installation ID.

## 1Password item `factory-github-app`

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| `app-id`          | numeric App ID                                     |
| `installation-id` | from the install URL `/installations/<id>`         |
| `private-key`     | full `.pem` (PKCS#1/PKCS#8; `\n` escapes accepted) |
| `webhook-secret`  | optional, empty today                              |

Values reach the cluster only through `scripts/create-github-app-secret.sh`, which creates Secret `github-app` from env or prompts:

```sh
GITHUB_APP_ID=… GITHUB_APP_INSTALLATION_ID=… GITHUB_APP_PRIVATE_KEY="$(op read 'op://…/private-key')" \
  scripts/create-github-app-secret.sh sandbox
```

## Permissions

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | mandatory; repo lookups |
| Issues | Read and write | list issues; label swaps and run comments are the ledger ([ADR-003](adr/adr-003-factory-github-ledger.md)) |
| Contents | Read and write | clone, push factory branches |
| Pull requests | Read and write | draft PR create/update, dedupe lookups |

Nothing else: no Checks/Actions, Administration, Secrets, or org permissions. Anything beyond this table is a regression.

Each mint narrows to a subset (`POST /app/installations/{id}/access_tokens` with `permissions`):

| Consumer | Requested |
| --- | --- |
| collector | `metadata:read, issues:write, contents:read` (the write adds `factory/queued`) |
| orchestrator publish step (planned) | `contents:write, pull_requests:write, issues:write` |
| smoke test | `contents:write, issues:read, metadata:read` |

Workers never receive an App token (ADR-001 D6).

## Token service

- `token-service.ts`: RS256 App JWT (9-minute lifetime) and an installation-token cache keyed by permission set, refreshed 5 minutes before the 1-hour expiry; `clear()` after a revocation.
- `mint.ts`: CLI reading `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_FILE` (or `GITHUB_APP_PRIVATE_KEY`); writes the token to `--out FILE` (mode 0600) or, explicitly, `--stdout`.

Tokens live in memory only, never in manifests, logs, or on a PVC; error messages are fixed strings plus HTTP status, and tests assert that tokens and JWTs never appear in output.

## Tests

```sh
npm test -w apps/factory/github-app                                 # mocked exchange, throwaway RSA keys
REPO=gwkline/launchpad ISSUE=<n> sh apps/factory/github-app/smoke-test.sh   # real App: read issue, create/delete a branch
```

## Rotation and recovery

| Event | Action |
| --- | --- |
| Planned rotation | Generate a new key → update 1Password → re-run `create-github-app-secret.sh` → restart consumers → run `smoke-test.sh` → remove the old key |
| Suspected compromise | Remove the key in GitHub now (minted tokens die within 1 h; revoke the installation for an immediate kill), then rotate |
| Lost key | Generate a new key on the same App and rotate |
| Deleted App / wrong installation | Recreate and reinstall; update `app-id`/`installation-id` in 1Password and the Secret |

The `github-token` PAT stays as fallback until the App path is verified end to end.

## Remaining migration

1. Mint an App token for the orchestrator's publish step (`--permissions contents:write,pull_requests:write,issues:write --out …` in an init step, consumed via `GH_TOKEN_FILE`).
2. Retire the writer PAT; keep a read-only PAT for non-factory consumers.
