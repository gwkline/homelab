# Runtime secrets inventory & 1Password item contract

Issue #39 (docs deliverable). Every Kubernetes Secret consumed by a workload in `deploy/`, its consumers, required keys, and the 1Password item it must come from once External Secrets Operator is wired (#38, #41). This inventory is the source of truth for the migration; add a row here **before** introducing a new secret reference in a manifest.

## Secrets in use

| Secret | Key(s) | Consumers (workload -> env/volume) | Scope & notes | 1Password item contract |
| --- | --- | --- | --- | --- |
| `github-token` | `token` | hermes (`GH_TOKEN`, `GITHUB_TOKEN`), t3code (`/secrets/token` file), loop-agent, panel, factory orchestrator / reviewer / security cronjobs (`GH_TOKEN`, `optional: false` on factory path) | Read-scoped PAT for gwkline/homelab. Factory cronjobs hard-require it; agent workloads mount it optional. | `Homelab / GitHub read token`: field `token`. Minimal scopes (repo read on homelab + whatever the factory read path needs). |
| `github-token-writer` | `token` | loop-agent (`/secrets-writer/token`), optional by design - absent by default | Write-scoped PAT, Contents+PR write on target repos only, enables loop->GitHub reporting. | `Homelab / GitHub writer token`: field `token`. Create only when loop reporting is enabled; keep expiry short. |
| `factory-opencode-auth` | `auth-b64` | factory orchestrator cronjob (`OPENCODE_AUTH_B64`, required) | base64 of opencode `auth.json` carrying provider keys (openrouter + zen) used by worker briefs. See `docs/factory-handoff-2026-08-27.md`. | `Homelab / OpenCode auth`: field `auth-b64` (store the exact b64 payload to avoid drift). |
| `backup-target` | _(envFrom - whole secret as env)_ | backup cronjob | Restic/Backblaze B2 target credentials (B2 key ID + key, restic repo password). Referenced via `secretRef`, so key names are fixed by the backup script. | `Homelab / Backup target (B2 + restic)`: one field per env var the script reads (`B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`, `RESTIC_PASSWORD`, `RESTIC_REPOSITORY` - verify names against the script before populating). |

## Not yet secret-managed (deliberate)

- Nothing else: every other `valueFrom` in `deploy/` is a `configMapKeyRef` (e.g. `hermes-workspaces`, `t3code-workspaces`, `loop-tasks`, `homepage-env`)
  - non-sensitive configuration, out of scope for ESO.

## Migration contract (issues #38/#41-#46)

- One `ExternalSecret` per row above, `refreshInterval: 1h`, SDK provider pointed at the 1Password vault item named in the contract column.
- Target Secret names must stay **exactly** as listed - manifests reference them literally and the factory cronjobs run with `optional: false`.
- Do not widen token scopes during migration; a scope change is a separate reviewed change.

## Verification

`grep -rn "secretKeyRef\|secretRef\|secretName" deploy/` should resolve every hit to a row in this table. If not, update this doc in the same PR that adds the reference.
