# Tailscale deployment in the homelab cluster

Two components: the **Tailscale Kubernetes operator** (provisions proxy pods for LoadBalancer services) and the **serve-fixer** (works around an operator limitation).

## Operator install (rebuild)

```sh
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  -n tailscale --create-namespace \
  --set oauth.clientId="$TS_CLIENT_ID" \
  --set oauth.clientSecret="$TS_CLIENT_SECRET"
```

Credentials: Gavin's macOS Keychain, service `homelab-tailscale` (`client-id`, `client-secret` items). The OAuth client must have the tag `tag:k8s-operator` assigned at generation time (cannot be added later — regenerate if missed), scopes: Devices/Core + Auth Keys read-or-modify, Routes read. Secrets are passed via `--set` only — never commit them.

## Tailnet policy requirements (tag owners / ACLs)

The policy file must own the operator tag and let tag-carrying proxies serve:

```jsonc
"tagOwners": {
  // who may assign the tag; the OAuth client itself must be created WITH
  // this tag (cannot be added later — regenerate if missed)
  "tag:k8s-operator": ["autogroup:member"]
}
```

- ACLs must allow devices tagged `tag:k8s-operator` (the operator's proxy pods) to reach the exposed services' ports; tailnet identity is the auth layer for every UI here.
- Exposed Services tag their proxies via the required `tailscale.com/tags: tag:k8s-operator` annotation (below).

## Known chart bug (1.102.3) and workaround

The chart hardcodes `PROXY_TAGS=tag:k8` for proxy devices, and `operatorConfig.defaultTags` does NOT override that env (it feeds a ProxyClass instead). `--set operatorConfig.extraEnv[...]` produces a **duplicate** env entry → server-side apply fails with "expected string, got unstructured list", leaving the Helm release in `failed`.

Workaround (documented, deliberate):

```sh
kubectl -n tailscale set env deploy/operator PROXY_TAGS=tag:k8s-operator
kubectl -n tailscale rollout restart deploy/operator
```

Additionally, any Service exposed via the operator should carry `tailscale.com/tags: tag:k8s-operator` (see `deploy/t3code/base/service.yaml`) so its proxy devices are tagged correctly regardless of the env default.

This workaround is **pinned and tested**, not optional:

- `scripts/verify.sh` fails if any built Service with `loadBalancerClass: tailscale` is missing the annotations below, so the service-level tags stay the source of truth in git.
- `scripts/rebuild-check.sh` asserts the live operator still runs with `PROXY_TAGS=tag:k8s-operator` (section 7) and that every exposed Service in the cluster carries the annotations (section 6).

## Exposing a service

Both annotations are **required** on every LoadBalancer Service with `loadBalancerClass: tailscale` (enforced by `scripts/verify.sh`):

```yaml
metadata:
  annotations:
    tailscale.com/hostname: my-service # -> my-service.<tailnet>.ts.net
    tailscale.com/tags: tag:k8s-operator # required by our OAuth client
spec:
  type: LoadBalancer
  loadBalancerClass: tailscale
```

## The one tailnet configuration value

The tailnet DNS suffix (e.g. `tailabc1234.ts.net`) is never hard-coded in scripts, manifests, or UI configs — `scripts/verify.sh` rejects any committed `*.ts.net` name. It comes from exactly one of:

1. **Discovered**: the operator-assigned LB hostname of an exposed Service (`kubectl get svc t3code-0 -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'` — strip the leading `<hostname>.`). `scripts/serve-https.sh` does this automatically.
2. **Provided**: set `TAILNET_NAME` in the environment (shell) or `homepage-env` ConfigMap key `tailnet-name` (deployed, wired into Homepage as `HOMEPAGE_VAR_TAILNET_NAME` so its service links resolve without editing per-service hrefs).

Retry-with-fix after a failed upgrade: because SSA recorded the failed attempt, prefer `helm uninstall` + fresh `--install`, then re-apply the env override. Do NOT use `proxyConfig.defaultTags` values on this chart version.

## serve-fixer (deploy/tailscale/serve-fixer*.yaml)

The operator writes the proxy's serve config once with the app pod's IP and does not refresh it when the StatefulSet pod is replaced → 502s after every rollout. The serve-fixer Deployments notice pod-IP drift within ~30s and re-apply `tailscale serve` in the proxy (`scripts/serve-retest.sh` checks whether a newer operator still needs this).

### Least privilege (issue #32)

Each fixer has its **own** ServiceAccount and Role so the two mechanisms are independently revocable:

- **t3code** (`serve-fixer`): the loop selects the proxy pod via the operator's own `tailscale.com/parent-resource` labels plus a name guard, so it can only ever exec into the t3code proxy — never the operator pod or another service's proxy. Its `agents`-namespace read is `resourceNames`-pinned to the `t3code-0` pod.
- **panel** (`panel-serve-fixer`): same scoping for the panel proxy; its app IP is read from the `panel` Service's Endpoints object (name-pinned) instead of listing pods.
- Both Roles dropped `pods/log`; the only write verb is `pods/exec create`. Both containers run non-root (uid 1000) with a read-only root filesystem, dropped capabilities, RuntimeDefault seccomp, and a digest-pinned image (tag-swap compromise impossible).

**Residual risk (documented, deliberate):** `create pods/exec` in the `tailscale` namespace cannot be scoped by RBAC to one pod — the operator names proxy StatefulSets via `GenerateName` (`ts-<parent>-<rand>`, see `reconcileHeadlessService` in the operator source), so RBAC `resourceNames` cannot pin the exec target. A compromised fixer image could therefore exec into unrelated operator/proxy pods in that namespace (it cannot create/delete/patch pods, touch secrets, read `pods/log`, or read any pod outside `tailscale` beyond the pinned app pod). Compensating controls: digest-pinned image, non-root + read-only rootfs, label+name-guarded selection, and the split SAs above. The image is the repo's loop-agent build rather than a minimal kubectl image; swapping in a minimal image later only requires bumping the digest.

### Retesting whether the workaround is still necessary

- `scripts/serve-retest.sh` — disables the fixer, replaces the t3code-0 pod, and watches the proxy's serve config: exit 0 = operator self-heals (workaround obsolete — delete this directory), exit 3 = workaround still necessary, exit 1 = environment failure. It restores the fixer and re-verifies HTTPS 200 either way.
- `scripts/serve-fixer-check.sh` — static manifest checks (digest pins, no `pods/log`, non-root settings, name-pinned reads) plus, against a live cluster with an impersonating kubeconfig, the RBAC matrix (may touch only its own target; denied elsewhere).

**Removal trigger:** when an operator release refreshes serve config on pod replacement (test: `scripts/serve-retest.sh` exits 0), delete this directory.
