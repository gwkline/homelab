# work-t3code

A second t3code instance for work repositories, in the `work` namespace. It uses the same image as [deploy/t3code](../t3code) but its own credential and a smaller blast radius. This repo is public, so it carries no work identifiers: the token and the repo list both live in 1Password.

## Isolation

- GitHub: the pod mounts only `work-github-token`, a fine-grained PAT limited to selected work repos (Contents + Pull requests read/write). No personal token is synced into `work`.
- Network: `work` is default-deny for ingress and egress. Egress allows DNS and the public internet only: no Kubernetes API, LAN, tailnet, or homelab services. Ingress comes only from the Tailscale proxy and the Homepage siteMonitor.
- No ServiceAccount token, no skills-sync, no Executor.
- PVCs are not backed up. Losing the node means re-pairing the browser and logging into the CLIs again.

## Prerequisites (1Password, vault `homelab`)

| Item | Field(s) | Notes |
| --- | --- | --- |
| `work-github-writer` | `token`, `repos` | PAT with "Only select repositories" access, never all repos. `repos` holds clone URLs, one per line, matching the PAT's scope. Required. |
| `work-claude-oauth` | `token` | Output of `claude setup-token` run on a logged-in machine (the in-pod login can't complete headless). Required. |
| `work-depot-token` | `token` | Depot org token for `depot bake`. Optional. |

They sync through `ClusterSecretStore` `onepassword`, whose conditions include `work`; no 1Password credential lives in this namespace.

## Apply

Part of `clusters/home`; the deployer keeps the StatefulSet on the latest image. Standalone: `kubectl apply -k deploy/work-t3code/base`. Then pair from `https://work-t3code-0.<tailnet>.ts.net`.

## Verify

```sh
kubectl get externalsecret -n work
kubectl -n work rollout status statefulset work-t3code
kubectl -n work exec work-t3code-0 -- gh api repos/gwkline/homelab --jq .name   # must fail (404)
kubectl -n work exec work-t3code-0 -- ls /data/repos
```

## Operations

- Adding a repo or rotating a token is all done in 1Password: widen the PAT's repository access, then update `token` and/or `repos`. ESO syncs within an hour. Env vars only change on a new pod: `kubectl -n work rollout restart statefulset work-t3code`.
- Codex login: run `codex login` in the pod, then `kubectl -n work port-forward work-t3code-0 1455:1455` and open the printed URL locally. Workspace-managed ChatGPT accounts may be rejected by org policy (`token_exchange_failed`). Fallbacks: a personal account, `codex login --device-auth`, or an API key.
