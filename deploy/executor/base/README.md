# Executor deployment

Self-hosted [Executor](https://github.com/UsefulSoftwareCo/executor) as the single MCP/tool gateway shared by T3 Code, Hermes, Cursor, Claude, Codex, and future factory Jobs (issue #72). One catalog, one set of credentials, one set of allow/approval/block policies — every MCP-compatible agent points at the same endpoint.

First milestone: one pinned service, one harmless read-only integration, called from two different MCP clients through the same endpoint.

## Pinning

The image is pinned to upstream release **1.6.7** AND its immutable digest (`ghcr.io/usefulsoftwareco/executor-selfhost:1.6.7@sha256:c8dd83a5dba8ac992dfe1ded4aa65ae4e7f52ec31fddbe2af5b49ffebe5bbfa7`, multi-arch index digest, verified against the registry at deploy time). Upgrades are a deliberate change of both tag and digest in `statefulset.yaml`; Renovate does not manage this third-party image, so the bump is a reviewed commit. Source for that exact build lives in the upstream repo at tag `v1.6.7` (MIT).

## Deployment mode and state (from upstream behavior)

Per upstream's self-host docs (executor.sh/docs/hosted/docker): the entire server — typed API, streamable-HTTP MCP endpoint at `/mcp`, Better Auth (cookie / bearer / API-key + MCP OAuth), QuickJS code execution sandbox, and the web console — is **one process in one container over a libSQL (SQLite) file**. There is no external database, worker, or proxy to run.

Everything that must persist lives in `/data`: the database (`data.db`, holding integrations, connections, credentials, policies, users, API keys, run history) and the generated encryption keys. The StatefulSet therefore mounts a PVC (`executor-data-executor-0`) at `/data` — a pod restart or node rebuild preserves all configuration. Generated secrets: `BETTER_AUTH_SECRET` (sessions) and `EXECUTOR_SECRET_KEY` (encrypts stored connection credentials at rest) are created on first boot and persisted in `/data` — deleting the PVC invalidates both (users get signed out; stored integration credentials become undecryptable), which is why backups matter (below).

## Deploy

```sh
kubectl apply -k deploy/executor/base
```

One manual bootstrapping step (credentials never live in git):

```sh
# optional but recommended: headless admin instead of browser first-run
kubectl -n agents create secret generic executor-admin \
  --from-literal=email=you@example.com \
  --from-literal=password="$(openssl rand -base64 24)"
```

Set the tailnet suffix once (homepage-env ConfigMap key `tailnet-name`, the single tailnet configuration value — see deploy/tailscale/README.md). Executor composes `EXECUTOR_WEB_BASE_URL=https://executor.$(TAILNET_NAME)` from it; until it is set, the MCP endpoint works in-cluster but browser logins are rejected (upstream requires the exact browser URL).

## Exposure (internal-only)

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web UI (browser) | `https://executor.<tailnet>` | Tailnet identities only, via the Tailscale operator proxy |
| MCP endpoint | `https://executor.<tailnet>/mcp` (laptop clients) or `http://executor.agents.svc:8080/mcp` (in-cluster clients) | Tailnet / `agents`-namespace pods only |

There is no public exposure. The in-cluster Service (`executor`, ClusterIP, port 8080) is what the panel's health check probes. NetworkPolicy (`netpol.yaml`) allows inbound only from Tailscale operator proxies and same-namespace pods; sandbox (factory) pods are deliberately excluded until a factory job actually needs the gateway — add an allow rule beside these manifests, never widen the namespace default.

## Credentials

- Deployment credential: the `executor-admin` Secret above, created manually, never committed. (1Password-backed secret delivery is issue #41; this manually bootstrapped secret unblocks the spike.)
- Integration credentials (API keys for connected tools): stored inside Executor's database, encrypted at rest with `EXECUTOR_SECRET_KEY`. Upstream design: credentials are resolved **host-side at call time** and attached to the outbound request only — they never enter the QuickJS sandbox heap, the agent, or the model, so they can never appear in tool output. Do not paste secrets into tool arguments or chat; put them in the connection's auth fields in the web UI.

## Policies (default + destructive)

Executor derives initial policies from the integration's semantics: read-only `GET` operations on OpenAPI specs are allowed by default; destructive operations (DELETE, destructiveHint MCP tools, GraphQL mutations) can be set to require approval or be blocked. For this deployment:

- Start every new integration with its read tools allowed and everything write/delete-shaped set to **require approval** (or block) in the web UI before sharing the endpoint with agents.
- Approval pauses the run until a human approves it (`executor resume` / web UI), so destructive calls never execute unattended.
- The one test integration for this milestone is the public read-only Swagger Petstore (OpenAPI): every operation a model would auto-run is a `GET`; keep the write tools gated.

## Factory operations integration (#84)

The factory surface is its own OpenAPI contract — `deploy/executor/factory-openapi.json` — served host-side by the panel (`http://panel-http.agents.svc:3000`, `deploy/panel/base`). Executor ingests the spec, so the MCP tool schemas derive from the factory OpenAPI (the thin native adapter option was not needed: OpenAPI ingestion preserves the factory contract). Tools: `factory_list_profiles`, `factory_get_run`, `factory_list_runs`, `factory_create_run`, `factory_cancel_run`, `factory_retry_run`.

Network: the spec's server is the panel's in-cluster plaintext Service. Executor egress (netpol.yaml) allows the panel pod on :3000, and the panel ingress allows only the executor pod — **the executor pod is the sole in-cluster caller of the factory API**, so MCP agents cannot bypass Executor's policy/approval layer to reach it directly.

Bootstrap the integration (web console, one-time):

1. Import `deploy/executor/factory-openapi.json` as an OpenAPI integration (name it `factory`).
2. Base URL stays the spec default (`http://panel-http.agents.svc:3000`); the executor pod's netpol already permits it.
3. Set the connection's auth headers host-side: `X-Factory-Requested-By: <client-id>` — one connection per MCP client identity (`hermes`, `t3code`), so factory audit events preserve who requested the run. This header is the identity channel; it is never a tool argument, and agents cannot set it from a conversation.
4. Apply the policy table below before sharing the endpoint with agents.

Policy per tool (mirrors `x-factory-policy` in the spec; set in the web UI):

| Tool | Policy | Why |
| --- | --- | --- |
| `factory_list_profiles`, `factory_get_run`, `factory_list_runs` | allowed | Reads: state and artifact links only |
| `factory_create_run` | **require approval** | Starts worker Jobs (cluster cost + repo writes) |
| `factory_cancel_run` | **require approval** | Kills in-flight workers, rewrites ledger labels |
| `factory_retry_run` | **approval-required** | Re-spawns worker Jobs |

The factory adds a second, deeper approval layer: the publish transition is gated by the durable approval records (#83) regardless of who asked. Admission is server-side — unknown profiles, off-allowlist repos, and raw Kubernetes fields are rejected by the panel before anything is labeled (integration tests in `apps/panel/tests/factory-mcp.test.ts`).

Errors are shaped for agents: every failure names the actionable factory state (the admitted profiles/repos, or the current Run state that forbids the transition) and never carries credentials or stack internals.

### Fixture: two clients, one Run (#84 acceptance)

Proves T3 Code and Hermes both drive the same Executor endpoint (run after the `factory` integration + policies exist):

1. Create a fixture issue (`[factory-fixture]` doc-only change, see `docs/factory-fixture-e2e.md`).
2. **T3 Code**: in a t3code chat, ask "List the factory profiles, then create a code-pr run for issue <N>." → Executor raises an approval → approve → run is `queued` (job label `factory.gwkline.io/requested-by=t3code`).
3. **Hermes**: same conversation flow — "Show me that run" (inspection needs no approval), then "Cancel the run" (approval) → run ends `cancelled`; finish with "Retry the run" (approval) if you want to exercise re-queue.
4. Verify the audit chain: run marker comment on the issue shows `Requested by` per client; Executor's run log shows tool, caller identity, and policy decision for each call.
5. Negative checks from either client: profile `bash-1` → denied (unknown profile); "give the run more CPU / a different service account" → impossible (no such inputs exist in the tool schema).

Known gap: until per-connection header support is confirmed against upstream 1.6.7, a single shared connection would collapse caller identity to one value — if the run marker shows the wrong client, split the factory integration into one connection per client and set each header host-side.

## Connect the two MCP clients

In-cluster (T3 Code pods — the per-replica agent servers):

```sh
kubectl -n agents exec t3code-0 -- npx add-mcp \
  http://executor.agents.svc:8080/mcp --transport http --name executor
```

Second client (e.g. Cursor on a laptop, or hermes): same endpoint, tailnet URL for laptop clients (`https://executor.<tailnet>/mcp`), the in-cluster service DNS for pods. Clients authenticate with an Executor API key (bearer) or MCP OAuth — mint the key in the web console and put it in the client's MCP config, never in code or logs. Both clients now see the same tool catalog; call the petstore read tool from each and compare results — same endpoint, same policy decision, same logged run.

Most MCP clients only load servers at startup; restart the client or open a new chat before Executor tools appear (upstream note).

## Logging and audit

Executor records every tool call through the proxy (tool, connection, policy decision, run identity, timing) and exposes runs in the web console — one place to audit who called what and what the policy decided. Pod logs (`kubectl logs -n agents executor-0`) carry the server-side detail. Two caveats stated plainly: upstream does not yet guarantee a caller-identity field per MCP call in self-host logs (single-org auth today), and raw credentials are host-side by design, so they never appear in logs or run history. When adding integrations, verify log redaction on any first-party internal endpoint before pointing real credentials at it.

## Backups and clean recovery (tested)

The nightly restic backup (deploy/backup/base) snapshots the executor PVC alongside t3code and hermes. Recovery procedure — run this drill before trusting it:

```sh
# 1. snapshot now instead of waiting for 03:30:
kubectl -n backup create job --from=cronjob/restic-backup restic-manual
kubectl -n backup logs job/restic-manual -f          # "==> backup complete"

# 2. destroy state:
kubectl -n agents delete statefulset executor
kubectl -n agents delete pvc executor-data-executor-0
kubectl -n agents apply -k deploy/executor/base      # fresh empty /data

# 3. restore into the fresh PVC (same credentials, any machine):
restic restore latest --target /restore --include /mnt/executor
kubectl -n agents delete pod executor-0              # reschedule onto restored data
#    (or stop the StatefulSet, copy files back, start it again)

# 4. verify: integration/connection list and policies intact, admin login
#    works, the petstore read tool still answers from both MCP clients.
```

Losing the restic password loses the backups; the stored-credential encryption key lives inside `/data` itself, so a restored snapshot is self-contained.

## Known limitations of the spike

- The factory operations integration (#84) is the first internal integration; its only caller is the executor pod (pod-scoped netpol, not a token) — same trust model as the panel's other in-cluster callers.
- Egress filtering is IP/port-level (public 443 + DNS, plus the pod-scoped factory API); FQDN allowlists need an egress proxy, documented as the criteria to introduce one.
- Caller identity in audit logs is per-user (API key holder), not per-MCP session; factory Jobs joining the gateway will need their own Executor user/keys to stay attributable.
