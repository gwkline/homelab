# Egress policy

The normative network posture that `deploy/policies/base/networkpolicy.yaml` and `examples/egress-smoke.mjs` implement.

## Posture

Ingress is default-deny in `agents`, `sandbox`, `work`, `database`, the operator namespaces (`external-secrets`, `cnpg-system`, `cosign-system`) and `default`. `tailscale` stays open so its proxies accept direct WireGuard from tailnet peers. Each workload declares its own ingress rule beside its manifests (e.g. `deploy/t3code/base/netpol.yaml`); the operator namespaces open only their admission webhook ports (`deploy/operator-policies/base`). VictoriaMetrics admits only Grafana; Loki admits only Alloy and Grafana; Postgres admits only cloudbeaver, knowledge-ingest and knowledge-retrieval.

| Namespace | Egress |
| --- | --- |
| `agents` | `agents-egress-default`: kube-dns, the pod and service CIDRs, and the public internet; no LAN, tailnet or link-local. `agents-egress-kube-api` adds the API server for alloy, deployer, kube-state-metrics, panel and victoriametrics. Workloads with a narrower policy are listed out of the default by `app` label |
| `sandbox` | Default-deny plus `sandbox-egress-public-only`: kube-dns, then the public internet minus every private/special range (k8s API, pod/service CIDRs, RFC1918 LAN, link-local metadata, tailnet CGNAT). Factory profile pods are selected out and use their own stricter netpols. A new workload with no allowance fails closed |
| `work` | Same shape (`work-egress-public-only`): public internet only — no Kubernetes API, LAN, tailnet, or homelab services |
| `database` | Default-deny both ways with named allowances (`deploy/postgres/base/netpol.yaml`) |

## Exceptions narrower than the namespace baseline

| Workload | Allowed egress | Where |
| --- | --- | --- |
| Headlamp | DNS + Kubernetes API | `deploy/headlamp/base/netpol.yaml`, `headlamp-kube-api` in `deploy/policies/base/kube-api-egress.yaml` |
| hermes, t3code | DNS, Kubernetes API, Executor, knowledge retrieval, public internet (any port) | `deploy/hermes/base/netpol.yaml`, `deploy/t3code/base/netpol.yaml`, `hermes-kube-api`/`t3code-kube-api` in `deploy/policies/base/kube-api-egress.yaml` |
| Grafana, CloudBeaver, knowledge, Executor | Their own allowlists | beside each workload |
| CNPG instances | DNS, Kubernetes API, peers on 5432 | `allow-instance-egress` in `deploy/postgres/base/netpol.yaml`, `pg-primary-kube-api` in `deploy/policies/base/kube-api-egress.yaml` |
| Factory loops and workers | kube-dns, then TCP 443 to the public internet minus private ranges, one policy per `factory.gwkline.io/profile` label. The orchestrator adds the API server node endpoint and knowledge retrieval | `allow-factory-*` beside each component in `deploy/factory/base/` |

## Enforcement and the start-up window

k3s's embedded kube-router installs a pod's firewall chain after the CNI has wired the pod. So a new pod's first ~0.5 s of traffic is not filtered: a probe in `sandbox` connected everywhere at t=0 and was blocked from t=0.5 s on (#324). After that every policy holds. A malicious image could open one connection at PID 1 start, before its policy applies. Factory workers clone and only then start the agent, seconds later, so prompt injection can't reach the window.

`egress-canary` (`deploy/policies/base/egress-canary.yaml`) checks enforcement every 30 minutes in `sandbox` and `work`. Its pod is selected only by `default-deny-egress`, since the public-only policies exclude `app.kubernetes.io/name=egress-canary`. After 5 s it tries `1.1.1.1:80`, the API VIP `10.43.0.1:443` and the LAN gateway `192.168.1.1:80`, and the Job fails if any of them connects. A failed `egress-canary-*` Job means egress policy is not enforced in that namespace.

## Required destinations

A sandbox pod must reach DNS, GitHub (git, codeload, API), a package registry, and a model API. `./scripts/egress-smoke.sh` runs this working tree's `examples/egress-smoke.mjs` in real pods in `sandbox` and `work` and proves those open and every private target closed, including the API server on the node's LAN address.

## Adding an exception

1. Put the allowance beside the workload's manifests, not in `deploy/policies/base`, so one `kubectl apply -k` brings up everything the workload needs.
2. Scope it with `podSelector` + `namespaceSelector` + ports. Never `ipBlock: 0.0.0.0/0`.
3. Run `./scripts/egress-smoke.sh`; add new required-destination classes to `examples/egress-smoke.mjs`.

## Decisions

- **Public-internet-minus-private-ranges, not SaaS IP lists:** SaaS IPs change without notice and a stale allowlist is an outage. If a destination can't be expressed this way, add an egress proxy rather than widening the netpol. `scripts/verify.sh` rejects any `ipBlock` CIDR under `deploy/` other than `0.0.0.0/0` and private/special ranges.
- **Factory workers reach any public HTTPS host** until a domain-allowlisting egress proxy (GitHub, the model provider, npm, PyPI, crates.io) replaces the CIDR rule.
- **Kubernetes API by node endpoint:** policy matches after DNAT, so an allowance for the Service VIP (`10.43.0.1`) never matches; allow the node's `:6443` instead. The node IP lives only in `clusters/home/node/node.yaml`. API allowances go in `deploy/policies/base/kube-api-egress.yaml` with the label `homelab.gwkline.io/kube-api-egress: "true"`, and kustomize writes the IP in.
- **`agents` has a baseline, not default-deny:** most of its workloads need only in-cluster services and the internet, which the baseline covers. Interactive agents (hermes, t3code) and anything holding credentials for an internal target get a per-workload allowlist and are listed out of `agents-egress-default`.
