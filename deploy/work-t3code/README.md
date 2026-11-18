# work-t3code

A second t3code instance for work repositories, in the `work` namespace. It uses the same image as [deploy/t3code](../t3code) but its own credential and a smaller blast radius. This repo is public, so it carries no work identifiers: the token and the repo list both live in 1Password.

## Isolation

- GitHub: the pod mounts only `work-github-token`, a fine-grained PAT limited to selected work repos (Contents + Pull requests read/write). No personal token is synced into `work`.
- Network: `work` is default-deny for ingress and egress. Egress allows DNS and public internet, plus the exact node's mTLS Docker API (2376) and authenticated fixed guest-service relay (2377). No Kubernetes API, other LAN/tailnet or personal-service access. Ingress comes only from the Tailscale proxy. The host independently filters Docker traffic by expiring ready work-pod identity ([runtime](../work-docker-vm)).
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

## Storage

`/data` and `/home/node/.t3` use separate pre-bound local claims on the mounted SSD at `/srv/work-docker/work-t3code/{data,t3state}`. Both PVs have `Retain`. The declared 60/40 GiB capacities are scheduling metadata, not filesystem quotas. The guard measures the actual `/data` backing filesystem, including VM growth on that same SSD; its 22/25/20 GiB watermarks are unchanged. Original claims and original data stay on root as rollback copies: copying them does **not** free root space. Neither work volume is included in personal backups.

### Copy-and-switch maintenance

Use an isolated checkout of merged, green main. Do not change a live PV's source or patch StatefulSet `volumeClaimTemplates`: both are immutable. Do not prune either old claim.

1. Inventory the actual old PV paths/claim UIDs, all Git roots (including managed worktrees), dirty/untracked/ignored work, auth hashes, environment identity, SQLite/session state, replicas and deployer suspension. Keep this evidence private. Verify the intended SSD UUID with `findmnt --mountpoint`; it must be a separate filesystem. Its unmounted underlying directory must remain empty: never use `DirectoryOrCreate` or a fallback mkdir on root.
2. Supply a private, root-owned JSON file to `migrate-storage.py`: `mount`, `uuid`, and exactly two `volumes` entries with `source` (the discovered old local-PV directory) and `destination` (the new data/t3state paths above). The script never formats anything or edits Kubernetes. Audit paths must be outside the copies but on the verified SSD. Optional `precopy` can run live; it does not delete. Budget the whole copy plus retained precopy versions and VM headroom before starting.
3. Suspend the deployer, recording its original state, and gracefully scale **only** work-t3code to zero. Confirm its pod is gone and no writer survives. `final` independently rejects RW source mounts/writable descriptors via host procfs; inability to inspect a process is a failure, not an exemption. Run `final`, then `verify`. These use numeric IDs, sparse files, hardlinks, ACLs, xattrs and full checksums. Stale new-copy entries/previous versions are retained in the private audit, never removed from the source. Both checksum/metadata dry-run logs must be completely empty before switching.
4. Manually apply the merged `ssd-storage.yaml` prerequisites with the base's common labels; verify both new claims Bound to the intended PVs/node/paths. With work still stopped, orphan-delete only its StatefulSet controller (not any PVC), then recreate the merged StatefulSet at zero replicas with the deployer's resolved **signed immutable** image. Keep security, credentials, service and internal paths unchanged. The regular deployer cannot perform this immutable-controller transition.
5. Before restarting, compare Git/source/auth/environment/SQLite identity through the copied mounts. Restore the original replica count, run the managed deployer, then verify actual SSD-backed read/write/fsync, disposable Git operations, state integrity and both T3 HTTPS routes. Restore original deployer suspension. Remove exact temporary helpers and verify absence. Keep the private audit and both old claims/copies; no automatic cleanup is part of this procedure.

Rollback: suspend deployment and stop work again, preserve any post-switch new work, recreate only the controller from the saved old manifest and signed image using the old claims, restore replicas/suspension and reverify identities. Never overwrite either copy or revert new Git work blindly.

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
