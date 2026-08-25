# Tailscale operator

Exposes cluster Services directly to the tailnet with automatic HTTPS
(`https://t3code-0.<tailnet>.ts.net`). Install once on the control-plane node.

## Install

1. Create an OAuth client at https://login.tailscale.com/admin/settings/oauth
   (scopes: none needed beyond defaults; note client ID and secret).

2. Install via Helm:

```sh
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm repo update

helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --namespace tailscale --create-namespace \
  --set-string oauth.clientId="<CLIENT_ID>" \
  --set-string oauth.clientSecret="<CLIENT_SECRET>"
```

3. Any Service of `type: LoadBalancer` with `loadBalancerClass: tailscale`
   now gets a MagicDNS name. See `../t3code/base/service.yaml` for the pattern.
