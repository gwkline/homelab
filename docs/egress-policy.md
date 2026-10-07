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
| CNPG instances | DNS, Kubernetes API, peers on 5432 | `allow-instance-egress` in `deploy/postgres/base/netpol.yaml` |
| Factory loops and workers | kube-dns, then TCP 443 to the public internet minus private ranges, one policy per `factory.gwkline.io/profile` label. The orchestrator adds the API server node endpoint and knowledge retrieval | `allow-factory-*` beside each component in `deploy/factory/base/` |

## Required destinations

A sandbox pod must reach DNS, GitHub (git, codeload, API), a package registry, and a model API. `./scripts/egress-smoke.sh` runs this working tree's `examples/egress-smoke.mjs` in real pods in `sandbox` and `work` and proves those open and every private target closed, including the API server on the node's LAN address.

## Adding an exception

1. Put the allowance beside the workload's manifests, not in `deploy/policies/base`, so one `kubectl apply -k` brings up everything the workload needs.
2. Scope it with `podSelector` + `namespaceSelector` + ports. Never `ipBlock: 0.0.0.0/0`.
3. Run `./scripts/egress-smoke.sh`; add new required-destination classes to `examples/egress-smoke.mjs`.

## Decisions

- **Public-internet-minus-private-ranges, not SaaS IP lists:** SaaS IPs change without notice and a stale allowlist is an outage. If a destination can't be expressed this way, add an egress proxy rather than widening the netpol. `scripts/verify.sh` rejects any `ipBlock` CIDR under `deploy/` other than `0.0.0.0/0` and private/special ranges.
- **Factory workers reach any public HTTPS host** until a domain-allowlisting egress proxy (GitHub, the model provider, npm, PyPI, crates.io) replaces the CIDR rule.
- **Kubernetes API by node endpoint:** policy matches after DNAT, so an allowance for the Service VIP (`10.43.0.1`) never matches; allow `192.168.1.2:6443` instead.
- **`agents` stays open** until agents point at sensitive internal targets; then apply per-workload allowlists like headlamp's.
