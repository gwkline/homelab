# Egress policy

The normative network posture that `deploy/policies/base/networkpolicy.yaml` and `examples/egress-smoke.mjs` implement.

## Posture

Ingress is default-deny in `agents`, `sandbox`, and `work`; each workload declares its own ingress rule beside its manifests (e.g. `deploy/t3code/base/netpol.yaml`). VictoriaMetrics admits only Grafana; Loki admits only `agents` pods.

| Namespace | Egress |
| --- | --- |
| `agents` | Open by design: interactive agents need the internet and hermes reads the Kubernetes API. RBAC and Pod Security carry the control weight |
| `sandbox` | Default-deny plus `sandbox-egress-public-only`: kube-dns, then the public internet minus every private/special range (k8s API, pod/service CIDRs, RFC1918 LAN, link-local metadata, tailnet CGNAT). Factory profile pods are selected out and use their own stricter netpols. A new workload with no allowance fails closed |
| `work` | Same shape (`work-egress-public-only`): public internet only — no Kubernetes API, LAN, tailnet, or homelab services |
| `database` | Default-deny both ways with named allowances (`deploy/postgres/base/netpol.yaml`) |

## Exceptions narrower than the namespace baseline

| Workload | Allowed egress | Where |
| --- | --- | --- |
| Headlamp | DNS + Kubernetes API | `deploy/headlamp/base/netpol.yaml` |
| CNPG instances (pg-primary, recovery Clusters) | DNS, Kubernetes API, peers on 5432, HTTPS to the public internet (Backblaze publishes no IP ranges for B2) | `allow-instance-egress` in `deploy/postgres/base/netpol.yaml` |
| Factory profiles | GitHub, container registries, Kubernetes API by explicit CIDR | `deploy/factory/base/profile-code-pr.yaml`, `profile-security.yaml` |

## Required destinations

A sandbox pod must reach DNS, GitHub (git, codeload, API), a package registry, and a model API. `./scripts/egress-smoke.sh` runs `examples/egress-smoke.mjs` in a real sandbox pod and proves those open and every private target closed.

## Adding an exception

1. Put the allowance beside the workload's manifests, not in `deploy/policies/base`, so one `kubectl apply -k` brings up everything the workload needs.
2. Scope it with `podSelector` + `namespaceSelector` + ports. Never `ipBlock: 0.0.0.0/0`.
3. Run `./scripts/egress-smoke.sh`; add new required-destination classes to `examples/egress-smoke.mjs`.

## Decisions

- **Public-internet-minus-private-ranges, not SaaS IP lists:** SaaS IPs change without notice and a stale allowlist is an outage. If a destination can't be expressed this way, add an egress proxy rather than widening the netpol.
- **`agents` stays open** until agents point at sensitive internal targets; then apply per-workload allowlists like headlamp's.
