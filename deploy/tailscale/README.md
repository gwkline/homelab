# Tailscale

The [Tailscale Kubernetes operator](https://tailscale.com/kb/1236/kubernetes-operator) puts cluster services on the tailnet. Tailnet identity is the auth layer for every UI here.

## What's here

| File | Purpose |
| --- | --- |
| `base/namespace.yaml` | `tailscale` namespace (operator + its `ts-*` proxy pods) |
| `base/operator-oauth.yaml` | ExternalSecret (via `ClusterSecretStore` `onepassword`) producing Secret `operator-oauth` |
| `values.yaml` | pinned helm values for the operator chart: operator and proxy image digests, operator resources, default proxy tag and ProxyClass |
| `proxyclass.yaml` | ProxyClass `homelab`: requests and limits for every proxy. Applied after helm, which installs the CRD |

## Install the operator

Prerequisite: External Secrets Operator is running and `ClusterSecretStore` `onepassword` (in `clusters/home`) is Ready.

```sh
kubectl apply -k deploy/tailscale/base # namespace + ExternalSecret -> Secret operator-oauth
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 \
  -n tailscale --create-namespace \
  -f deploy/tailscale/values.yaml
kubectl apply -f deploy/tailscale/proxyclass.yaml
```

- OAuth values are never passed to helm. With `oauth.clientId`/`clientSecret` empty, the chart mounts the pre-created Secret `operator-oauth` at `/oauth`.
- `proxyConfig.defaultTags` sets the operator's `PROXY_TAGS` to `tag:k8s-operator`. Do not set `PROXY_TAGS` via `operatorConfig.extraEnv` — it duplicates the env entry and the release fails.
- `proxyConfig.defaultProxyClass: homelab` applies `proxyclass.yaml` to every proxy. The operator creates no proxy until that ProxyClass exists, so apply it right after the helm install.
- The chart creates the `tailscale` IngressClass by default.
- `values.yaml` pins the operator and proxy images by digest to the chart's appVersion. Bump the tags and digests with `--version`, then re-run the `helm upgrade`.

1Password item: vault `homelab`, item `tailscale-operator-oauth`, fields `client_id` and `client_secret`. Scopes: Devices/Core + Auth Keys read-or-modify, Routes read. The OAuth client must be created **with** `tag:k8s-operator` (it cannot be added later).

Tailnet policy: `tagOwn## How exposure works

Every UI is a Tailscale Ingress in front of a ClusterIP Service: t3code-0, work-t3code-0, panel, grafana, headlamp, homepage, cloudbeaver and knowledge. The Ingress proxy terminates HTTPS with a tailnet cert and forwards (websockets included) to the Service, so pod restarts need no proxy changes. Ingress proxies run in userspace and are unprivileged. The tailnet hostname is `spec.tls[0].hosts[0]`.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    tailscale.com/tags: tag:k8s-operator # required by our OAuth client
spec:
  ingressClassName: tailscale
  defaultBackend:
    service:
      name: my-app # ClusterIP Service (not headless)
      port:
        number: 80
  tls:
    - hosts: [my-app] # -> https://my-app.<tailnet>.ts.net
```

Don't use `type: LoadBalancer` with `loadBalancerClass: tailscale`. Its proxy needs privileged containers (a `sysctler` init container plus a privileged `tailscale` container), which the namespace's baseline Pod Security rejects, and the Service allocates NodePorts. The executor Service is the one left; move it to an Ingress before deploying it.

`scripts/verify.sh` fails if a tailscale Ingress lacks the tags annotation or a TLS host, or a tailscale LoadBalancer Service lacks the hostname or tags annotation. `scripts/rebuild-check.sh` checks the same on the live cluster and curls each Ingress over HTTPS.

Moving an existing hostname from a LoadBalancer Service to an Ingress: switch the Service to ClusterIP first and wait for its `ts-<name>-*` proxy to disappear (the operator deletes the old device), then create the Ingress. Otherwise the new device registers as `<name>-1`.

Proxy pods carry `tailscale.com/parent-resource=<name>` and `tailscale.com/parent-resource-type=ingress|svc`. App NetworkPolicies admit them by namespace (`kubernetes.io/metadata.name: tailscale`).

Not done: per-UI tags and a ProxyGroup. Per-UI tags need `tagOwners` entries for each tag in the tailnet policy first; the policy is not in this repo. A ProxyGroup of type `ingress` would share one proxy set across all UIs (about 8 × 35Mi today), but it serves them as Tailscale Services, which need their own tailnet-policy approval.

spec: type: LoadBalancer loadBalancerClass: tailscale

```

`scripts/verify.sh` fails if a tailscale Ingress lacks the tags annotation or a TLS host, or a tailscale LoadBalancer Service lacks the hostname or tags annotation. `scripts/rebuild-check.sh` checks the same on the live cluster and curls each Ingress over HTTPS.

Proxy pods carry `tailscale.com/parent-resource=<name>` and `tailscale.com/parent-resource-type=ingress|svc`. App NetworkPolicies admit them by namespace (`kubernetes.io/metadata.name: tailscale`), which covers both proxy kinds.

## Tailnet DNS suffix

The suffix (e.g. `tailabc1234.ts.net`) is never committed — `scripts/verify.sh` rejects real `*.ts.net` names. Read it from any Ingress (`kubectl get ingress panel -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`), or set `TAILNET_NAME` in the shell. Homepage reads it from ConfigMap `agents/homepage-env` key `tailnet-name`, which is created on the cluster and never committed: `kubectl -n agents create configmap homepage-env --from-literal=tailnet-name=<tailnet>.ts.net`. The panel reads it from its own Ingress status unless `PANEL_TAILNET_NAME` is set.
```
