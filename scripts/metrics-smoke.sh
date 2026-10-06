#!/bin/sh
# Controlled verification for the metrics stack (issue #44).
#
# Creates (1) three deliberately failing Jobs and (2) a temporary CPU-load
# pod in `sandbox`, then queries VictoriaMetrics for the exact series the
# Homelab dashboards and alert rules consume:
#
#   - kube_job_status_failed          -> "Failed Jobs" panels +
#                                        homelab-jobs-repeatedly-failing
#   - container_cpu_usage_seconds     -> node CPU saturation panel
#   - kubelet_volume_stats_*          -> "PVC usage" panel + PVC alert
#   - up{job="kube-state-metrics"}    -> scraper/target health
#
# The three failing Jobs cross the "repeated Job failures" alert threshold
# (>=3 failed Jobs per namespace/24h); kube_job_status_failed is a per-Job
# 0/1 gauge, so the count comes from Jobs, not pod attempts.
#
# Run AFTER the stack is deployed (kubectl apply -k deploy/victoriametrics/base
# && kubectl apply -k deploy/grafana/base). Alert STATES settle in Grafana's
# Alerting UI (folder "Homelab") within ~2 evaluation intervals; this script
# proves the data side, including the threshold-crossing count.
#
# Usage: scripts/metrics-smoke.sh [--keep]   (--keep leaves the fixtures up)
set -eu

JOB_PREFIX=metrics-smoke-fail
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
        printf 'kept fixtures: jobs %s-1..3 + pod/%s in namespace sandbox\n' "$JOB_PREFIX" "$LOAD"
        return 0
    fi
    kubectl delete job -l app=metrics-smoke -n sandbox --ignore-not-found --wait=false >/dev/null 2>&1 || true
    kubectl delete pod "$LOAD" -n sandbox --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- fixture 1: three controlled failing Jobs ---------------------------------
# The homelab-jobs-repeatedly-failing alert fires at >2 failed Jobs per
# namespace in 24h (sum by namespace of increase(kube_job_status_failed)),
# so the verification needs 3 of them: backoffLimit 0 = one attempt each,
# all three fail within seconds.
i=1
while [ "$i" -le 3 ]; do
    kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_PREFIX}-${i}
  namespace: sandbox
  labels:
    app: metrics-smoke
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
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
    i=$((i + 1))
done

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

# vm_assert_at_least <query> <min-value> <tries> — instant query must return a
# single sample whose value is >= min-value (used for the alert threshold).
vm_assert_at_least() {
    _q="$1"
    _min="$2"
    _tries="$3"
    _i=0
    _resp=''
    _val=''
    while :; do
        _resp=$(curl -sS --get --data-urlencode "query=$_q" \
            "http://127.0.0.1:${PF_PORT}/api/v1/query" 2>/dev/null || true)
        _val=$(printf '%s' "$_resp" | sed -n 's/.*"value":\[[0-9.e+]*,"\([0-9.]*\)".*/\1/p' | head -n 1)
        if [ -n "$_val" ] && awk -v v="$_val" -v m="$_min" 'BEGIN { exit !(v >= m) }'; then
            printf '\n[value ok] %s => %s (>= %s)\n' "$_q" "$_val" "$_min"
            return 0
        fi
        if [ "$_i" -ge "$_tries" ]; then
            printf 'TIMED OUT waiting for %s >= %s\nlast value: %s\nlast response: %s\n' \
                "$_q" "$_min" "${_val:-<none>}" "${_resp:-<none>}" >&2
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

echo '==> waiting for failed-Job series from the three failing Jobs (300s budget)'
vm_wait_for_series 'sum by (job_name) (increase(kube_job_status_failed{namespace="sandbox",job_name=~"metrics-smoke-fail-.*"}[1h]))' 60

echo '==> waiting for the alert threshold to cross: >=3 failed Jobs in sandbox/24h (300s budget)'
vm_assert_at_least 'sum(increase(kube_job_status_failed{namespace="sandbox",job_name=~"metrics-smoke-fail-.*"}[24h]))' 3 60

echo '==> waiting for CPU series from the load pod (300s budget)'
vm_wait_for_series 'sum(rate(container_cpu_usage_seconds_total{namespace="sandbox",pod="metrics-smoke-load",container!="",image!=""}[2m]))' 60

echo '==> checking PVC usage series exist (120s budget)'
vm_wait_for_series 'count(kubelet_volume_stats_capacity_bytes)' 24

printf 'data-side verification PASSED.\n'
printf 'Now check Grafana (https://grafana.<tailnet>): Homelab dashboards for the\n'
printf 'series above, and Alerting -> "Homelab" folder: homelab-jobs-repeatedly-failing\n'
printf 'goes Pending -> Firing within ~2 evaluation intervals (the failing Jobs\n'
printf 'cross its >=3 threshold; kube_job_status_failed counts Jobs, not pod\n'
printf 'attempts).\n'
