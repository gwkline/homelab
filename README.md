# homelab

A k3s cluster on old servers that could die at any second. State lives on PersistentVolumes and in 1Password; nodes are rebuilt from `bootstrap/bootstrap.sh`, and the cluster converges back to this repo.

## What runs here

Agents:

- **t3code**: T3 Code (`t3 serve`) for interactive coding sessions. Repos are auto-cloned onto its PVC.
- **work-t3code**: the same image in the isolated `work` namespace. It has a work-scoped token and public-internet-only egress.
- **hermes**: Nous Research's persistent agent. It drives the software factory through Executor and has read-only cluster access.
- **executor**: the shared MCP/tool gateway, giving every agent one catalog of integrations and credentials.

Software factory (`deploy/factory`): a collector admits open GitHub issues labelled `factory` as Runs; only collaborators can apply that label. The orchestrator turns each Run into a tested draft PR, and the reviewer squash-merges it once CI is green. Security, medic and sweeper CronJobs keep PRs moving. See [ADR-003](docs/adr/adr-003-factory-github-ledger.md).

Knowledge (`deploy/knowledge`): two services over Postgres. `knowledge-ingest` runs a queue and an extract → chunk → embed → upsert worker. `knowledge-retrieval` serves cited hybrid search (BM25 + vector). See [ADR-002](docs/adr/adr-002-knowledge-retrieval-architecture.md).

Platform:

- **panel**: this repo's control panel. It queues and shows factory runs, explores the knowledge base, and links to every dev tool.
- **homepage**, **headlamp** (read-only Kubernetes UI), **cloudbeaver** (SQL client) and **grafana**: tailnet UIs.
- **postgres**: a CloudNativePG cluster holding factory and knowledge state.
- **loki** and **victoriametrics**: 30 days of logs and metrics, read by Grafana.
- **deployer**: continuous delivery for this repo's images (see below).
- **chaos**: a small operational CronJob.

Every UI is reachable only on the tailnet, through the Tailscale operator.

`kubectl apply -k clusters/home` applies the core set. The operators (ESO, CNPG, policy-controller, tailscale) and the per-component bases (executor, knowledge) are applied as described in [docs/rebuild-runbook.md](docs/rebuild-runbook.md).

## Images and deploys

CI builds an image only when its inputs change: the image's directory plus whatever its Dockerfile copies. A weekly run rebuilds everything. Each build is signed with cosign and published to `ghcr.io/gwkline/homelab/<app>` as `latest` and `sha-<commit>`.

Manifests reference `:latest`. Every five minutes `deploy/deployer` clones `main`, resolves each `:latest` to its current digest, and applies the homelab workloads. A merge reaches the cluster within one pass of its image build. To roll back, use `kubectl rollout undo` or revert the commit.

Third-party images and Dockerfile bases are pinned tag+digest. Downloaded tools are pinned to a version and checksum-verified.

## Secrets

Long-lived credentials live in 1Password, and External Secrets syncs them into the cluster (`deploy/eso`, `deploy/github-tokens`). The one hand-entered secret is the 1Password service-account token at bootstrap (`scripts/create-onepassword-service-account.sh`). A credential rotated in 1Password propagates within about an hour. [docs/secrets-inventory.md](docs/secrets-inventory.md) lists every credential and who owns it.

## Security model

- **Pod Security:** `agents` and `sandbox` enforce `baseline` Pod Security and `work` enforces `restricted`. Nothing runs privileged, and no pod gets a Docker socket.
- **Network policy:**
  - Ingress is default-deny, and only Tailscale proxies reach the UIs.
  - Egress from `sandbox` and `work` is public-internet only: no Kubernetes API, LAN, tailnet or cloud metadata ([docs/egress-policy.md](docs/egress-policy.md)).
- **Kubernetes API access is the exception and is narrowly scoped:**
  - panel and the factory create Jobs in `sandbox`.
  - deployer applies its target workloads.
  - hermes, headlamp, alloy and victoriametrics only read.

  Each grant lives in an `rbac.yaml` beside its workload.

- **Image admission:** the sigstore policy-controller rejects any homelab image whose digest isn't signed by this repo's `main` CI ([ADR-004](docs/adr/adr-004-cosign-admission-verification.md)).
- **Tailscale SSH:** it is enabled on nodes and gated by tailnet ACLs.

## Common tasks

```sh
kubectl apply -k clusters/home                  # converge the core set
scripts/rebuild-check.sh                        # drift + health sweep
scripts/new-job.sh my-task 'npm test'           # one-off sandbox Job
./scripts/verify.sh                             # local checks before a PR
```

Rebuilding a dead node:

```sh
bootstrap/bootstrap.sh server                   # fresh Ubuntu 24.04, control plane
bootstrap/bootstrap.sh agent <server-ip>        # worker
```

Then follow [docs/rebuild-runbook.md](docs/rebuild-runbook.md). First-time hardware setup is in [docs/runbook-server-cluster.md](docs/runbook-server-cluster.md).

## Layout

```
apps/        source for every image this repo builds
bootstrap/   node setup (k3s, tailscale)
clusters/    clusters/home: the root kustomization
deploy/      one kustomize base per component
docs/        runbooks and ADRs
images/      third-party images we rebuild (pg_textsearch)
scripts/     operator helpers and checks
```
