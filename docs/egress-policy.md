# Egress policy

Referenced from `deploy/policies/base/networkpolicy.yaml`, `examples/egress-smoke.mjs`, and `apps/factory/orchestrator/knowledge-context.sh`. This is the normative destination list those files defer to.

## The posture

- **Ingress is default-deny** in `agents`, `sandbox`, and `work`; each workload declares its own exposure rule beside its manifests (e.g. `deploy/t3code/base/netpol.yaml`, `deploy/headlamp/base/netpol.yaml`). The metrics stack ships its own (`deploy/victoriametrics/base/netpol.yaml`, `deploy/loki/base/netpol.yaml`) — the only ingress into VictoriaMetrics is Grafana, the only one into Loki is `agents`-namespace pods.
- **Egress, per namespace:**
  - `agents` — **open by design.** Interactive agents need the internet, and hermes also talks to the Kubernetes API; identity is trusted and RBAC/PSA carry the control weight (`README.md` → Security model). Revisit with allowlists if agents start pointing at sensitive internal targets.
  - `sandbox` — **default-deny with a public-only allowlist** (`sandbox-egress-public-only` in `deploy/policies/base/networkpolicy.yaml`): DNS to kube-dns, then the public internet with every private/special range carved out (k8s API + pod/service CIDRs, node/LAN RFC1918, link-local metadata, tailnet CGNAT). Factory profile pods are selected out and governed by their stricter per-profile netpols (`deploy/factory/base/profile-*.yaml`). A new sandbox workload without its own allowance fails closed, not open.
  - `work` — same shape (`work-egress-public-only`): the public internet and nothing else — no Kubernetes API, no LAN or tailnet, no homelab services.
  - `database` — default-deny both directions with named allowances only (`deploy/postgres/base/netpol.yaml`).

## Deliberate exceptions (egress narrowed below its namespace baseline)

- **Headlamp backend** — DNS + the Kubernetes API, nothing else: `deploy/headlamp/base/netpol.yaml`.
- **CNPG postgres instances** — DNS, the Kubernetes API, peer instances on 5432 (`allow-instance-egress` in `deploy/postgres/base/netpol.yaml`).
- **Factory worker profiles** — GitHub + container registries + the Kubernetes API by explicit CIDR: `deploy/factory/base/profile-code-pr.yaml` (medic/reviewer/security variants alongside).

## Required destinations (the positive set)

A sandbox pod must reach: DNS, GitHub (git/codeload/API), a package registry, and a model API. `examples/egress-smoke.mjs` proves exactly these open and everything private closed.

## Adding a new exception

1. Put the named allowance **beside the workload's manifests** (the workload-owned pattern used across this repo), never in `deploy/policies/base` — one `kubectl apply -k` must bring up everything a workload needs.
2. Keep it scoped: `podSelector` + `namespaceSelector` + ports. Never widen with `ipBlock: 0.0.0.0/0`.
3. Verify with `./scripts/egress-smoke.sh`: it runs the full matrix from a sandbox pod and from inside a dind inner container (docker0 traffic is tested, not assumed). Add new required-destination classes to `examples/egress-smoke.mjs` so they stay proven.

## Decision points

- **0.0.0.0/0-minus-private-ranges over enumerating SaaS IPs**: SaaS IPs change without notice, and a stale allowlist is an outage. If a destination can't be expressed this way, introduce an egress proxy — don't widen the netpol.
- **`agents` stays open** until agents point at sensitive internal targets (databases, headlamp, the node). Then apply headlamp's pattern: per-workload allowlists, starting with the workloads that actually need them.
