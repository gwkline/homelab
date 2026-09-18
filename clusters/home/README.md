# clusters/home — root cluster entry point (issue #20)

One Kustomization composing the complete normal cluster workload set —
namespaces, policies, platform prerequisites, and workloads. Plain
`kubectl` only; no Flux, no helm expansion:

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

Overlays include `base` and add to it — `base` must never reference them
(kustomize rejects the cycle and duplicate resource IDs, so composition
stays one-directional).

## The normal set (base)

| Layer | Sources | Ordering note |
| --- | --- | --- |
| namespaces + policies | `deploy/namespaces`, `deploy/policies/base` | first in the render: PSA + sigstore include labels, default-deny netpols; the tailscale serve-fixer RBAC reaches into `agents` |
| platform prerequisites | `deploy/eso/base`, `deploy/github-tokens/base` | ESO carries its own CRDs — on a fresh cluster it needs a two-pass apply with waits **before** this root (see below); the smoke ExternalSecret proves reconciliation |
| admission policy | `deploy/image-policy/base` | requires the policy-controller CRD (helm) and must be in force before workload pods are admitted (ADR-004) |
| tailscale stack | `deploy/tailscale` | namespace + SecretStore + operator-oauth ExternalSecret + t3code/panel serve-fixers; the operator itself is helm-installed **after** this root |
| workloads | t3code, hermes, loop-agent, homepage, panel, headlamp, dispatcher, factory | depend on the secrets synced above, never on apply order for admission |

### Helm-managed controllers (deliberately not kustomize)

Two controllers cannot be expressed in plain kustomize and stay documented
helm steps in [docs/rebuild-runbook.md](../docs/rebuild-runbook.md) §4:

1. **External Secrets Operator** — `deploy/eso/base` is applied in two
   passes on a fresh cluster (CRDs must be Established before the smoke
   ExternalSecret applies) **before** `kubectl apply -k clusters/home`.
2. **policy-controller** — helm install (pinned chart) **before** the root
   apply, so the ClusterImagePolicy CRD exists and the webhook is in force
   before any workload pod is admitted.
3. **tailscale-operator** — helm install (pinned chart + values file)
   **after** the root apply; it consumes the operator-oauth Secret the root
   syncs from 1Password.

The hand-entered 1Password service-account tokens (agents, sandbox,
tailscale) also stay a manual runbook step — secrets are never rendered
into Git.

## Opt-in overlays (not in the normal set)

| Overlay | Command | Precondition |
| --- | --- | --- |
| backup | `kubectl apply -k clusters/home/overlays/backup` | B2 credentials exist in 1Password (docs/secrets-inventory.md) — production backup execution is excluded from the normal set until they do |
| gvisor | `kubectl apply -k clusters/home/overlays/gvisor` | runsc registered in each node's containerd config (runbook-server-cluster, "Experimental: gVisor"); replaces the stock loop-agent runtime |

Further per-component applies (chaos, grafana, loki, postgres/cnpg,
cloudbeaver, executor, auto-deploy) are documented beside their manifests
under `deploy/` and in [runbook-server-cluster.md](../docs/runbook-server-cluster.md);
they are intentionally not part of the fast-recovery normal set.
