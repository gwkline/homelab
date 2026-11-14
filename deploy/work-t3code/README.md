# work-t3code

A second t3code instance for work repositories, in the `work` namespace. It uses the same image as [deploy/t3code](../t3code) but its own credential and a smaller blast radius. This repo is public, so it carries no work identifiers: the token and the repo list both live in 1Password.

## Isolation

- GitHub: the pod mounts only `work-github-token`, a fine-grained PAT limited to selected work repos (Contents + Pull requests read/write). No personal token is synced into `work`.
- Network: `work` is default-deny for ingress and egress. Egress allows DNS and the public internet only: no Kubernetes API, LAN, tailnet, or homelab services. Ingress comes only from the Tailscale proxy.
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

### Disk and build backpressure

The work container requests 4 GiB of memory and has a 12 GiB limit. All agent sessions, local development services and package managers share that budget. Native pnpm processes can consume over 5 GiB alone; Node heap defaults are not a substitute for a whole-pod budget that leaves room for the server and other active processes. These limits remain work-only and do not grant cluster credentials or broader network access. A higher cap is not per-build isolation: inspect real native-process and cgroup peaks if memory pressure recurs.

Only this workload enables the shared image's resource guard. The entrypoint starts as a supervisor before repository sync or state restoration, and waits for at least 22 GiB of backing-filesystem headroom, independently of the larger build budget. It stops the container below 20 GiB, preserving workspace files rather than deleting them. These are cooperative operating watermarks, not a hard local-path PVC quota: claim sizes do not cap the shared ext4 filesystem. A stopped container cannot leave detached PTY builds writing behind it.

Generated command shims serialize heavy npm/npx/pnpm/yarn/bun/uv/cargo/make/docker/depot commands that are installed, using one shared lock across work threads. Heavy builds need 25 GiB free; between 22 and 25 GiB the interface remains available while builds are refused. Read-only queries pass through. Wrapped builds default to two Cargo jobs and a 3 GiB Node heap only when the caller has not already supplied settings; the existing cgroup memory limit remains authoritative. Direct binaries, deliberate bypasses, and remote builders remain limitations. Full semantics and regression tests are in [the guard documentation](../../apps/shared/work-resource-guard.md).

If startup is waiting for headroom, inspect node filesystem usage and the guard logs. Remove only verified generated artifacts after preserving dirty/unpushed source; do not clear the entire state PVC. For T3's own cleanup settings, prefer merged-only worktree cleanup with the strongest local-file protection, scoped to this project, after verifying the remote server supports the controls. Whole-worktree cleanup is not selective build-cache cleanup.

- Adding a repo or rotating a token is all done in 1Password: widen the PAT's repository access, then update `token` and/or `repos`. ESO syncs within an hour. Env vars only change on a new pod: `kubectl -n work rollout restart statefulset work-t3code`.
- Codex login: run `codex login` in the pod, then `kubectl -n work port-forward work-t3code-0 1455:1455` and open the printed URL locally. Workspace-managed ChatGPT accounts may be rejected by org policy (`token_exchange_failed`). Fallbacks: a personal account, `codex login --device-auth`, or an API key.
