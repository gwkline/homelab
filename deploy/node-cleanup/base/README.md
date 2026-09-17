# node-cleanup — weekly pod-debris sweep + node image prune (issue #252)

The node's root fs hit 83% while ~50 Evicted pods piled up in `agents`; at
85% kubelet's imagefs threshold starts evicting everything on that disk
(factory CronJobs, the knowledge Postgres, the panel). Two halves fix the
recurrence:

## What is scheduled where

1. **In-cluster (this directory):** a weekly CronJob (`node-cleanup`, Sunday
   06:23 UTC) deletes Evicted pods (any age) and Succeeded pods older than
   24h across all namespaces. kubectl-only: baseline-PSA safe, no hostPath,
   no privilege. Its cluster-wide pod-delete RBAC is the second destructive
   identity in the cluster (after chaos-monkey) and is scoped to exactly the
   two debris classes the script deletes.

   ```sh
   kubectl apply -k deploy/node-cleanup/base
   ```

2. **On the node:** `scripts/node-cleanup.sh` does everything above plus
   `crictl rmi --prune` (unused containerd images — the real disk consumer:
   the ~1GiB factory worker image gets a new digest daily). The image prune
   needs the node's containerd socket and is **deliberately not** a pod:
   mounting the node containerd socket would be node-root-equivalent and
   break the documented security model ("no host socket, ever"; `agents`
   PSA baseline blocks hostPath for good reason). Run it on the node by
   hand, or schedule it with a crontab:

   ```sh
   # /etc/cron.d/node-cleanup on the k3s node
   23 6 * * 0 root /usr/local/bin/node-cleanup.sh >>/var/log/node-cleanup.log 2>&1
   ```

## Acceptance criteria (#252)

- Evicted-pod count back to 0 and staying there: the CronJob + the
  `ttlSecondsAfterFinished` values now present on every factory CronJob
  (the two launchpad instances were missing it).
- Root fs below 75% after cleanup: run `scripts/node-cleanup.sh` on the
  node once for the immediate result (`--dry-run` first).
- Documented, scheduled cleanup: this file + the script header.
- Disk-usage **alerting** is tracked under #44 — it needs the ADR-003
  metrics stack (kubelet/cAdvisor filesystem metrics via VictoriaMetrics;
  today only Grafana-over-Loki exists, which already captures the eviction
  events but has no numeric disk series to alarm on).
