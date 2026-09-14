# clusters/home — root cluster entry point (issue #20)

One Kustomization composing the complete normal cluster workload set — namespaces, policies, platform prerequisites, and workloads. Plain `kubectl` only; no Flux, no helm expansion:

```sh
kubectl kustomize clusters/home   # render the full inventory
kubectl apply -k clusters/home    # apply it
```

## Layout

```
clusters/home/
├── kustomization.yaml          # entry point: includes base
├── base/kustomization.yaml     # the normal set — resource list + ordering contract
└── overlays/
    ├── backup/                 # opt-in: normal set + nightly B2 restic backup
    └── gvisor/                 # opt-in: loop-agent CronJob under gVisor
```

Overlays include `base` and add to it — `base` must never reference them (kustomize rejects the cycle and duplicate resource IDs, so composition stays one-directional).

## The normal set (base)

The resource list in `base/kustomization.yaml` is a topological order of the dependency graph:

| # | Layer | Sources | Ordering constraint (verified dependency) |
| --- | --- | --- | --- |
| 1 | namespaces | `deploy/namespaces` | agents/sandbox/work/database carry the PSA + `policy.sigstore.dev/include` labels everything else relies on; `kubectl apply` sorts Namespaces first, so they land before all namespaced objects |
| 2 | network policies | `deploy/policies/base` | default-deny ingress/egress in force before workload pods exist (no admit window) |
| 3 | image admission policy | `deploy/image-policy/base` | the ClusterImagePolicy needs the policy-controller CRD (pre-apply) and the webhook must be in force before any workload pod below is admitted (ADR-004) |
| 4 | secret plumbing | `deploy/github-tokens/base` | per-namespace `onepassword` SecretStores + GitHub token ExternalSecrets — before every workload that mounts `github-token`(+writer)/`work-github-token` (t3code, hermes, factory jobs, panel, work-t3code) |
| 5 | tailscale stack | `deploy/tailscale` | tailscale namespace + SecretStore + operator-oauth ExternalSecret + t3code/panel/work serve-fixers; the serve-fixer RBAC reaches into `agents` (needs layer 1) |
| 6 | postgres | `deploy/postgres/base` | CNPG `Cluster`/`Database` CRs — the API server rejects them until the cnpg CRDs are Established (pre-apply); its clients are the factory/knowledge workloads in layer 7 |
| 7 | workloads | t3code, hermes, loop-agent, homepage, panel, headlamp, dispatcher, factory, work-t3code | depend on layers 1–4 (namespaces, netpols, admission, mounted secrets), never on each other's apply order |
| 8 | operational CronJobs | `deploy/chaos/base`, `deploy/node-cleanup/base` | chaos deletes pods (never races bring-up by being last; kill switch: its configmap `enabled` key) — its agents-namespace RBAC is the separate multi-namespace apply `deploy/chaos/agents`; node-cleanup prunes node disk pressure (#253) — both need only their namespace + RBAC |

### Server-side / helm controllers (deliberately not composed)

Four pieces cannot ride along in a plain `kubectl apply -k` and stay documented steps in [docs/rebuild-runbook.md](../docs/rebuild-runbook.md) §4 — `scripts/recovery-drill.sh` times the same order stage by stage:

1. **External Secrets Operator** — `deploy/eso/base` carries the operator's CRDs (two serialize >340KB, past the 262144-byte annotation limit kubectl's client-side apply writes), so it applies with `--server-side` in two passes with waits (CRDs Established → rollout Ready → smoke ExternalSecret Ready proves reconciliation) **before** this root: every ExternalSecret in layers 4–6 reconciles through it.
2. **CloudNativePG operator** — `deploy/cnpg/base` is the pinned upstream bundle (Cluster CRD >1MB, same server-side requirement). One `kubectl apply --server-side -k deploy/cnpg/base` + CRD-Established + rollout wait **before** this root: the postgres Cluster/Database CRs in layer 6 are rejected until the CRDs exist.
3. **policy-controller** — helm install (pinned chart) **before** the root apply, so the ClusterImagePolicy CRD exists and the webhook is in force before any workload pod is admitted.
4. **tailscale-operator** — helm install (pinned chart + values file) **after** the root apply; it consumes the operator-oauth Secret the root syncs from 1Password.

The hand-entered 1Password service-account token (`scripts/create-onepassword-service-account.sh` → agents, sandbox, work, tailscale) is also a manual runbook step — secrets are never rendered into Git.

## Opt-in overlays (not in the normal set)

| Overlay | Command | Precondition |
| --- | --- | --- |
| backup | `kubectl apply -k clusters/home/overlays/backup` | B2 credentials exist in 1Password (docs/secrets-inventory.md) — production backup execution is excluded from the normal set until they do |
| gvisor | `kubectl apply -k clusters/home/overlays/gvisor` | runsc registered in each node's containerd config (runbook-server-cluster, "Experimental: gVisor"); replaces the stock loop-agent runtime |

Further per-component applies (grafana, loki, cloudbeaver, executor, auto-deploy) are documented beside their manifests under `deploy/` and in [runbook-server-cluster.md](../docs/runbook-server-cluster.md); they are intentionally not part of the fast-recovery normal set.
