# homelab

A k3s cluster on old servers that could die at any second. State lives on PersistentVolumes and in 1Password; nodes are rebuilt from `bootstrap/bootstrap.sh`, and the cluster converges back to this repo.

## What runs here

Agents:

- **t3code**: T3 Code (`t3 serve`) for interactive coding sessions. Repos are auto-cloned onto its PVC.
- **work-t3code**: the same image in the isolated `work` namespace. It has a work-scoped token and public-internet-only egress.
- **hermes**: Nous Research's persistent agent, reached through its messaging gateway. It has read-only cluster access.

Software factory (`deploy/factory`): a collector admits open GitHub issues labelled `factory` as Runs; only collaborators can apply that label. The orchestrator turns each Run into a tested draft PR, and the reviewer squash-merges it once CI is green. The medic repairs red factory PRs, the sweeper keeps them from stranding, the reclaimer requeues failed issues, and a security sweep runs every 6 hours. See [ADR-003](docs/adr/adr-003-factory-github-ledger.md).

Knowledge (`deploy/knowledge`): one image, two Deployments over Postgres. `knowledge-ingest` runs a queue and an extract → chunk → embed → upsert worker. `knowledge-retrieval` serves cited search: BM25 only until an embedding model is configured, then hybrid BM25 + vector. See [ADR-002](docs/adr/adr-002-knowledge-retrieval-architecture.md).

Platform:

- **panel**: this repo's control panel. It queues and shows factory runs, explores the knowledge base, and links to every dev tool.
- **homepage**, **headlamp** (read-only Kubernetes UI), **cloudbeaver** (SQL client) and **grafana**: tailnet UIs.
- **postgres**: a CloudNativePG cluster holding the knowledge base.
- **loki** and **victoriametrics**: 30 days of logs and metrics, read by Grafana.
- **deployer**: continuous delivery for this repo's images (see below).

`deploy/executor`, an MCP tool gateway, is not deployed.

`kubectl apply -k clusters/home` applies the core set. The operators (ESO, CNPG, policy-controller, tailscale), the operator namespaces' NetworkPolicies and knowledge are applied separately, as described in [docs/rebuild-runbook.md](docs/rebuild-runbook.md).

## Images and deploys

CI builds an image only when its inputs change: the image's directory plus whatever its Dockerfile copies. A weekly run rebuilds everything. Pull requests build without registry credentials. On `main`, CI pushes each image to `ghcr.io/gwkline/homelab/<image>` by digest and signs it with cosign, and only then tags it `sha-<short commit>` and, while that commit is still main's head, `latest`.

Manifests reference `:latest`. Every five minutes `deploy/deployer` takes the newest `main` commit whose `ci` run succeeded and pins each `:latest` in its targets to the `sha-` build of that commit's inputs. It then dry-runs those workloads through admission, applies them server-side, and waits for them to roll out ([deploy/deployer/README.md](deploy/deployer/README.md)). A merge reaches the cluster within one pass of its CI going green. RBAC, Services and the deployer itself are applied by hand. To roll back, revert the commit. `kubectl rollout undo` holds only while the deployer is suspended.

Every third-party image this repo deploys, and every Dockerfile base, is pinned by digest, and `scripts/verify.sh` rejects an unpinned image in a manifest. k3s's own add-ons in `kube-system` come with the pinned k3s version. Downloaded tools are pinned to a version and checksum-verified.

## Secrets

Long-lived credentials live in 1Password, and External Secrets syncs them into the cluster through one ClusterSecretStore (`deploy/github-tokens/base/secretstore.yaml`), which only `agents`, `database`, `sandbox`, `tailscale` and `work` may use. The one hand-entered secret is that store's 1Password service-account token, which lives only in the `external-secrets` namespace (`scripts/create-onepassword-service-account.sh`). A credential rotated in 1Password propagates within about an hour. [docs/secrets-inventory.md](docs/secrets-inventory.md) lists every credential and who owns it.

## Security model

Verified on 2026-10-07 against `main` and, with read-only `kubectl`, the live cluster.

- **Pod Security:** every namespace has an enforce level. `agents`, `sandbox`, `work`, `database` and `default` enforce `restricted`. The operator namespaces (`external-secrets`, `cnpg-system`, `cosign-system`, `tailscale`) enforce `baseline`, and only `kube-system` is `privileged`. No container outside `kube-system` is privileged, adds a capability or mounts a hostPath, so no pod gets a Docker socket.
- **Exposure:** every UI is a Tailscale Ingress, whose proxy runs unprivileged in userspace. No Service is a LoadBalancer or NodePort, and no pod uses a host port.
- **Network policy:**
  - Ingress is default-deny in every namespace that runs pods except `kube-system` and `tailscale`, whose proxies take direct WireGuard from tailnet peers. Each workload admits only its named callers.
  - Egress from `sandbox` and `work` is public-internet only: no Kubernetes API, LAN, tailnet or cloud metadata. The factory orchestrator alone adds the API server and knowledge retrieval. `agents` allows DNS, in-cluster services and the public internet, and workloads holding credentials for internal targets get a narrower allowlist ([docs/egress-policy.md](docs/egress-policy.md)).
- **Kubernetes API access is the exception and is narrowly scoped:**
  - panel and the factory orchestrator create Jobs in `sandbox`. The panel also deletes Jobs and suspends or resumes CronJobs there; the orchestrator execs into its worker pods to copy out the patch.
  - deployer applies the kinds its targets need in `agents`, `sandbox` and `work`, and writes no RBAC.
  - hermes, t3code, headlamp, alloy, victoriametrics and kube-state-metrics only read, and none of them can read Secrets.
  - The operators hold the rights their upstream manifests grant.

  Each grant lives beside its workload in `deploy/<component>/base`. The `default` ServiceAccounts in `agents`, `sandbox`, `work` and `database` mount no token, so only pods that call the API carry one.

- **Image admission:** in `agents`, `sandbox` and `work`, the sigstore policy-controller admits a `ghcr.io/gwkline/homelab/**` image only if its digest is signed by this repo's `main` CI. Other namespaces are not checked, and third-party images rely on their digest pins ([ADR-004](docs/adr/adr-004-cosign-admission-verification.md)).
- **Tailscale SSH:** `bootstrap/bootstrap.sh` enables it on every node, and tailnet ACLs decide who may use it.

## Common tasks

```sh
kubectl apply -k clusters/home                  # converge the core set
scripts/rebuild-check.sh                        # drift + health sweep
scripts/new-job.sh my-task 'npm ci && npm test' # one-off sandbox Job, run in a clone of this repo
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
deploy/      one kustomize base per component, plus shared Components
docs/        runbooks and ADRs
images/      images not tied to one app: ops (deployer, one-off Jobs), pg-textsearch
scripts/     operator helpers and checks
```
