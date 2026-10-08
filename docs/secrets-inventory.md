# Runtime secrets inventory

Every runtime credential, where it comes from, and who consumes it. No secret values appear here; `scripts/verify.sh` scans the working tree with gitleaks (`.gitleaks.toml`).

## Contract

- One 1Password vault, **`homelab`**. The ESO service account can read only that vault; its token is the one hand-entered secret.
- One store: `ClusterSecretStore` `onepassword` (1Password SDK provider, `deploy/github-tokens/base/secretstore.yaml`). It authenticates with Secret `external-secrets/onepassword-service-account` (key `token`); no other namespace holds that token. Its `spec.conditions` admits ExternalSecrets only from `agents`, `database`, `sandbox`, `tailscale` and `work`.
- 1Password item/field names equal the ExternalSecret `remoteRef.key` verbatim; Secret names are referenced literally by manifests. Never rename one side alone.
- ExternalSecrets refresh hourly. File-mounted consumers pick up rotations automatically; env consumers need `kubectl rollout restart`.
- Secrets are created by ESO or by server-side apply, so none carries a `kubectl.kubernetes.io/last-applied-configuration` annotation (which would hold a copy of the data).
- Any new secret reference gets a row here before its manifest lands. Never widen a token's scope as part of an unrelated change.

## Synced from 1Password (ExternalSecret)

| Secret (keys) | Namespace | 1Password item → fields | Consumers | Notes |
| --- | --- | --- | --- | --- |
| `github-token` (`token`) | agents, sandbox | `github-readonly` → `token` | hermes, t3code, panel, knowledge-ingest, factory CronJobs and worker Jobs, `scripts/new-job.sh`, `scripts/egress-smoke.sh` | Fine-grained PAT, Contents read-only on the repos in workload config |
| `github-app` (`app-id`, `installation-id`, `private-key`) | sandbox | `factory-github-app` → `app-id`, `installation-id`, `private-key` | factory collector (optional mount; falls back to `github-token`) | Short-lived installation tokens ([github-app.md](github-app.md)). A one-line key with `\n` escapes is expanded |
| `factory-opencode-auth` (`auth-b64`) | sandbox | `openrouter` → `OPENROUTER_API_KEY` | factory orchestrator → worker Jobs (`OPENCODE_AUTH_B64`) | base64 of opencode `auth.json`, built by the ExternalSecret template |
| `hermes-openrouter` (`OPENROUTER_API_KEY`) | agents | `openrouter` → `OPENROUTER_API_KEY` | hermes | Same item as `factory-opencode-auth`: one edit rotates both |
| `work-github-token` (`token`, `repos`) | work | `work-github-writer` → `token`, `repos` | work-t3code | PAT limited to the selected work repos (read+write); `repos` = clone URLs, kept out of this public repo. Never synced elsewhere |
| `work-claude-oauth` (`token`) | work | `work-claude-oauth` → `token` | work-t3code (`CLAUDE_CODE_OAUTH_TOKEN`) | From `claude setup-token`; restart work-t3code after rotating |
| `work-depot-token` (`token`) | work | `work-depot-token` → `token` | work-t3code (`DEPOT_TOKEN`) | Optional |
| `knowledge-db` (`username`, `password`, `databaseUrl`) | agents | `knowledge-db` → `username`, `password` | knowledge-ingest, knowledge-retrieval | Same item as `pg-primary-knowledge-owner` |
| `pg-primary-knowledge-owner` (basic-auth) | database | `knowledge-db` → `username`, `password` | CNPG managed role `knowledge_owner` | CNPG applies a changed password to the role; restart the knowledge Deployments after rotating |
| `knowledge-api-token` (`token`) | agents, sandbox | `knowledge-api-token` → `token` | knowledge services, panel (optional), factory orchestrator | Admin bearer: every knowledge route, including ingest (`openssl rand -base64 32`) |
| `knowledge-search-token` (`token`) | agents | `knowledge-search-token` → `token` | knowledge-retrieval (optional) | Read-only bearer, `/v1/search` only; 403 on ingest routes (`openssl rand -base64 32`). Restart knowledge-retrieval after creating or rotating |
| `panel-auth` (`users`, `tokens`) | agents | `panel-auth` → `users`, `tokens` | panel (optional; read-only without it) | `name=credential` pairs: Tailscale logins allowed to act through the UI, and one bearer token per machine caller. The name is recorded as "requested by" |
| `cloudbeaver-admin` (`username`, `password`) | agents | `cloudbeaver-admin` → `username`, `password` | cloudbeaver (`CB_ADMIN_NAME`, `CB_ADMIN_PASSWORD`) | Seeds the admin of an empty workspace only; on rotation also change it in the admin UI |
| `grafana-admin` (`admin-password`) | agents | `grafana-admin` → `admin-password` | Grafana (`admin` login) | Applies at the next Grafana pod start (emptyDir database) |
| `grafana-ntfy` (`url`) | agents | `grafana-ntfy` → `url` | Grafana (`NTFY_URL`, the alert contact point) | `https://ntfy.sh/<topic>`; the topic name is the credential. Restart Grafana after rotating |
| `operator-oauth` (`client_id`, `client_secret`) | tailscale | `tailscale-operator-oauth` → `client_id`, `client_secret` | tailscale-operator | OAuth client created with `tag:k8s-operator`; rotation in `deploy/tailscale/README.md` |

