# Retire Homepage

Panel is the landing page at `https://panel.<tailnet>.ts.net`. Homepage is no longer in the core manifests. Applying kustomize does **not** delete removed objects; the integration operator must retire them explicitly after the retirement and Panel changes are merged and verified.

## Before deleting anything

1. Fetch fresh merged `main`. Run `./scripts/verify.sh` and `sh deploy/policies/tests/landing-page.test.sh`. Verify the Panel registry has no Homepage tile and the real Panel page renders; factory, knowledge and dev-tool links work.
2. Use the explicit homelab kubeconfig, verified LAN API and a bounded request timeout from [the cluster runbook](runbook-server-cluster.md). Probe the API port first. Never target the current default context implicitly.
3. Privately save the old rendered Homepage base, the three existing ingress NetworkPolicies below and ConfigMap `agents/homepage-env`. Do not export Kubernetes Secrets. Record the Homepage Ingress UID, its hostname and the operator proxy/node identity for withdrawal verification.
4. Check every live pod and workload template for `homepage-env` references, including env, envFrom, projected volumes and ConfigMap volumes. Homepage used emptyDir only: no PVC or user/work data belongs to this retirement.

## Preserve shared runtime config

The undeployed Executor formerly referenced `agents/homepage-env`; its manifest now reads `agents/tailnet-env` with the same `tailnet-name` key. Panel reads its own Ingress status, not this ConfigMap.

If the old ConfigMap exists, preserve its runtime data privately and copy it to `agents/tailnet-env` before deleting the old name. If `tailnet-env` already exists, compare it first and do not overwrite conflicting data. If Executor was deployed out of band, migrate its reference using the merged manifest and verify the new browser origin before removal. Keep `homepage-env` until **all** other consumers are migrated; deletion is conditional, not a requirement to break a shared consumer. No 1Password item or shared credential changes.

## Exact managed resources

Delete only these names in `agents`, in this order:

1. Ingress `homepage`. Let `tailscale.com/finalizer` finish; it withdraws the tailnet device and cleans up the operator proxy. Do not strip the finalizer or manually delete the proxy Secret first.
2. Deployment `homepage`, with foreground cascading deletion. Its ReplicaSets and pods should be garbage-collected, including old evicted pods.
3. Service `homepage`. Verify its Endpoints and EndpointSlices disappear.
4. NetworkPolicy `allow-tailscale-to-homepage`.
5. ConfigMap `homepage-config`.
6. ConfigMap `homepage-env`, **only after** the runtime-config checks above pass.

Apply the merged definitions for the existing NetworkPolicies (updates, not deletions):

| Namespace | NetworkPolicy | Source file |
| --- | --- | --- |
| agents | `allow-tailscale-to-panel` | `deploy/panel/base/service.yaml` (also includes unchanged Panel Service/Ingress) |
| agents | `allow-tailscale-to-t3code` | `deploy/t3code/base/netpol.yaml` (also includes unchanged egress policy) |
| work | `allow-to-work-t3code` | `deploy/work-t3code/base/netpol.yaml` |

These remove only the Homepage siteMonitor exceptions. Keep Panel's identity-gated proxy port, factory snapshot and Executor callers, and both coding runners' tailnet ingress and existing egress restrictions.

## Operator leftovers and verification

Discover the exact proxy objects by all three labels in `tailscale`: `tailscale.com/parent-resource=homepage`, `tailscale.com/parent-resource-ns=agents`, `tailscale.com/parent-resource-type=ingress`. The integration handoff includes the names observed before retirement. Names may change, so re-check labels and parent identity before any fallback cleanup.

Wait for the operator to remove its Homepage StatefulSet, pod, headless Service, Secret, ControllerRevisions, Endpoints and EndpointSlices. Verify the recorded tailnet node is absent in the Tailscale device inventory and the old HTTPS endpoint no longer serves Homepage. A stale local DNS/cache entry alone does not prove a device remains. If the Ingress finalizer stalls or proxy objects remain, diagnose the operator and its OAuth/device-delete access; stop rather than stripping finalizers, pruning all `ts-*` resources or uninstalling the operator. No broad selector deletion, namespace deletion or global prune.

Verify the managed names and their owned descendants are absent, the three updated policies have no Homepage caller, Panel HTTPS and its main flows still work, and active manifests/docs/scripts have no dangling Homepage references. This runbook, negative retirement tests and clearly historical ADR budget figures are intentional references. No Homepage-specific RBAC, ExternalSecret, credential, PVC or image-build job exists to delete; retain shared Secrets, OAuth credentials, ProxyClass, IngressClass and all work/user PVCs.

## Rollback

Revert the retirement commit through a reviewed, green-CI PR; never apply an old whole-cluster root. Restore the saved `homepage-env` data privately, then apply only the restored Homepage base and the three restored NetworkPolicy definitions. Preserve `tailnet-env` for any migrated consumers. The operator recreates the Homepage proxy/device from its Ingress and retained OAuth credential; wait for the old hostname to be withdrawn first to avoid a suffixed duplicate. Re-check Homepage HTTPS and Panel after restoration. Homepage's former emptyDir config is reproducible from its ConfigMap; there is no lost persistent data to restore.
