#!/bin/sh
# Delete Evicted pods and Succeeded pods older than 24h in all namespaces,
# then prune unused containerd images (crictl rmi --prune) when run on the
# node. Off the node the image prune is skipped. The in-cluster CronJob in
# deploy/node-cleanup does the pod half weekly.
#
# Usage: node-cleanup.sh [--dry-run]
# Node crontab (/etc/cron.d/node-cleanup):
#   23 6 * * 0 root /usr/local/bin/node-cleanup.sh >>/var/log/node-cleanup.log 2>&1
set -eu

usage() {
  printf 'Usage: %s [--dry-run]\n' "$0"
  printf 'Deletes Evicted pods and Succeeded pods older than 24h across all\n'
  printf 'namespaces, then prunes unused containerd images when run on the node.\n'
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
