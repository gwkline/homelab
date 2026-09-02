# Runtime secrets inventory & 1Password item contract

Authoritative map from every runtime credential to its least-privilege 1Password
vault item and field. Migration tickets proceed independently using the
names/scopes below — never invent new item or field names. **No secret values
appear in this document, ever** (CI's `scripts/verify.sh` scan enforces the
same rule for git).

Established: 2026-09-02 (issue #39). Cross-checked against every
`secretKeyRef`, `envFrom.secretRef`, secret volume, `imagePullSecrets`, and
`kubectl create secret` invocation in manifests, scripts, image entrypoints,
and docs at that date.

## Vault and service-account contract

- One dedicated 1Password vault: **`homelab`**. No other vault is in scope for
  this cluster.
- The ESO service account is limited to that vault only. Its token is the only
  hand-entered secret (see [bootstrap-only](#bootstrap-only-secrets)).
- Namespace-scoped `SecretStore` `onepassword` (provider `onepasswordSDK`,
  vault `homelab`, auth from Secret `onepassword-service-account` key `token`)
  exists in `agents` and `sandbox`
  (`deploy/github-tokens/base/secretstore.yaml`). **Gap:** `backup` needs the
  same store but none is committed (`deploy/backup/base/externalsecret.yaml`
  documents it as a prerequisite).
- Naming convention: 1Password item/field names equal the ExternalSecret
  `remoteRef.key` / `remoteRef.property` values verbatim, and field labels
  equal the `secretKey` (which equals the consuming env var where `envFrom`
  is used). One name per value everywhere.

## Sharing classes

- **Shared** — one credential consumed by many workloads; one vault item per
  scope, synced into each namespace that needs it.
- **Per-workload** — a credential only one workload (or one workload family)
  consumes; scoped to a single namespace.
- **Bootstrap-only** — entered once during cluster bring-up, outside ESO (or
  not a Kubernetes Secret at all); rotation is manual.

---

## A. Shared credentials

### A1. `github-token` — GitHub read (TRANSITIONAL)

| Attribute | Value |
| --- | --- |
| Namespace | `agents`, `sandbox` (one Secret per namespace, same item) |
| Secret name / key | `github-token` / `token` |
| 1Password ref | item `github-readonly`, field `token` |
| Delivery | ExternalSecret `deploy/github-tokens/base/github-token.yaml`, `refreshInterval: 1h`, `creationPolicy: Owner`; template trims whitespace |
| Required permissions | Fine-grained PAT, **Contents: read-only** on every private repo listed in the workload ConfigMaps (homelab, launchpad, …) |
| Consumers | hermes StatefulSet (`agents`, env + `/secrets/token` file), t3code StatefulSet (`agents`, optional file), panel Deployment (`agents`, file; `apps/panel/server/index.ts`), factory orchestrator/security/collector/reviewer/reconciler CronJobs (`sandbox`, env), worker Jobs spawned by the orchestrator (`apps/factory/orchestrator/run.sh` → `apps/factory/worker/entrypoint.sh`), loop-agent CronJob (`sandbox`, optional file → `apps/shared/workspace-lib.sh`), dispatch-watcher CronJob (`sandbox`), chaos-monkey CronJob (`sandbox`, optional file), panel-spawned Jobs (`apps/panel/server/jobs.ts`), helper scripts `scripts/new-job.sh`, `scripts/egress-smoke.sh` |
| Rotation owner | Operator updates the `token` field in 1Password; ESO converges ≤1h. Env-reader workloads need a rollout restart (file readers pick it up automatically). See `deploy/github-tokens/base/README.md` |
| Status | **Transitional** — long-lived fine-grained PAT; superseded by a GitHub App installation token (issue #70) |

### A2. `github-token-writer` — GitHub write (TRANSITIONAL, optional)

| Attribute | Value |
| --- | --- |
| Namespace | `sandbox` only |
| Secret name / key | `github-token-writer` / `token` |
| 1Password ref | item `github-writer`, field `token` |
| Delivery | ExternalSecret `deploy/github-tokens/base/github-token-writer.yaml`, `refreshInterval: 1h`, `creationPolicy: Owner`. **Optional by design:** absent item ⇒ ExternalSecret stays `Ready=False`; every consumer mounts it `optional: true` |
| Required permissions | Fine-grained PAT, **Contents + Pull requests: write** on the target repos only — never a superset of the read token's access |
| Consumers | loop-agent CronJob (`GITHUB_WRITER_TOKEN_FILE` → `apps/shared/workspace-lib.sh` `setup_gh_cli`), panel-spawned Jobs (`apps/panel/server/jobs.ts`), `examples/dispatch-watcher.mjs`, factory publisher contract (`apps/factory/publisher/run-publisher.sh` reads `GH_TOKEN`/`GH_TOKEN_FILE`) |
| Rotation owner | Operator updates the `token` field in 1Password (same propagation as A1) |
| Status | **Transitional** — long-lived fine-grained PAT; superseded by a GitHub App installation token with write scopes (issue #70) |

### A3. `ghcr-pull` — image pull (optional, manual)

| Attribute | Value |
| --- | --- |
| Namespace | per-namespace as needed (`agents` documented; repeat for `sandbox` if private images run there) |
| Secret name / key | `ghcr-pull` / `.dockerconfigjson` (docker-registry type) |
| 1Password ref | **Proposed** item `ghcr-pull`, field `dockerconfigjson` (sync via ESO once a SecretStore covers the namespace; today created manually) |
| Delivery | Documented imperative creation only — `README.md` "GHCR images" (`kubectl create secret docker-registry`). No manifest references `imagePullSecrets` yet |
| Required permissions | GitHub PAT with `read:packages` for the GHCR namespace `ghcr.io/gwkline` |
| Consumers | Any pod needing private images once `imagePullSecrets` is added; none today |
| Rotation owner | Operator (rotate the PAT in 1Password, re-create the Secret) |
| Status | Optional; not transitional (easily replaced by the GitHub App's `read:packages` scope when #70 lands) |

## B. Per-workload credentials

### B1. `factory-opencode-auth` — model providers (factory)

| Attribute | Value |
| --- | --- |
| Namespace | `sandbox` |
| Secret name / key | `factory-opencode-auth` / `auth-b64` (base64 of opencode `auth.json`) |
| 1Password ref | **Proposed** item `factory-opencode-auth`, field `auth-b64` — create it to close the gap below |
| Delivery | **Gap: no creation path in git** — no ExternalSecret, no script, no documented command. Documented as pre-existing in `docs/factory-handoff-2026-08-27.md`; a cluster rebuild silently loses it. Migrate to ESO with a `sandbox` ExternalSecret using `remoteRef: {key: factory-opencode-auth, property: auth-b64}` |
| Required permissions | Model-provider API keys inside opencode `auth.json`: OpenRouter (+ zen). Least privilege: OpenRouter key restricted to the models the factory uses |
| Consumers | factory-orchestrator CronJob (`deploy/factory/base/orchestrator-cronjob.yaml`, env `OPENCODE_AUTH_B64`), re-injected into worker Jobs (`apps/factory/orchestrator/run.sh`), decoded by `apps/factory/worker/entrypoint.sh` to `auth.json` / `OPENROUTER_API_KEY` |
| Rotation owner | Operator (update the vault item field; today: create a new Secret manually and restart the CronJob) |
| Status | Per-workload (factory family only) |

### B2. `backup-target` — Backblaze B2 + restic

| Attribute | Value |
| --- | --- |
| Namespace | `backup` |
| Secret name / keys | `backup-target` / `RESTIC_REPOSITORY`, `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`, `RESTIC_PASSWORD` |
| 1Password ref | item `restic-backup`, four fields named exactly like the secret keys |
| Delivery | ExternalSecret `deploy/backup/base/externalsecret.yaml`, `refreshInterval: 1h`, `creationPolicy: Owner`, `deletionPolicy: Retain`. Emergency fallback: `scripts/create-backup-secret.sh` (prompts, never echoes) |
| Required permissions | B2 application key pair scoped to the backup bucket (list/read/write/delete on that bucket only); `RESTIC_PASSWORD` is the repo encryption password |
| Consumers | restic-backup CronJob (`deploy/backup/base/cronjob.yaml`, `envFrom`), one-off scratch-restore Job (`docs/runbook-server-cluster.md` §11) |
| Rotation owner | Operator. **`RESTIC_PASSWORD` is special:** rotating it in the vault alone makes all existing snapshots unreadable — re-key the repo per runbook §11 before syncing |
| Status | Per-workload (backup stack only) |

### B3. t3code opencode credentials (interactive, PVC-persisted)

| Attribute | Value |
| --- | --- |
| Location | Not a Kubernetes Secret. File `/data/agent-state/opencode/share/auth.json` on the t3code PVC, entered by the user via an interactive t3/opencode session |
| 1Password ref | None proposed — user-held interactive credentials; do not sync to the cluster |
| Required permissions | Same model-provider scope policy as B1 (per-user choice) |
| Consumers | t3code StatefulSet sessions only (`apps/t3code/init-workspace.sh`) |
| Rotation owner | User, from within the session (delete/rewrite the file) |
| Status | Per-workload (t3code only) |

## C. Bootstrap-only secrets

Entered once at cluster bring-up; **never** synced by ESO (the ESO auth secret
would be circular) and not part of steady-state GitOps.

| # | Credential | Location / Secret | Key(s) | 1Password ref | Notes |
| --- | --- | --- | --- | --- | --- |
| C1 | 1Password service-account token | Secret `onepassword-service-account` in `agents` **and** `sandbox` (created by hand per `docs/rebuild-runbook.md`) | `token` | The token itself lives only in 1Password's non-homelab storage / operator device; it authorizes the dedicated `homelab` vault **only** — least privilege by construction | The only hand-entered secret in the stack. Consumers: the `SecretStore` `onepassword` in each namespace. Rotation owner: operator (create a new SA, update both Secrets, ESO re-authenticates on next refresh) |
| C2 | Tailscale OAuth client | Helm values at install: `helm upgrade --install tailscale-operator … --set oauth.clientId/--set oauth.clientSecret` (`docs/runbook-server-cluster.md` §5, `docs/rebuild-runbook.md`) — lands in the operator's Secret in ns `tailscale`, never in git | `client-id`, `client-secret` | 1Password item `homelab-tailscale` (operator device Keychain): fields `client-id`, `client-secret` | OAuth client must carry `tag:k8s-operator`. Rotation owner: operator (re-run helm with new values, restart operator). See `deploy/tailscale/README.md` |
| C3 | K3s node join token | Read from `/var/lib/rancher/k3s/server/node-token` on the server node (`bootstrap/bootstrap.sh`); never stored in git or the cluster API | n/a | None proposed — node-local, single-node cluster | Rotation owner: operator (regenerate on the node). Not a Kubernetes Secret |
| C4 | `ghcr-pull` (when used) | `kubectl create secret docker-registry` per namespace — manual, documented in `README.md` | `.dockerconfigjson` | Proposed item `ghcr-pull` (A3) | Bootstrap-time because no ESO path exists yet |

## D. Planned workloads — no credentials exist yet

| Workload | Status | Expected contract |
| --- | --- | --- |
| **Executor** (ns `agents`) | Referenced by the panel devtools catalog (`apps/panel/server/devtools.ts`, `dependsOn: deploy/executor/base`) but `deploy/executor/base` is not in git yet | Agentic task executor, "generic runs stay upstream" — expected to consume the **shared** `github-token` (A1) via the existing `agents` SecretStore; no dedicated item until a concrete permission need appears. Update this section when the deployment lands |
| **CNPG databases** (factory Postgres per ADR-001, knowledge cluster per ADR-002) | ADR-only; nothing deployed | CNPG self-generates its bootstrap/superuser Secrets inside its own namespace — no 1Password item required ("CNPG/bootstrap secrets self-generate", `docs/rebuild-runbook.md`). Add an item (proposed naming: `cnpg-<cluster>-<role>`) only if an app needs a **fixed** password that must survive cluster rebuilds. Rotation owner: operator |
| **Factory Postgres (ADR-001)** | Design-phase decision, may be dropped for the GitHub-ledger model | Same policy as CNPG above |

## E. Out of scope (non-runtime / Kubernetes-managed)

| Credential | Why out of scope |
| --- | --- |
| CI `secrets.GITHUB_TOKEN` (`.github/workflows/ci.yaml`, `cleanup-ghcr.yaml`) | Ephemeral, Actions-provided per workflow run; not cluster runtime |
| Automounted ServiceAccount tokens (hermes, panel, dispatcher, chaos-monkey, auto-deploy, factory-orchestrator/reconciler) | Issued and rotated by Kubernetes; RBAC-scoped identity, not a stored secret |
| `PANEL_K8S_TOKEN` (`apps/panel/server/k8s.ts`) | Dev/test override only; production uses the mounted SA token |
| Known credentials scrubbed at runtime (`apps/hermes/run-hermes.sh` dotfile scrub) | Hygiene measure, not a secret |

## Migration contract (issues #38/#41-#46, #123)

- One `ExternalSecret` per row above, `refreshInterval: 1h`, SDK provider
  pointed at the 1Password vault item named in the contract column.
- Target Secret names must stay **exactly** as listed — manifests reference
  them literally and the factory cronjobs run with `optional: false`.
- Do not widen token scopes during migration; a scope change is a separate
  reviewed change.

## Cross-check (verification)

Every runtime secret reference in the repo maps to an entry above:

- `secretKeyRef` / `envFrom.secretRef`: hermes (A1), t3code (A1, optional),
  panel (A1, optional file), factory orchestrator (A1 + B1), factory
  security/collector/reviewer/reconciler (A1), loop-agent (A1 + A2, optional),
  dispatch-watcher (A1 + A2 via examples/jobs.ts patterns), chaos-monkey (A1,
  optional), backup restic CronJob (B2), orchestrator-generated worker Jobs
  (A1, B1).
- Secret volumes: hermes, t3code, panel, loop-agent, dispatcher, chaos-monkey,
  panel Jobs — all `github-token`/`github-token-writer` (A1/A2).
- `kubectl create secret`: `onepassword-service-account` (C1),
  `backup-target` emergency script (B2), `ghcr-pull` (A3/C4).
- Non-Secret credential flows: Tailscale OAuth (C2), K3s token (C3), t3code
  `auth.json` (B3).

To re-verify after changes:

```sh
grep -rn "secretKeyRef\|secretRef\|imagePullSecrets\|secretName" deploy/ apps/ scripts/
grep -rn "kubectl create secret" scripts/ docs/ README.md bootstrap/
kubectl get externalsecret -A && kubectl get secretstore -A
```

Any new reference must either match an existing item/field pair above or add a
row here **before** the manifest lands.
