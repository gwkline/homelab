# Tailscale

The [Tailscale Kubernetes operator](https://tailscale.com/kb/1236/kubernetes-operator) puts cluster services on the tailnet. Tailnet identity is the auth layer for every UI here.

## What's here

| File | Purpose |
| --- | --- |
| `namespace.yaml` | `tailscale` namespace (operator + its `ts-*` proxy pods) |
| `secretstore.yaml`, `operator-oauth.yaml` | 1Password SecretStore + ExternalSecret producing Secret `operator-oauth` |
| `values.yaml` | pinned helm values for the operator chart |

## Install the operator

Prerequisite: External Secrets Operator is running and the hand-entered `onepassword-service-account` Secret exists in this namespace.

```sh
kubectl apply -k deploy/tailscale # namespace + SecretStore + ExternalSecret -> Secret operator-oauth
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 \
  -n tailscale --create-namespace \
  -f deploy/tailscale/values.yaml
```

- OAuth values are never passed to helm. With `oauth.clientId`/`clientSecret` empty, the chart mounts the pre-created Secret `operator-oauth` at `/oauth`.
- `proxyConfig.defaultTags` sets the operator's `PROXY_TAGS` to `tag:k8s-operator`. Do not set `PROXY_TAGS` via `operatorConfig.extraEnv` — it duplicates the env entry and the release fails.
- The chart creates the `tailscale` IngressClass by default.
- `values.yaml` pins the operator and proxy images by digest to the chart's appVersion. Bump the tags and digests with `--version`, then re-run the `helm upgrade`.

1Password item: vault `homelab`, item `tailscale-operator-oauth`, fields `client_id` and `client_secret`. Scopes: Devices/Core + Auth Keys read-or-modify, Routes read. The OAuth client must be created **with** `tag:k8s-operator` (it cannot be added later).

Tailnet policy: `tagOwners` must own `tag:k8s-operator`, ACLs must let tailnet users reach devices with that tag, and MagicDNS + HTTPS certificates must be enabled.

Rotating the credential: create a new OAuth client with the same tag and scopes, update the 1Password fields, then `kubectl -n tailscale annotate externalsecret operator-oauth external-secrets.io/force-sync="$(date +%s)" --overwrite` and `kubectl -n tailscale rollout restart deploy/operator`. Existing proxies are keyed by hostname and keep working; delete the old client once `scripts/rebuild-check.sh` passes.

## How exposure works

**HTTP UIs (t3code-0, work-t3code-0, panel): Tailscale Ingress.** The Ingress proxy terminates HTTPS with a tailnet cert and forwards (websockets included) to the backend Service's ClusterIP, so pod restarts need no proxy changes. The tailnet hostname is `spec.tls[0].hosts[0]`.

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
        number: 8080
  tls:
    - hosts: [my-app] # -> https://my-app.<tailnet>.ts.net
```

**LoadBalancer Services (grafana, headlamp, homepage, executor, cloudbeaver, knowledge).** `type: LoadBalancer` + `loadBalancerClass: tailscale` gives a tailnet device that forwards TCP to the Service; the operator does not terminate TLS for these.

```yaml
metadata:
  annotations:
    tailscale.com/hostname: my-service # -> my-service.<tailnet>.ts.net
    tailscale.com/tags: tag:k8s-operator
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
```

`scripts/verify.sh` fails if a tailscale Ingress lacks the tags annotation or a TLS host, or a tailscale LoadBalancer Service lacks the hostname or tags annotation. `scripts/rebuild-check.sh` checks the same on the live cluster and curls each Ingress over HTTPS.

Proxy pods carry `tailscale.com/parent-resource=<name>` and `tailscale.com/parent-resource-type=ingress|svc`. App NetworkPolicies admit them by namespace (`kubernetes.io/metadata.name: tailscale`), which covers both proxy kinds.

## Tailnet DNS suffix

The suffix (e.g. `tailabc1234.ts.net`) is never committed — `scripts/verify.sh` rejects real `*.ts.net` names. Read it from any Ingress (`kubectl get ingress panel -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'`), or set `TAILNET_NAME` in the shell and the `homepage-env` ConfigMap key `tailnet-name`. The panel reads it from its own Ingress status unless `PANEL_TAILNET_NAME` is set.
