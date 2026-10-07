# Runtime secrets inventory

Every runtime credential, where it comes from, and who consumes it. No secret values appear here; `scripts/verify.sh` scans the working tree for token shapes.

## Contract

- One 1Password vault, **`homelab`**. The ESO service account can read only that vault; its token is the one hand-entered bootstrap secret.
- `SecretStore` `onepassword` (1Password SDK provider, auth from Secret `onepassword-service-account` key `token`) exists in `agents`, `sandbox`, `work` (`deploy/github-tokens/base/secretstore.yaml`) and `tailscale` (`deploy/tailscale/secretstore.yaml`).
- 1Password item/field names equal the ExternalSecret `remoteRef.key`/`property` verbatim; Secret names are referenced literally by manifests — never rename one side alone.
- ExternalSecrets refresh hourly. File-mounted consumers pick up rotations automatically; env consumers need `kubectl rollout restart`.
- Any new secret reference gets a row here before its manifest lands. Never widen a token's scope as part of an unrelated change.

## Synced from 1Password (ExternalSecret)

| Secret (keys) | Namespace | 1Password item → fields | Consumers | Notes |
| --- | --- | --- | --- | --- |
| `github-token` (`token`) | agents, sandbox | `github-readonly` → `token` | hermes, t3code, panel and panel Jobs, factory CronJobs and worker Jobs, chaos, `scripts/new-job.sh`, `scripts/egress-smoke.sh` | Fine-grained PAT, Contents read-only on the repos in workload config. Transitional until the GitHub App covers the factory |
| `github-token-writer` (`token`) | sandbox | `github-writer` → `token` | panel-spawned Jobs | Optional (consumers mount `optional: true`). Contents + Pull requests write on target repos only |
| `work-github-token` (`token`, `repos`) | work | `work-github-writer` → `token`, `repos` | work-t3code | PAT limited to the selected work repos (read+write); `repos` = clone URLs, kept out of this public repo. Never synced elsewhere |
| `work-claude-oauth` (`token`) | work | `work-claude-oauth` → `token` | work-t3code (`CLAUDE_CODE_OAUTH_TOKEN`) | From `claude setup-token`; restart work-t3code after rotating |
| `work-depot-token` (`token`) | work | `work-depot-token` → `token` | work-t3code (`DEPOT_TOKEN`) | Optional |
| `knowledge-db` (`username`, `password`, `databaseUrl`) | agents | `knowledge-db` → `username`, `password` | knowledge-ingest, knowledge-retrieval | Password must equal Secret `database/pg-primary-knowledge-owner`; rotate both together |
| `knowledge-api-token` (`token`) | agents, sandbox | `knowledge-api-token` → `token` | knowledge services, panel (optional), factory orchestrator | Shared internal bearer (`openssl rand -base64 32`) |
| `panel-auth` (`users`, `tokens`) | agents | `panel-auth` → `users`, `tokens` | panel (optional; read-only without it) | `name=credential` pairs: Tailscale logins allowed to act through the UI, and one bearer token per machine caller (each Executor connection). The name is recorded as "requested by" |
| `operator-oauth` (`client_id`, `client_secret`) | tailscale | `tailscale-operator-oauth` → `client_id`, `client_secret` | tailscale-operator | OAuth client created with `tag:k8s-operator`; rotation in `deploy/tailscale/README.md` |

## Created by hand

| Secret (keys) | Namespace | How | Notes |
| --- | --- | --- | --- |
| `onepassword-service-account` (`token`) | agents, sandbox, work, tailscale | `scripts/create-onepassword-service-account.sh` (env, stdin, or hidden prompt) | The bootstrap secret. Rotation: `deploy/eso/README.md` |
| `pg-primary-factory-owner`, `pg-primary-knowledge-owner` (basic-auth) | database | loop in `deploy/postgres/README.md` | CNPG applies the role passwords; the knowledge one must match 1Password `knowledge-db` |
| `factory-opencode-auth` (`auth-b64`) | sandbox | `kubectl -n sandbox create secret generic factory-opencode-auth --from-file=auth-b64=<file holding base64 of opencode auth.json>` | **Gap:** no ExternalSecret yet. Model-provider keys (OpenRouter) for the orchestrator and worker Jobs |
| `github-app` (`app-id`, `installation-id`, `private-key`) | sandbox | `scripts/create-github-app-secret.sh sandbox` from 1Password item `factory-github-app` | Collector mints short-lived installation tokens; see [github-app.md](github-app.md) |
| `grafana-admin` (`admin-password`) | agents | `kubectl -n agents create secret generic grafana-admin --from-literal=admin-password=…` | Grafana admin login |
| `executor-admin` (`email`, `password`) | agents | `kubectl -n agents create secret generic executor-admin …` | Optional headless Executor admin |
| `executor-client` (`token`) | agents | issued by Executor; `deploy/hermes/README.md` | Optional; hermes and t3code reach Executor tools with it |
| `cloudbeaver-db` (`user`, `password`) | agents | `scripts/create-cloudbeaver-secret.sh` | Least-privilege role (`deploy/cloudbeaver/README.md`) |
| `ghcr-pull` (`.dockerconfigjson`) | per namespace | `kubectl create secret docker-registry` | Only if GHCR packages go private; no manifest references it today |

## Not Kubernetes Secrets

| Credential | Where | Notes |
| --- | --- | --- |
| k3s node token | `/var/lib/rancher/k3s/server/node-token` on the server | Needed to join agent nodes |
| t3code opencode `auth.json` | t3code PVC, entered in a session | User-held; never synced |
| CLI logins (Claude, Codex) | hermes and t3code PVC homes | Survive rollouts, lost with the PVC |

Out of scope: CI's per-run `GITHUB_TOKEN` and Kubernetes ServiceAccount tokens.

## Re-verify

```sh
grep -rnE "secretKeyRef|secretRef|secretName|imagePullSecrets" deploy/ apps/ scripts/
grep -rn "kind: ExternalSecret" deploy/
kubectl get externalsecret -A && kubectl get secretstore -A
```
