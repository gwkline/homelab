# homelab

Two-node k3s cluster built from old servers that could die at any second.
Everything is disposable by design: state lives on PersistentVolumes, and any
node can be rebuilt from `bootstrap/bootstrap.sh` in ~15 minutes.

## What runs here

- **t3code**: T3 Code (`t3 serve`) as a StatefulSet — one isolated agent server
  per replica, each with its own PVC, repos auto-cloned from a ConfigMap.
  Interactive: you attach to it. Exposed to the tailnet via the Tailscale
  Kubernetes operator.
- **loop-agent**: unattended agents as Jobs/CronJobs — throwaway pods with the
  same repo-sync plumbing plus Chromium and a nested Docker daemon (dind
  sidecar, pod-scoped socket). Contract: do work, export results, exit. Pods
  are garbage-collected after finishing.
- **hermes**: Nous Research's self-improving agent as a StatefulSet — persistent
  memory/skills on its own PVC, reachable via its messaging gateway or
  `kubectl exec`. It holds scoped RBAC to spawn/inspect/delete loop jobs in
  `sandbox`, so you can ask *it* to schedule cluster work from inside a chat.

Both share `apps/shared/workspace-lib.sh` (git auth + repo sync).

## Private repos

Workloads read a fine-grained PAT from Secret `github-token` (key `token`),
mounted at `/secrets/token`. Create it per namespace:

```sh
scripts/create-github-secret.sh agents   # prompts for token, or set GITHUB_PAT
```

Token needs "Contents: read-only" on every repo listed in a ConfigMap.

## Layout

```
bootstrap/          node setup scripts (tailscale, k3s)
apps/shared/        workspace-lib.sh (git auth, repo sync) shared by all images
apps/t3code/        interactive agent server image
apps/loop-agent/    unattended loop image (Chromium, docker CLI)
deploy/
  tailscale/        Tailscale operator install (Helm)
  t3code/base/      StatefulSet + per-replica Services
  loop-agent/base/  CronJob example + task ConfigMap
examples/           sample loop script target
scripts/            cluster ops helpers
```

## Rebuilding a dead node

```sh
# fresh Ubuntu Server 24.04, then:
bootstrap/bootstrap.sh server        # first/control-plane node
bootstrap/bootstrap.sh agent <server-ip>   # worker nodes
```

The cluster converges back to whatever is in this repo. If a disk dies, delete
the PVC and the init container re-clones everything.

## Security model

Decisions and their reasons, so future-you can audit them:

- **Privilege is scoped to `sandbox` namespace only.** Nested Docker needs a
  privileged dind sidecar; only throwaway loop pods run there (Pod Security
  Admission enforces this). Interactive workloads live under `baseline` PSA.
- **No host Docker socket, ever.** The dind daemon owns an emptyDir-scoped
  unix socket shared within its own pod. A compromised inner container gets
  that pod's daemon, not the node's.
- **Pods cannot talk to Kubernetes** — with one deliberate, audited
  exception: hermes runs as ServiceAccount `hermes`, which may create/inspect/
  delete Jobs and CronJobs in `sandbox` only (plus read pods/logs there so it
  can debug failed runs). It cannot touch secrets, nodes, CRDs, or anything
  in its own namespace. This is what lets you ask it to spin up loops itself.
  A mounted CLUSTER.md playbook teaches it the patterns.
- **Default-deny ingress** in both namespaces; only Tailscale operator proxies
  may reach t3code. Hermes has no inbound at all (kubectl exec + outbound
  gateway). Egress is open by design — agents need the internet — revisit
  with allowlists if you start pointing agents at sensitive internal targets.
- **Secrets**: PAT mounted read-only per namespace, delivered to git via a
  runtime-generated askpass helper (never in `.git/config`, env, or image
  layers). Non-dind containers run as uid 1000 with all capabilities dropped.
- **Known gap**: dind sidecar is privileged by necessity. Next escalation
  step if wanted: gVisor (`runsc` RuntimeClass) for inner containers.

## GHCR images

The GitHub Action publishes images to `ghcr.io/<owner>/...`. If this repo is
private, those images are private too — create a pull secret once and
reference it:

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
