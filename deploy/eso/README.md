# External Secrets Operator

ESO syncs Kubernetes Secrets from the `homelab` 1Password vault via the 1Password SDK provider (no Connect server). `base/eso.yaml` is a vendored `helm template --include-crds` render of chart `external-secrets` 2.15.0, using checked-in `values.yaml` to digest-pin all three controller images and preserve resource bounds and security contexts. The previous bundle was chart 2.14.0, not 2.10.0.

This base holds the operator, plus `base/metrics.yaml`: a Service and NetworkPolicy that let VictoriaMetrics scrape the controller, so Grafana can alert on an ExternalSecret that isn't Ready. The single store, `ClusterSecretStore` `onepassword`, is in `deploy/github-tokens/base/secretstore.yaml` (part of `clusters/home`). Its `spec.conditions` lists the namespaces whose ExternalSecrets may use it; an ExternalSecret anywhere else is refused. The chart's RBAC remains cluster-wide; the store conditions restrict use of this provider, not the controller's Kubernetes permissions.

## Prerequisites

Secret `onepassword-service-account` (key `token`) in namespace `external-secrets`, and nowhere else. Create a 1Password service account restricted to the `homelab` vault, then run `scripts/create-onepassword-service-account.sh` after the operator is installed (token from env, stdin, or a hidden prompt; idempotent; server-side apply, so the token never lands in a `last-applied-configuration` annotation). Do not move this authority into workload namespaces or widen the allowed namespaces as part of an upgrade.

## Apply

ESO is not an automatic deployer target. After review and merge, an operator must apply both the updated ESO base and the store manifest. Server-side is required because two CRDs exceed the client-side annotation limit. Apply before `clusters/home`, after the PriorityClasses its pods use:

```sh
KUBECONFIG=~/kubeconfig-homelab kubectl apply -f deploy/policies/base/priorityclasses.yaml
KUBECONFIG=~/kubeconfig-homelab kubectl apply --server-side -k deploy/eso/base
KUBECONFIG=~/kubeconfig-homelab kubectl wait --for=condition=Established \
  crd/externalsecrets.external-secrets.io crd/clustersecretstores.external-secrets.io
KUBECONFIG=~/kubeconfig-homelab kubectl -n external-secrets rollout status deploy/external-secrets-webhook
KUBECONFIG=~/kubeconfig-homelab kubectl -n external-secrets rollout status deploy/external-secrets-cert-controller
KUBECONFIG=~/kubeconfig-homelab kubectl -n external-secrets rollout status deploy/external-secrets
KUBECONFIG=~/kubeconfig-homelab kubectl apply --server-side -f deploy/github-tokens/base/secretstore.yaml
```

`base/kustomization.yaml` remains authoritative for `homelab-platform` priority on all three deployments and the main controller's effective memory request/limit of `128Mi`/`768Mi`. The chart render retains its `64Mi`/`256Mi` memory values before those patches; do not drop the patches when regenerating the bundle.

## Verify

```sh
KUBECONFIG=~/kubeconfig-homelab kubectl get clustersecretstore onepassword
KUBECONFIG=~/kubeconfig-homelab kubectl get externalsecret -A
```

Check store readiness, each ExternalSecret's conditions and refresh time, and consumer health; a running pod or an existing target Secret alone does not prove current synchronization. This source update has no live-cluster verification or apply receipt.

## 1Password caching and quota recovery

The store explicitly opts into `onepasswordSDK.cache` with `ttl: "5m"` (duration string) and `maxSize: 128` (integer). Omitting the block disables successful-read caching; an empty block uses upstream defaults. This cache covers `GetSecret`/`GetSecretMap` reads, evicts least-recently-used entries when full, and invalidates relevant entries for writes/deletes. Cached values can be stale until their TTL expires; this does not change ExternalSecret refresh intervals or refresh credentials already loaded into a process environment.

The shared provider-client caching fix [#5894](https://github.com/external-secrets/external-secrets/pull/5894) shipped in [ESO v2.1.0](https://github.com/external-secrets/external-secrets/releases/tag/v2.1.0), so it was already present in both 2.10.0 and the previous 2.14.0 bundle. Upgrading to 2.15.0 is not a new fix for that bug and does not replenish an exhausted 1Password quota.

Five-minute successful-read caching can reduce duplicate reads in a reconciliation burst. It cannot reuse values across hourly refreshes, and failures (including 429, missing items and ambiguous fields) are not cached. Missing or ambiguous references therefore continue to create demand on retries. Do not infer an hourly/daily quota or reset time from ESO's error wording, and do not claim an upgrade alone cures 429s.

For recovery, the authorized operator must:

1. Inspect the existing service account's authoritative 1Password usage/quota and reset information in the account's administrative interface or obtain it from 1Password support. Capture the actual limit, window and reset time privately; repeated CLI probes also consume requests and are not a quota/reset authority.
2. Reconcile the inventory's intended item/field references with the existing vault authority. Resolve no-item matches by completing the intended real item or correcting an incorrect reference after review; resolve ambiguous field labels to the intended unique field. Console-minted credentials and changes to access authority require their owner. Keep the `work` boundary and token location unchanged.
3. Wait for the provider's authoritative reset, then verify the store and each failed ExternalSecret sync successfully and consumers use the intended values. Until synchronization succeeds, preserve existing ESO-owned target Secrets and running consumers.

Do not rotate a valid service-account token to evade quota, create placeholder or bridge Secrets, or restart consumers with missing authority data. An authentication error needs a separate owner-led authority repair; a 429 is not proof that the token is revoked or that its access is correct.

## Reproducible upgrade

Download an exact upstream chart archive and verify its provenance/hash separately. For the current version, from the repository root:

```sh
helm repo add external-secrets https://charts.external-secrets.io
helm pull external-secrets/external-secrets --version 2.15.0 --destination "$TMPDIR"
helm template external-secrets "$TMPDIR/external-secrets-2.15.0.tgz" \
  --namespace external-secrets --kube-version 1.34.0 --include-crds \
  --values deploy/eso/values.yaml > deploy/eso/base/eso.yaml
npx oxfmt --write deploy/eso/base/eso.yaml deploy/eso/values.yaml
ESO_CHART_ARCHIVE="$TMPDIR/external-secrets-2.15.0.tgz" \
  sh deploy/eso/tests/render.test.sh
```

The explicit Kubernetes version makes Helm capability-sensitive rendering independent of the local Helm default; rendering and `kubectl kustomize` do not contact the cluster. For a future version, update all three image tags/digests in `values.yaml` and the documented archive version together. Compare structured old/new resource inventories, all controller pod/container security contexts, effective resources/priority classes, controller arguments and RBAC rules/bindings, not only image strings. Preserve disabled optional subcharts/features, and validate the store cache against the new CRD schema before the manual apply.
