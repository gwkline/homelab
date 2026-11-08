# Work resource guard

`work_resource_guard.py` is Python 3.9+ standard-library-only code for Linux and macOS. It provides **cooperative filesystem headroom backpressure**, not a hard PVC quota, security boundary, or memory limit. It never deletes workspace/source, caches, benchmarks, credentials, lock files, or other data.

## Activation and wiring

Both environment variables must match exactly:

```sh
export WORK_RESOURCE_GUARD=1
export WORK_RESOURCE_SCOPE=work
```

Set them only in the work workload; do not set them in a shared base, global shell profile, or personal workload. Disabled or differently scoped invocations directly exec the original command, without validating guard configuration or modifying build environment options. A plain server command may still launch unwrapped builds; install the selected command shims separately in the work image/PATH.

Supervisor example (the real server entrypoint belongs after `--`):

```sh
exec python3 /usr/local/lib/work_resource_guard.py run -- \
  /usr/local/bin/node /app/server.js
```

Example POSIX npm shim, installed before the real npm on the work-only PATH:

```sh
#!/bin/sh
exec python3 /usr/local/lib/work_resource_guard.py build --tool npm -- \
  /opt/work-guard/real/npm "$@"
```

Repeat for the selected `pnpm`, `yarn`, `bun`, `cargo`, `make`, `docker`, and `depot` commands, changing `--tool` and the real executable path. Resolve/save the real executable **before** adding shims to PATH. Never call the shim itself as its real executable. Preserve symlink-aware layouts for npm/pnpm launchers and rustup cargo; moving a binary or link can break its installation. Python must exist in the image. This component does not install shims, change manifests, or change PATH.

All work threads using one filesystem must share **the same lock inode** at `WORK_BUILD_LOCK`. A common `/data/.work-build.lock` serializes threads in one work container; distinct per-thread lock files would not. Separate PVCs do not serialize against each other merely because they share the same underlying ext4 filesystem: use one shared lock volume/path if multiple containers need a common slot. Do not unlink or replace a live lock file.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `WORK_GUARD_PATH` | `/data` | Existing filesystem path passed to `os.statvfs` |
| `WORK_GUARD_START_GIB` | `25` | Minimum available space for launch/resume/build |
| `WORK_GUARD_STOP_GIB` | `20` | Stop below this available-space watermark |
| `WORK_GUARD_POLL_SECONDS` | `2` | Headroom and lock-wait polling interval |
| `WORK_GUARD_GRACE_SECONDS` | `5` | TERM/INT grace before KILL of managed groups |
| `WORK_BUILD_LOCK` | `/data/.work-build.lock` | Shared flock file; parent directory must exist |

Numbers must be finite and positive, with start strictly above stop. Invalid configuration fails closed when activated. Available space is `f_bavail * f_frsize`, excluding blocks reserved for root. Stat failures refuse new work and stop running work. No filesystem size/quota is inferred from a PVC's requested capacity.

- **Run:** wait without starting the server until at least 25 GiB is available. During operation, terminate below 20 GiB (or on stat errors), then wait until at least 25 GiB before restarting the exact command. Normal server exits are returned, not endlessly restarted. Shutdown signals are forwarded; low-space stops restart only when headroom recovers. Restarts depend on the application's own durable recovery semantics; this tool does not implement session recovery.
- **Build:** wait for one exclusive `fcntl.flock` slot, checking launch headroom while waiting and again before launch. Insufficient launch headroom refuses the build rather than retrying it. Monitor during the command; insufficient space or stat failures stop it, release the slot after cleanup, and return **75**. Interrupted builds may leave partial build outputs. No cleanup occurs.
- **Commands:** exact argument boundaries and ordinary numeric exit statuses are preserved; signal deaths return conventional `128 + signal` status. Guard refusal returns 75, launch errors 127, external TERM 143, external INT 130. No shell interpretation or argument/environment dumps occur in guard logs.
- **Nested builds:** a lock-owner token, matching file metadata, a still-held flock, and live ancestor PID validation avoid deadlocks through Node/Python children that close inherited FDs. Nested wrappers exec in the outer build's group and share its ongoing monitor/slot; the higher watermark is still checked before the nested command begins. The token is an operational marker, not a credential. On Linux ancestry uses procfs; macOS uses PID-only `ps` output. If possible nested ancestry cannot be read, the build fails closed with 75 instead of deadlocking its ancestor.
- **Process cleanup:** commands launch in a new session. TERM/INT and bounded KILL manage the primary process group plus a descendant-group snapshot, so a server can stop nested build sessions even if their wrappers die first. Same-group background writers are also stopped when the main command exits normally.
- **Build environment:** heavy builds default `CARGO_BUILD_JOBS=2` if unset and append `--max-old-space-size=3072` to `NODE_OPTIONS` only if no existing hyphen or underscore form of that option exists. Existing flags, quoting, explicit caps, and cargo settings remain intact, including invalid options left for the real tool to reject. These are defaults, not enforced RAM limits.
- **Read-only/lightweight queries:** sole version/help flags; package-manager help/view/info/list/why queries as supported; npm/pnpm `config get`; bun `pm ls`; cargo help/version/metadata/locate-project; docker help/version/info/inspect/ps/ images; and depot help/version pass through unchanged. Some queries can still write caches or lockfiles. Unknown commands/global-option forms are treated as heavy. `make -n` is not exempt because recursive recipes can execute commands.

## Limits

A local-path PVC on a shared ext4 filesystem is **not a filesystem quota**. This checks the entire backing filesystem's available space. The 5 GiB watermark gap is a reserve, not a guarantee: other writers and high-throughput builds can consume it between polls and during termination grace. Scheduling and descendant discovery add latency beyond the nominal two-second polling interval. If the backing disk is already below 25 GiB, startup intentionally waits; adjust capacity or configured thresholds rather than expecting deletion.

Only wrapped commands are serialized. Direct real-binary calls, different lock inodes, deliberate environment changes, daemonized/reparented processes that escape the descendant snapshot, and remote Docker/Depot builds are outside the hard guarantees. Remote work may continue after its local CLI is terminated. Descendant discovery depends on Linux procfs or macOS `ps`; if unavailable the primary group is still stopped and a warning is emitted. This is not hostile-code containment. Existing cgroup memory/ephemeral-storage limits and backups remain necessary. Kubernetes/PVC requested storage sizes do not become enforced quotas through this script.

## Tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s apps/shared/tests -p 'test_work_resource_guard.py' -v
sh apps/shared/tests/work-resource-guard.test.sh
```

The shell entrypoint makes the suite discoverable by the repository's existing `apps/**/tests/*.test.sh` CI convention. Tests run real subprocesses, process groups, flock contention, signals, and a real Node nested invocation when Node is present. Process integration tests inject only disk measurements; unit fixtures also cover procfs parsing and ancestry failures. `available_bytes(path, statvfs=...)` and `probe` parameters on the supervisor/build functions are test seams; no production environment variable bypasses filesystem probes. No test fills the host disk.
