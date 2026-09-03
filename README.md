# homelab

Two-node k3s cluster built from old servers that could die at any second. Everything is disposable by design: state lives on PersistentVolumes, and any node can be rebuilt from `bootstrap/bootstrap.sh` in ~15 minutes.

## What runs here

- **t3code**: T3 Code (`t3 serve`) as a StatefulSet — one isolated agent server per replica, each with its own PVC, repos auto-cloned from a ConfigMap. Interactive: you attach to it. Exposed to the tailnet via the Tailscale Kubernetes operator.
- **loop-agent**: unattended agents as Jobs/CronJobs — throwaway pods with the same repo-sync plumbing plus Chromium and a nested Docker daemon (dind sidecar, pod-scoped socket). Contract: do work, export results, exit. Pods are garbage-collected after finishing.
- **hermes**: Nous Research's self-improving agent as a StatefulSet — persistent memory/skills on its own PVC, reachable via its messaging gateway or `kubectl exec`. It orchestrates the software factory conversationally through the shared Executor MCP gateway — profile-validated Runs with operator approval gates — and holds only read-only RBAC for self-visibility and cluster health.
- **executor**: self-hosted Executor as the single MCP/tool gateway — every MCP-compatible agent (T3 Code, hermes, Cursor, Claude, Codex, future factory jobs) shares one catalog of integrations with central credentials and allow/approval/block policies. Pinned image, PVC-backed state, tailnet-internal only.
- **homepage**: dashboard for every tailnet service at `https://homepage.<tailnet>.ts.net` — live status cards, config in git.
- **panel**: the factory control panel at `https://panel.<tailnet>.ts.net`. Custom Vite + React app (this repo's own code) listing sandbox jobs and schedules, with a button to launch runs against a command or issue number. Its dev tools catalog is the front door for self-hosted tools (Grafana, Headlamp, CloudBeaver, Executor, Homepage, T3 Code, …): cards show live health from cluster state and link out to tailnet hostnames. Adding a tool is one entry in `apps/panel/server/devtools.ts` — generic operations stay in the upstream tools.
- **cloudbeaver**: browser database client at `https://cloudbeaver.<tailnet>.ts.net` — inspect the factory PostgreSQL schemas and run harmless reads with a least-privilege, non-superuser role. Tailnet-only (Tailscale operator + NetworkPolicy), state on a small workspace PVC; credential and backup contract in `deploy/cloudbeaver/base/README.md`.
- **dispatcher**: watches a repo for issues labeled `run-agent` and turns each one into a sandbox Job automatically. The label is the authz gate (only collaborators can add it).

All share `apps/shared/workspace-lib.sh` (git auth + repo sync).

## Private repos

Workloads read a fine-grained PAT from Secret `github-token` (key `token`), mounted at `/secrets/token`. The Secret is synced declaratively from 1Password by External Secrets Operator — rotate the token in 1Password and it propagates within ~1h:

```sh
kubectl apply -k deploy/github-tokens/base   # prerequisites + rotation: deploy/github-tokens/base/README.md
```

Token needs "Contents: read-only" on every repo listed in a ConfigMap.

## Backups

Off by default. Nothing is scheduled until the credentials exist in 1Password:

```sh
# 1Password: add item `restic-backup` to the Homelab vault with fields
# RESTIC_REPOSITORY, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_PASSWORD
kubectl apply -k deploy/backup/base             # enables nightly 03:30 runs
```

A nightly restic CronJob then snapshots the stateful PVCs (agent homes, hermes memory) encrypted to any S3-compatible store. The `backup-target` secret is materialized from 1Password by External Secrets, so a clean cluster needs no interactive secret script (`scripts/create-backup-secret.sh` remains only as a documented emergency fallback). Rotation and restore instructions live in the server runbook. Losing the restic password means losing the backups.

## Launching one-off jobs

```sh
scripts/new-job.sh my-task 'node /data/repos/homelab/examples/loop-hello.mjs'
kubectl logs job/my-task -n sandbox -f
```

The panel and dispatcher can also launch runs; hermes drives the factory through the governed Executor tools instead of raw Jobs. For fully hands-off runs, apply `deploy/dispatcher/base`: any issue labeled `run-agent` in the watched repo spawns a Job every 15 minutes, no human needed.

The software factory is also fully unattended: `deploy/factory/base` runs a collector hourly. Apply it once during cluster bring-up; its small reconciler CronJob reapplies the same manifests from `main` every 10 minutes afterward. Every open issue in each repo listed by `FACTORY_REPOS` that has no factory lifecycle label is given `factory/queued`; the orchestrator then produces a tested draft PR one issue at a time. This means factory code and schedules do not silently drift from the cluster.

Loops can report back into GitHub (PR comments, issue updates) via the `gh` CLI already in the image. Write access uses a **separate**, write-scoped 1Password item (`github-writer`, Contents+PR write on target repos only) synced into `sandbox/github-token-writer` by the same ExternalSecrets; if the item is absent, write reporting stays off and read-only jobs are unaffected (all mounts are optional). See `deploy/github-tokens/base/README.md`.

## Layout

```
bootstrap/          node setup scripts (tailscale, k3s)
apps/shared/        workspace-lib.sh (git auth, repo sync) shared by all images
apps/t3code/        interactive agent server image
apps/loop-agent/    unattended loop image (Chromium, docker CLI)
                    Both coding images ship a pinned Rust toolchain (cargo).
apps/hermes/        persistent orchestrator image (kubectl included)
deploy/
  namespaces.yaml   agents + sandbox + database namespaces with PSA labels
  policies/base/    default-deny NetworkPolicies
  postgres/base/    CNPG PostgreSQL 18 cluster (factory + knowledge durable state)
  backup/base/      opt-in nightly restic backups of stateful PVCs
  gvisor/base/      opt-in loop-agent variant under gVisor
  homepage/base/    tailnet dashboard (config-driven, zero code)
  headlamp/base/    tailnet-only Kubernetes web UI (read-only inspection)
  panel/            factory control panel (Vite + React, this repo's code)
  dispatcher/base/  label-driven issue -> Job automation
  factory/base/      issue collector -> coding worker -> draft PR
  github-tokens/base/ ExternalSecrets syncing GitHub tokens from 1Password
  tailscale/        Tailscale operator install notes
   t3code/base/      StatefulSet + per-replica Services
   hermes/base/      StatefulSet + scoped RBAC + cluster guide
   executor/base/    shared MCP gateway (pinned upstream image + PVC)
   loop-agent/base/  CronJob example + task ConfigMap
docs/               hardware runbooks
.github/workflows/  image builds + validation
examples/           sample loop script target
scripts/            cluster ops helpers + verify.sh
```

## Rebuilding a dead node

```sh
# fresh Ubuntu Server 24.04, then:
bootstrap/bootstrap.sh server        # first/control-plane node
bootstrap/bootstrap.sh agent <server-ip>   # worker nodes
```

The cluster converges back to whatever is in this repo. If a disk dies, delete the PVC and the init container re-clones everything.

## Security model

Decisions and their reasons, so future-you can audit them:

- **Privilege is scoped to `sandbox` namespace only.** Nested Docker needs a privileged dind sidecar; only throwaway loop pods run there (Pod Security Admission enforces this). Interactive workloads live under `baseline` PSA.
- **No host Docker socket, ever.** The dind daemon owns an emptyDir-scoped unix socket shared within its own pod. A compromised inner container gets that pod's daemon, not the node's.
- **Pods cannot talk to Kubernetes** — with deliberate, audited exceptions. Dispatcher (label-driven issue automation) and the panel (control-panel backend) hold Job/CronJob write verbs scoped to `sandbox` and nothing else; hermes now holds **read-only** access (self-visibility + cluster health) and requests factory work through the Executor MCP gateway, which carries the write credentials host-side behind profile validation and approval policy. Headlamp (`deploy/headlamp/base`) is an additional read-only exception: the Kubernetes web UI acts as its pod's ServiceAccount under a get/list/watch-only cluster role. None can touch secrets, nodes, CRDs, or anything in their own namespace. A mounted CLUSTER.md playbook teaches hermes the governed patterns.
- **Default-deny ingress** in both namespaces; only Tailscale operator proxies may reach t3code, homepage, panel, and headlamp (each workload declares its own exposure rule beside its manifests). Hermes has no inbound at all. Egress is open by design — agents need the internet — revisit with allowlists if you start pointing agents at sensitive internal targets (headlamp already narrows its own egress to DNS + the Kubernetes API).
- **Secrets**: long-lived credentials are synced from 1Password by External Secrets (`deploy/github-tokens/base/`); the only hand-entered secret is the least-privilege 1Password service-account token at bootstrap. The PAT is mounted read-only per namespace and delivered to git via a runtime-generated askpass helper (never in `.git/config`, env, or image layers). Non-dind containers run as uid 1000 with all capabilities dropped.
- **Tailscale SSH is enabled on nodes** (`bootstrap.sh` runs `tailscale up --ssh`), gated by your tailnet ACLs. Tighten those before inviting anyone.
- **Supply chain**: npm packages, upstream images, and GitHub Actions are pinned to exact versions; Renovate keeps them current. Images are rebuilt on every push to `main` and signed keylessly with cosign — verify with `cosign verify <image>` against the GitHub workflow identity.
- **Known gap**: dind sidecar is privileged by necessity. Next escalation step if wanted: gVisor (`runsc` RuntimeClass) for inner containers. An opt-in variant lives in `deploy/gvisor/base`; see the server runbook.

## GHCR images

CI publishes images to `ghcr.io/gwkline/homelab/{t3code,loop-agent,hermes}` on every push to `main`. The manifests reference those paths directly; if you fork this repo, update them (or add a kustomize overlay with your own `images:` transforms).

If your packages are private, create a pull secret once and reference it:

```sh
kubectl create secret docker-registry ghcr-pull \
  --namespace agents \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password=<PAT with read:packages>
# repeat for sandbox; add imagePullSecrets to pod specs if needed
```

Making this repo public makes its images public and removes this step.

## Runbooks

- [Server cluster: bare metal → working cluster](docs/runbook-server-cluster.md)
- [Gaming desktop: Windows + Linux dual boot](docs/runbook-gaming-dualboot.md)
- [Media server: hardware inventory + Plex/Jellyfin brief](docs/media-server-brief.md)

## Access

Each t3code pod gets a Tailnet hostname via the operator:

```
kubectl get svc -n agents
# t3code-0 → https://t3code-0.<tailnet>.ts.net
```

Pair from the desktop app or phone using the URL printed in the pod logs:

```
kubectl logs t3code-0 -n agents | head
```
