# GitHub tokens

ExternalSecrets that sync GitHub PATs from the `homelab` 1Password vault, plus `ClusterSecretStore` `onepassword`, the one store every ExternalSecret uses (`secretstore.yaml`; its `conditions` list the namespaces allowed to use it). ESO owns the Secrets (`creationPolicy: Owner`), so manual edits get reverted.

## 1Password items

| Item | Field(s) | Secret | Namespaces | PAT scope |
| --- | --- | --- | --- | --- |
| `github-readonly` | `token` | `github-token` | agents, sandbox | Contents: read on private repos agents read |
| `github-writer` | `token` | `github-token-writer` | sandbox | Contents + Pull requests: write on target repos only. Optional; consumers mount it `optional: true` |
| `work-github-writer` | `token`, `repos` | `work-github-token` | work | Contents + Pull requests: read/write on selected work repos only. `repos` holds clone URLs, one per line |

The read and write tokens are separate items with separate permissions.

## Prerequisites

ESO and Secret `external-secrets/onepassword-service-account` ([deploy/eso](../eso/README.md)).

## Apply

Part of `clusters/home`. Standalone: `kubectl apply -k deploy/github-tokens/base`.

## Verify

```sh
kubectl get clustersecretstore,externalsecret -A    # all Ready (github-token-writer may be False if the item is absent)
kubectl -n agents exec hermes-0 -- gh api user -q .login
```

## Rotation

Update the item in 1Password. Secret data changes within about 1h 6m (1h refresh plus a 5m SDK cache), and mounted files follow about a minute later. Env-var readers only pick up the change on a new pod. CronJobs get one on their next run. For long-running workloads:

```sh
kubectl -n agents rollout restart statefulset hermes t3code
kubectl -n agents rollout restart deploy panel
```
