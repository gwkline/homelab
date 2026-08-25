# Tailscale deployment in the homelab cluster

Two components: the **Tailscale Kubernetes operator** (provisions proxy pods
for LoadBalancer services) and the **serve-fixer** (works around an operator
limitation).

## Operator install (rebuild)

```sh
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  -n tailscale --create-namespace \
  --set oauth.clientId="$TS_CLIENT_ID" \
  --set oauth.clientSecret="$TS_CLIENT_SECRET"
```

Credentials: Gavin's macOS Keychain, service `homelab-tailscale`
(`client-id`, `client-secret` items). The OAuth client must have the tag
`tag:k8s-operator` assigned at generation time (cannot be added later —
regenerate if missed), scopes: Devices/Core + Auth Keys read-or-modify,
Routes read. Tailnet policy needs:

```jsonc
"tagOwners": { "tag:k8s-operator": ["autogroup:member"] }
```

## Known chart bug (1.102.3) and workaround

The chart hardcodes `PROXY_TAGS=tag:k8` for proxy devices, and
`operatorConfig.defaultTags` does NOT override that env (it feeds a
ProxyClass instead). `--set operatorConfig.extraEnv[...]` produces a
**duplicate** env entry → server-side apply fails with "expected string, got
unstructured list", leaving the Helm release in `failed`.

Workaround (documented, deliberate):

```sh
kubectl -n tailscale set env deploy/operator PROXY_TAGS=tag:k8s-operator
kubectl -n tailscale rollout restart deploy/operator
```

Additionally, any Service exposed via the operator should carry
`tailscale.com/tags: tag:k8s-operator` (see `deploy/t3code/base/service.yaml`)
so its proxy devices are tagged correctly regardless of the env default.

Retry-with-fix after a failed upgrade: because SSA recorded the failed
attempt, prefer `helm uninstall` + fresh `--install`, then re-apply the env
override. Do NOT use `proxyConfig.defaultTags` values on this chart version.

## Exposing a service

```yaml
metadata:
  annotations:
    tailscale.com/hostname: my-service        # -> my-service.<tailnet>.ts.net
    tailscale.com/tags: tag:k8s-operator      # required by our OAuth client
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
```

## serve-fixer (deploy/tailscale/serve-fixer*.yaml)

The operator writes the proxy's serve config once with the app pod's IP and
does not refresh it when the StatefulSet pod is replaced → 502s after every
rollout. The serve-fixer Deployment notices pod-IP drift within ~30s and
re-applies `tailscale serve --bg --http=80 http://<pod-ip>:3773` in the proxy.

**Removal trigger:** when an operator release refreshes serve config on pod
replacement (test: restart t3code-0, watch LB URL stay 200 without fixer),
delete this directory.
