#!/bin/sh
# Controlled verification for the metrics stack (issue #44).
#
# Creates (1) a deliberately failing Job and (2) a temporary CPU-load pod in
# `sandbox`, then queries VictoriaMetrics for the exact series the Homelab
# dashboards and alert rules consume:
#
#   - kube_job_status_failed          -> "Failed Job pods" panels +
#                                        homelab-jobs-repeatedly-failing
#   - container_cpu_usage_seconds     -> node CPU saturation panel
#   - kubelet_volume_stats_*          -> "PVC usage" panel + PVC alert
#   - up{job="kube-state-metrics"}    -> scraper/target health
#
# Run AFTER the stack is deployed (kubectl apply -k deploy/victoriametrics/base
# && kubectl apply -k deploy/grafana/base). Alert STATES settle in Grafana's
# Alerting UI (folder "Homelab") within ~2 evaluation intervals; this script
# proves the data side.
#
# Usage: scripts/metrics-smoke.sh [--keep]   (--keep leaves the fixtures up)
set -eu

JOB=metrics-smoke-fail
LOAD=metrics-smoke-load
PF_PORT=18428
PF_PID=
KEEP=0

case "${1:-}" in
    --keep) KEEP=1 ;;
    '') ;;
    *) printf 'usage: %s [--keep]\n' "$0" >&2; exit 2 ;;
esac

cleanup() {
    if [ -n "$PF_PID" ]; then
        kill "$PF_PID" 2>/dev/null || true
    fi
    if [ "$KEEP" = "1" ]; then
        printf 'kept fixtures: job/%s pod/%s in namespace sandbox\n' "$JOB" "$LOAD"
        return 0
    fi
    kubectl delete job "$JOB" -n sandbox --ignore-not-found --wait=false >/dev/null 2>&1 || true
    kubectl delete pod "$LOAD" -n sandbox --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- fixture 1: the controlled failing Job -----------------------------------
# backoffLimit 3 => up to 4 failed pod attempts => kube_job_status_failed
# reaches 4, which crosses the "repeated Job failures" alert threshold (>=3).
kubectl apply -f - <<'EOF'
apiVersion: batch/v1
kind: Job
metadata:
  name: metrics-smoke-fail
  namespace: sandbox
  labels:
    app: metrics-smoke
spec:
  backoffLimit: 3
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 3600
  template:
    metadata:
      labels:
        app: metrics-smoke
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: fail
          image: busybox:1.36
          command: ["sh", "-c"]
          args: ["echo metrics-smoke: deliberate failure for issue-44 verification; exit 1"]
EOF

# --- fixture 2: the temporary resource load ----------------------------------
# A busy-loop pod pinned to 500m CPU: shows up in the node CPU saturation
# panel via cAdvisor. Deleted again by the cleanup trap (unless --keep).
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: metrics-smoke-load
  namespace: sandbox
  labels:
    app: metrics-smoke
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: load
      image: busybox:1.36
      command: ["sh", "-c"]
      args: ["while :; do :; done"]
      resources:
        requests:
          cpu: 100m
          memory: 32Mi
        limits:
          cpu: 500m
          memory: 64Mi
EOF

# --- read-side: port-forward to VictoriaMetrics and wait for each series -----
kubectl port-forward -n agents svc/victoriametrics "$PF_PORT:8428" >/dev/null 2>&1 &
PF_PID=$!

vm_wait_for_series() {
    _q="$1"
    _tries="$2"
    _i=0
    _resp=''
    while :; do
        _resp=$(curl -sS --get --data-urlencode "query=$_q" \
            "http://127.0.0.1:${PF_PORT}/api/v1/query" 2>/dev/null || true)
        case "$_resp" in
            *'"result":[{'*)
                printf '\n[series ok] %s\n%s\n' "$_q" "$_resp"
                return 0
                ;;
        esac
        if [ "$_i" -ge "$_tries" ]; then
            printf 'TIMED OUT waiting for series: %s\nlast response: %s\n' "$_q" "${_resp:-<none>}" >&2
            return 1
        fi
        sleep 5
        _i=$((_i + 1))
    done
}

i=0
until curl -sS "http://127.0.0.1:${PF_PORT}/health" >/dev/null 2>&1; do
    if [ "$i" -ge 24 ]; then
        echo 'VictoriaMetrics never answered via port-forward' >&2
        exit 1
    fi
    sleep 5
    i=$((i + 1))
done
echo "VictoriaMetrics reachable on 127.0.0.1:${PF_PORT}"

echo '==> waiting for kube-state-metrics target (60s budget)'
vm_wait_for_series 'up{job="kube-state-metrics"}' 12

echo '==> waiting for failed-Job series from the controlled failing Job (300s budget)'
vm_wait_for_series 'sum by (job_name) (increase(kube_job_status_failed{namespace="sandbox",job_name="metrics-smoke-fail"}[1h]))' 60

echo '==> waiting for CPU series from the load pod (300s budget)'
vm_wait_for_series 'sum(rate(container_cpu_usage_seconds_total{namespace="sandbox",pod="metrics-smoke-load",container!="",image!=""}[2m]))' 60

echo '==> checking PVC usage series exist (120s budget)'
vm_wait_for_series 'count(kubelet_volume_stats_capacity_bytes)' 24

printf 'data-side verification PASSED.\n'
printf 'Now check Grafana (https://grafana.<tailnet>): Homelab dashboards for the\n'
printf 'series above, and Alerting -> "Homelab" folder: homelab-jobs-repeatedly-failing\n'
printf 'goes Pending -> Firing within ~2 evaluation intervals.\n'
