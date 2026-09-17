#!/bin/sh
# node-cleanup.sh — evict pod debris and prune unused containerd images (#252).
#
# Why: the node's root fs sat at 83% with ~50 Evicted pods in `agents`; at
# 85% kubelet's imagefs threshold (15% free) starts evicting everything on
# that disk — the factory CronJobs, the knowledge Postgres, the panel. The
# debris itself is worthless; letting it accumulate is the problem.
#
# What it deletes (debris, not data — controllers recreate what they need,
# and finished-job logs ship to Loki within seconds via alloy):
#   1. Evicted pods, all namespaces, any age. The kubelet already recorded
#      the eviction as an event; the pod object is all that is left.
#   2. Completed (Succeeded) pods older than 24h. ttlSecondsAfterFinished
#      covers the CronJobs that set it; this sweeps stragglers.
#   3. Unused containerd images (`crictl rmi --prune`) — the factory worker
#      image is ~1GiB and CI publishes new digests daily, so the unused-image
#      pool is the main disk consumer. kubelet re-pulls on demand; nothing
#      referenced by a running container is ever removed.
#
# Where it runs:
#   - On the node (by hand or crontab): both halves run — kubectl reaches
#     the local cluster (/etc/rancher/k3s/k3s.yaml), crictl the local
#     containerd socket. Weekly crontab example (/etc/cron.d/node-cleanup):
#       23 6 * * 0 root /usr/local/bin/node-cleanup.sh >>/var/log/node-cleanup.log 2>&1
#   - Anywhere with cluster credentials: the pod cleanup runs, the image
#     prune is skipped with a notice (crictl needs the node).
#   - Pod debris is ALSO swept in-cluster by the weekly CronJob in
#     deploy/node-cleanup/base (kubectl-only, no hostPath — its README
#     explains why image pruning stays node-side).
#
# Usage: node-cleanup.sh [--dry-run]
# Requires: kubectl + GNU date for the pod halves; crictl (k3s ships it)
# for the image prune. Disk-usage alerting is tracked under #44 — this
# script only cleans up.

set -eu

usage() {
  printf 'Usage: %s [--dry-run]\n' "$0"
  printf 'Deletes Evicted pods and Succeeded pods older than 24h across all\n'
  printf 'namespaces, then prunes unused containerd images when run on the node.\n'
  printf 'Full contract in the header comment of this file (#252).\n'
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) printf '%s: unknown argument %s\n' "$0" "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

delete_pod() {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: would delete pod $1/$2"
    return 0
  fi
  # --wait=false: never block on graceful termination of debris;
  # --ignore-not-found: the pod may vanish between listing and deleting.
  kubectl delete pod "$2" --namespace "$1" --wait=false --ignore-not-found >/dev/null
  log "deleted pod $1/$2"
}

cleanup_pods() {
  if ! command -v kubectl >/dev/null 2>&1; then
    log "kubectl not found — skipping pod cleanup (needs cluster access)"
    return 0
  fi

  log "deleting Evicted pods (all namespaces, any age)"
  evicted=$(kubectl get pods -A \
    -o jsonpath='{range .items[?(@.status.reason=="Evicted")]}{.metadata.namespace}{" "}{.metadata.name}{"\n"}{end}')
  if [ -n "$evicted" ]; then
    printf '%s\n' "$evicted" | while IFS=" " read -r ns name; do
      [ -n "$ns" ] || continue
      delete_pod "$ns" "$name"
    done
  else
    log "no Evicted pods found"
  fi

  log "deleting Succeeded pods older than ${COMPLETED_MAX_AGE_HOURS}h (all namespaces)"
  cutoff=$(date -u -d "${COMPLETED_MAX_AGE_HOURS} hours ago" +%s)
  completed=$(kubectl get pods -A --field-selector=status.phase=Succeeded \
    -o custom-columns='NS:.metadata.namespace,NAME:.metadata.name,CREATED:.metadata.creationTimestamp' \
    --no-headers)
  if [ -n "$completed" ]; then
    printf '%s\n' "$completed" | while IFS=" " read -r ns name created; do
      [ -n "$ns" ] || continue
      created_epoch=$(date -u -d "$created" +%s)
      if [ "$created_epoch" -lt "$cutoff" ]; then
        delete_pod "$ns" "$name"
      fi
    done
  else
    log "no Succeeded pods found"
  fi
}

prune_images() {
  if ! command -v crictl >/dev/null 2>&1; then
    log "crictl not found — skipping image prune (run this script on the node)"
    return 0
  fi
  endpoint=""
  # k3s nodes: /run/k3s/containerd/containerd.sock (socket dir is only
  # traversable by root, so this half needs a root shell on the node);
  # plain containerd nodes: the standard socket path.
  for ep in unix:///run/k3s/containerd/containerd.sock unix:///run/containerd/containerd.sock; do
    if crictl --runtime-endpoint "$ep" info >/dev/null 2>&1; then
      endpoint=$ep
      break
    fi
  done
  if [ -z "$endpoint" ]; then
    log "no reachable containerd endpoint — skipping image prune"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: would run crictl --runtime-endpoint $endpoint rmi --prune"
    return 0
  fi
  log "pruning unused containerd images via $endpoint"
  crictl --runtime-endpoint "$endpoint" rmi --prune
  log "image prune complete"
}

COMPLETED_MAX_AGE_HOURS=24

log "node cleanup starting (dry-run=$DRY_RUN)"
cleanup_pods
prune_images
log "node cleanup done"
