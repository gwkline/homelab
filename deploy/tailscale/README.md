# Tailscale deployment in the homelab cluster

Two components: the **Tailscale Kubernetes operator** (provisions proxy pods for LoadBalancer services) and the **serve-fixer** (works around an operator limitation).

## Operator install (rebuild)

The operator's OAuth credential lives in 1Password and is synced into the cluster by External Secrets — the helm command carries references only, never OAuth values (issue #43). Prerequisite: External Secrets Operator is running and the hand-entered `onepassword-service-account` token exists in this namespace (issue #41).

```sh
kubectl apply -k deploy/tailscale # namespace + SecretStore + ExternalSecret -> Secret operator-oauth
helm repo add tailscale https://pkgs.tailscale.com/helmcharts
helm upgrade --install tailscale-operator tailscale/tailscale-operator \
  --version 1.102.3 \
  -n tailscale --create-namespace \
  -f deploy/tailscale/values.yaml
```

Mechanisms confirmed against the chart v1.102.3 source (`cmd/k8s-operator/deploy/chart`):

- **Existing-Secret mode**: with `oauth.clientId`/`oauth.clientSecret` unset, the chart creates no Secret and mounts the pre-created Secret `operator-oauth` (name hardcoded in `templates/deployment.yaml`) at `/oauth`, read via `CLIENT_ID_FILE=/oauth/client_id` and `CLIENT_SECRET_FILE=/oauth/client_secret`. The ExternalSecret produces exactly that shape; the chart would only create `operator-oauth` itself if `oauth.clientId` were set.
- **Proxy tags**: `templates/deployment.yaml` sets `PROXY_TAGS` directly from `proxyConfig.defaultTags` (chart default `"tag:k8s"`), so `deploy/tailscale/values.yaml` pins `tag:k8s-operator` — the old out-of-band `kubectl set env` workaround is removed.

## 1Password item contract (issue #43)

| | |
| --- | --- |
| vault | `homelab` |
| item | `tailscale-operator-oauth` — fields `client_id`, `client_secret` |
| scopes | Devices/Core + Auth Keys read-or-modify, Routes read |
| tags | the OAuth client must be created WITH `tag:k8s-operator` (cannot be added later — regenerate if missed) |

Reinstalling the operator from a clean cluster requires only the 1Password bootstrap token (`onepassword-service-account`, issue #41); everything else here is declarative.

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

## Operator credential rotation (tested drill, issue #43)

1. Create a NEW OAuth client with the same tag + scopes (the old one keeps working until deleted) and update the `tailscale-operator-oauth` fields in 1Password. Do not delete the old client until step 4 passes.
2. Sync now instead of waiting out the 1h refresh:
   `kubectl -n tailscale annotate externalsecret operator-oauth external-secrets.io/force-sync="$(date +%s)" --overwrite`
3. Restart the operator to re-read the mounted Secret:
   `kubectl -n tailscale rollout restart deploy/operator`
4. Verify nothing was orphaned: `kubectl get statefulset -n tailscale` — existing proxy StatefulSets (`ts-*`) are NOT recreated or deleted; the operator pod goes Ready on the new credential; the exposed LB URL still returns 200 (`scripts/rebuild-check.sh` section 5) and the operator still reports `PROXY_TAGS=tag:k8s-operator` (section 7).

Why rotation does not orphan proxies: rotation only swaps the operator's control-plane credential. Proxy devices are long-lived StatefulSets keyed by each Service's `tailscale.com/hostname` annotation and tagged `tag:k8s-operator`; as long as the new client can assume the same tag (same tagOwners), the operator reconnects to and keeps reconciling the existing devices. Orphaning only happens if the tag ownership changes or the Secret/item/field names drift — keep the contract above fixed.

## Known chart constraints (1.102.3, verified from chart source)

- `PROXY_TAGS` comes from `proxyConfig.defaultTags` — pinned in `deploy/tailscale/values.yaml`; no out-of-band patch.
- `operatorConfig.defaultTags` maps to `OPERATOR_INITIAL_TAGS` (the operator device's own tag) and does NOT touch proxy tags.
- `operatorConfig.extraEnv` is appended after the fixed env block, so putting `PROXY_TAGS` there creates a duplicate env entry → server-side apply fails with "expected string, got unstructured list", leaving the Helm release in `failed`. This was the origin of the old "chart bug" report.

Additionally, any Service exposed via the operator should carry `tailscale.com/tags: tag:k8s-operator` (see `deploy/t3code/base/service.yaml`) so its proxy devices are tagged correctly regardless of the env default.

This stays pinned and enforced, not optional:

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

Retry-with-fix after a failed upgrade: because SSA recorded the failed attempt, prefer `helm uninstall` + fresh `--install` with `-f deploy/tailscale/values.yaml`. Do NOT inject `PROXY_TAGS` via `operatorConfig.extraEnv` (duplicate env entry, see above).

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
