# Node storage policy

Work data, personal data, container images and system logs currently share the node's root filesystem. A local-path PVC's requested capacity is not an enforced quota. Increasing a claim does not add physical space, and stopping a runner does not remove its persistent data or image layers shared with another runner.

## Capacity and retention

- Keep `bootstrap/k3s-config.yaml` image GC at 70% high / 50% low. Image GC removes unused runtime images, not PVC contents or user worktrees. The low target may be unattainable if persistent data plus required images already exceed it; treat that as a capacity constraint, not permission to delete user files.
- Install `bootstrap/journald.conf` to bound persistent system journals to 512 MiB, with a 25 GiB free-space preference, a 64 MiB journal-file bound and a 14-day retention ceiling. This does not control kubelet container logs, Loki data, syslog files, package caches or worktree output. Journal retention is not a filesystem quota and cannot reclaim space held by other writers.
- For heavy development, provision a larger dedicated work volume or use an explicitly approved remote build/export destination. Preserve both work claims, Git refs/dirty/untracked/ignored files, benchmark results, authentication and T3 continuity during migration; retain the original copy until restore verification. Do not relocate employer data to a personal/cloud destination without approval.

## Existing-node activation

Do not rerun the entire bootstrap merely to activate storage settings: it can upgrade k3s/Tailscale and perform other changes. Prepare a maintenance window instead.

1. Compare the installed config with `bootstrap/k3s-config.yaml`, preserving host-specific TLS SANs and all credential locations. Verify any pending secrets-encryption migration and audit-policy prerequisites before restarting an existing server.
2. Preserve diagnostic evidence privately before intentionally reducing old log retention.
3. Install only the journal drop-in, restart systemd-journald, and verify the effective settings with `systemd-analyze cat-config systemd/journald.conf`. Rotation/vacuum of existing archived journals is a separate, explicit maintenance action; never remove arbitrary files under `/var/log` or containerd directories.
4. With approval for the cluster maintenance window, restart the existing k3s service to load its already-configured storage policy. Do not upgrade binaries, weaken eviction thresholds, bypass admission or lower the work guard to claim recovery.
5. Verify the live kubelet config, not merely the file on disk:

   `kubectl --kubeconfig ~/kubeconfig-homelab --server=https://192.168.1.2:6443 --insecure-skip-tls-verify=false --request-timeout=20s get --raw /api/v1/nodes/agent-1/proxy/configz`

   Check `imageGCHighThresholdPercent=70`, `imageGCLowThresholdPercent=50`, and the complete expected eviction/reservation configuration. A successful bootstrap/file copy is not proof the long-running kubelet has reloaded it.

6. Read actual `statvfs` available bytes, image-GC events, pod identity/readiness/restart changes, and the work guard state. Exercise the HTTPS route and a real minimal provider call after recovery. Record unmet capacity requirements honestly; a single HTTP 200 is not proof that sustained builds fit.

Use exact-name, time-bounded diagnostic resources and remove them after verification. Keep public documentation free of employer identifiers and private node evidence.