## Created by hand

| Secret (keys) | Namespace | How | Notes |
| --- | --- | --- | --- |
| `onepassword-service-account` (`token`) | external-secrets | `scripts/create-onepassword-service-account.sh` (env, stdin, or hidden prompt; server-side apply) | The bootstrap secret. Rotation: `deploy/eso/README.md` |

## Referenced but not provided

Consumers read these optionally; nothing creates them, so the feature is off.

| Secret (keys) | Namespace | Consumer | To enable |
| --- | --- | --- | --- |
| `hermes-telegram` (`TELEGRAM_BOT_TOKEN`), `hermes-discord` (`DISCORD_BOT_TOKEN`) | agents | hermes chat gateways | 1Password item `telegram-bot` / `discord-bot`, then an ExternalSecret in `deploy/hermes/base/credentials.yaml` |
| `executor-admin` (`email`, `password`), `executor-client` (`token`) | agents | `deploy/executor` (not in the core set), hermes, t3code | Executor is not deployed |
| `ghcr-pull` (`.dockerconfigjson`) | per namespace | none today | Only if GHCR packages go private |

## Generated in-cluster

Not credentials anyone holds; each controller recreates its own on a rebuild.

| Secret | Namespace | Owner |
| --- | --- | --- |
| `pg-primary-app`, `pg-primary-ca` | database | CNPG |
| `cnpg-ca-secret` | cnpg-system | CNPG operator |
| `external-secrets-webhook` | external-secrets | ESO cert-controller |
| `webhook-certs` | cosign-system | policy-controller |
| `operator`, `ts-*` | tailscale | Tailscale operator (node state per proxy) |

## Not Kubernetes Secrets

| Credential | Where | Notes |
| --- | --- | --- |
| k3s node token | `/var/lib/rancher/k3s/server/node-token` on the server | Needed to join agent nodes |
| CloudBeaver read-only role `cloudbeaver_ro` | 1Password `cloudbeaver-db` (`username`, `password`), typed into the CloudBeaver connection | Stored encrypted on the CloudBeaver PVC; role grants in `deploy/cloudbeaver/README.md` |
| t3code opencode `auth.json` | t3code PVC, entered in a session | User-held; never synced |
| CLI logins (Claude, Codex) | hermes and t3code PVC homes | Survive rollouts, lost with the PVC |

Out of scope: CI's per-run `GITHUB_TOKEN` and Kubernetes ServiceAccount tokens.

## Re-verify

```sh
grep -rnE "secretKeyRef|secretRef|secretName|imagePullSecrets" deploy/ apps/ scripts/
grep -rn "kind: ExternalSecret" deploy/
kubectl get externalsecret -A && kubectl get clustersecretstore
kubectl get secrets -A -o jsonpath='{range .items[?(@.metadata.annotations.kubectl\.kubernetes\.io/last-applied-configuration)]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'   # expect nothing
```
