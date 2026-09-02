# Headlamp (deploy/headlamp/base)

The generic Kubernetes web UI for cluster operations — workloads, events, resource trees, logs, CPU/memory metrics. Headlamp is for inspecting the cluster; the bespoke panel (`deploy/panel/base`) stays the software-factory product UI. Upstream: https://headlamp.dev/

## Deployment

```sh
kubectl apply -k deploy/headlamp/base
```

The image is pinned to an upstream release tag (`ghcr.io/headlamp-k8s/headlamp:v0.45.0`). Bump it by editing `deployment.yaml` — Renovate does not manage kustomize manifests.

## Access

Tailnet-only, like every UI here:

```
https://headlamp.<tailnet>.ts.net
```

(`<tailnet>` is the DNS suffix discovered by `scripts/serve-https.sh` or set as `TAILNET_NAME` — never commit the real name; `scripts/verify.sh` rejects it. The panel's Dev Tools card links the same host with the `{tailnet}` placeholder resolved at runtime.)

## Security model (issue #40)

- **Reachability**: the Tailscale LoadBalancer Service (`service.yaml`) is the only ingress; central default-deny (`deploy/policies/base`) drops everything else. Tailnet identity is the auth layer.
- **API identity**: the backend runs with `-in-cluster -unsafe-use-service-account-token`, so every UI user acts as the pod's ServiceAccount. Upstream flags that option as UNSAFE unless the UI sits behind an auth proxy — the Tailscale proxy is that auth proxy.
- **RBAC** (`rbac.yaml`): `headlamp-readonly` ClusterRole, get/list/watch only — pods, pods/log, events, namespaces, nodes, services, configmaps, apps controllers, batch Jobs/CronJobs, and metrics.k8s.io. It cannot read Secret values, mutate workloads, exec/attach/portforward into pods, or use `nodes/proxy` / `services/proxy` (none of those are granted).
- **Egress** (`netpol.yaml`): narrowed to DNS and the Kubernetes API only, even though agents-namespace egress is otherwise open.
- Resources: 50m CPU / 128Mi requested, 512Mi memory limit — sized for the homelab hardware.

## Verification

1. Open `https://headlamp.<tailnet>.ts.net` from a tailnet device; from a non-tailnet host the name must not resolve at all.
2. Inspect a failed Job: pods, events, and logs should all render.
3. Forbidden actions fail with RBAC errors:

```sh
SA=system:serviceaccount:agents:headlamp
kubectl auth can-i --as=$SA get pods/log            # yes
kubectl auth can-i --as=$SA get secrets             # no
kubectl auth can-i --as=$SA create deployments.apps # no
kubectl auth can-i --as=$SA exec pods               # no
kubectl auth can-i --as=$SA get nodes/proxy         # no
```
