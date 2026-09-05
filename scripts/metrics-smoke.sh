#!/bin/sh
# shellcheck shell=sh
#
# Metrics-stack smoke test (issue #44): proves the VictoriaMetrics pipeline
# end to end with a controlled failing Job and a temporary resource load,
# then checks the expected Grafana alert states.
#
#   1. Scrape-uptime gate: every VM scrape target reports up == 1.
#   2. Dashboard data: node/container/object/PVC series exist.
#   3. Controlled failures: two smoke Jobs (Repeated Job failures alert) and
#      one restic-backup-smoke Job (Backup job failed alert) fail on
#      purpose; a metrics-smoke-load pod burns CPU so the pod appears with
#      real usage on the Workloads dashboard.
#   4. Alert states: Grafana has the provisioned rules and the two expected
#      ones are firing.
#   5. Cleans up after itself (jobs, load pod, port-forwards) unless
#      --keep is passed for manual dashboard inspection.
#
# Requires: kubectl pointed at the homelab cluster, curl, the stack from
# `kubectl apply -k deploy/victoriametrics/base` + `deploy/grafana/base`,
# and the bootstrap grafana-admin Secret (see deploy/grafana/base/deployment.yaml).
# Runtime: ~3-5 minutes (30s scrapes + 1m alert evaluations must pass).
set -eu

NS_AGENTS="${NS_AGENTS:-agents}"
NS_SANDBOX="${NS_SANDBOX:-sandbox}"
VM_PORT="${VM_PORT:-18428}"
GF_PORT="${GF_PORT:-33000}"
POLL_TIMEOUT="${POLL_TIMEOUT:-300}" # seconds per wait phase

VM_PF=""
GF_PF=""
KEEP=0
if [ "${1:-}" = "--keep" ]; then
  KEEP=1
fi

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

cleanup() {
  status=$?
  if [ "$KEEP" = "0" ]; then
    log "cleanup: deleting smoke resources"
    kubectl delete job metrics-smoke-fail-1 metrics-smoke-fail-2 restic-backup-smoke \
      -n "$NS_SANDBOX" --ignore-not-found >/dev/null 2>&1 || true
    kubectl delete pod metrics-smoke-load -n "$NS_SANDBOX" \
      --ignore-not-found >/dev/null 2>&1 || true
  else
    log "cleanup skipped (--keep): smoke Jobs, load pod and port-forwards left in place"
  fi
  if [ -n "$VM_PF" ]; then
    kill "$VM_PF" 2>/dev/null || true
  fi
  if [ -n "$GF_PF" ]; then
    kill "$GF_PF" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

vm_query() {
  curl -s -G "http://localhost:${VM_PORT}/api/v1/query" \
    --data-urlencode "query=$1"
}

# Print the numeric sample value of a vector query (empty when no series).
vm_value() {
  vm_query "$1" \
    | sed -n 's/.*"value":[^,]*,"\([^"]*\)".*/\1/p' | head -n 1
}

wait_http() {
  curl -s -o /dev/null "http://localhost:$1$2"
}

# Alertmanager API returns compact JSON; split objects onto lines so an
# alertname can be paired with its own state.
am_alerts() {
  gf_api /api/alertmanager/grafana/api/v2/alerts | sed 's/},{/},\n{/g'
}

probe_vm_api() {
  wait_http "$VM_PORT" /health
}
probe_grafana_api() {
  wait_http "$GF_PORT" /api/health
}
probe_all_targets_up() {
  [ "$(vm_value 'min(up{job=~"victoria-metrics|kube-state-metrics|kubelet|cadvisor"})')" = "1" ]
}
probe_node_series() {
  [ -n "$(vm_value 'count(node_memory_MemTotal_bytes)')" ]
}
probe_cadvisor_series() {
  [ -n "$(vm_value 'count(machine_cpu_cores)')" ]
}
probe_ksm_series() {
  [ -n "$(vm_value 'count(kube_pod_container_status_restarts_total)')" ]
}
probe_pvc_series() {
  [ -n "$(vm_value 'count(kubelet_volume_stats_capacity_bytes)')" ]
}
probe_smoke_jobs_failed() {
  [ "$(vm_value 'sum(kube_job_status_failed{job_name=~"metrics-smoke-fail-[12]|restic-backup-smoke"})')" = "3" ]
}
probe_load_pod_series() {
  [ -n "$(vm_value 'count(container_cpu_usage_seconds_total{pod="metrics-smoke-load"})')" ]
}
probe_load_burning() {
  v="$(vm_value 'sum(rate(container_cpu_usage_seconds_total{pod="metrics-smoke-load"}[90s]))')"
  [ "$(awk -v n="$v" 'BEGIN { print (n + 0 > 0.2) ? 1 : 0 }')" = "1" ]
}
probe_backup_alert_firing() {
  am_alerts | grep -Eq '"alertname":[[:space:]]*"Backup job failed".*"state":[[:space:]]*"firing"'
}
probe_repeated_alert_firing() {
  am_alerts | grep -Eq '"alertname":[[:space:]]*"Repeated Job failures".*"state":[[:space:]]*"firing"'
}

wait_for() {
  # wait_for <description> <zero-arg probe function>
  waited=0
  while :; do
    if "$2"; then
      pass "$1"
      return 0
    fi
    if [ "$waited" -ge "$POLL_TIMEOUT" ]; then
      fail "$1 (timed out after ${POLL_TIMEOUT}s)"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

create_fail_job() {
  kubectl apply -f - >/dev/null <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $1
  namespace: ${NS_SANDBOX}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 7200
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
          command: ["false"]
          securityContext:
            runAsNonRoot: true
            runAsUser: 65534
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
EOF
}

command -v curl >/dev/null 2>&1 || fail 'curl not found'
command -v kubectl >/dev/null 2>&1 || fail 'kubectl not found'

# Stale resources from an aborted --keep run would skew counts.
kubectl delete job metrics-smoke-fail-1 metrics-smoke-fail-2 restic-backup-smoke \
  -n "$NS_SANDBOX" --ignore-not-found >/dev/null
kubectl delete pod metrics-smoke-load -n "$NS_SANDBOX" --ignore-not-found >/dev/null

log 'preflight: waiting for victoriametrics / kube-state-metrics / grafana'
kubectl wait --for=condition=ready pod -l app=victoriametrics -n "$NS_AGENTS" --timeout=120s >/dev/null \
  || fail 'victoriametrics pod not ready'
kubectl wait --for=condition=ready pod -l app=kube-state-metrics -n "$NS_AGENTS" --timeout=120s >/dev/null \
  || fail 'kube-state-metrics pod not ready'
kubectl wait --for=condition=ready pod -l app=grafana -n "$NS_AGENTS" --timeout=120s >/dev/null \
  || fail 'grafana pod not ready'

log 'port-forwarding victoriametrics + grafana'
kubectl port-forward svc/victoriametrics -n "$NS_AGENTS" "${VM_PORT}:8428" >/dev/null 2>&1 &
VM_PF=$!
kubectl port-forward svc/grafana -n "$NS_AGENTS" "${GF_PORT}:3000" >/dev/null 2>&1 &
GF_PF=$!

wait_for 'victoriametrics API reachable' probe_vm_api
wait_for 'grafana /api/health reachable' probe_grafana_api

log 'gate 1: scrape-uptime query green (up == 1 for all four jobs)'
wait_for 'all scrape targets up' probe_all_targets_up

log 'gate 2: dashboard data — node/container/object/PVC series exist'
wait_for 'node_* series (kubelet job)' probe_node_series
wait_for 'machine_*/container_* series (cadvisor job)' probe_cadvisor_series
wait_for 'kube_pod_* series (kube-state-metrics job)' probe_ksm_series
wait_for 'kubelet_volume_stats_* series (PVC usage)' probe_pvc_series

log 'gate 3: controlled failures — smoke Jobs + temporary CPU load'
create_fail_job metrics-smoke-fail-1
create_fail_job metrics-smoke-fail-2
create_fail_job restic-backup-smoke
kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: metrics-smoke-load
  namespace: ${NS_SANDBOX}
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
      command: ["dd", "if=/dev/zero", "of=/dev/null"]
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      resources:
        requests:
          cpu: 200m
          memory: 64Mi
        limits:
          cpu: "1"
          memory: 128Mi
EOF
log 'created metrics-smoke-fail-1/2 + restic-backup-smoke Jobs and metrics-smoke-load pod'

wait_for 'all three smoke Jobs counted as failed in VM' probe_smoke_jobs_failed
wait_for 'load pod CPU series in VM' probe_load_pod_series
wait_for 'temporary resource load measured (rate > 0.2 cores)' probe_load_burning

log 'gate 4: Grafana provisioned alert rules + expected states'
GRAFANA_PW=$(kubectl get secret grafana-admin -n "$NS_AGENTS" \
  -o jsonpath='{.data.admin-password}' | base64 -d)
if [ -z "$GRAFANA_PW" ]; then
  fail 'grafana-admin Secret missing/empty — create it (deploy/grafana/base/deployment.yaml)'
fi

gf_api() {
  curl -s -u "admin:${GRAFANA_PW}" "http://localhost:${GF_PORT}$1"
}

RULES=$(gf_api /api/v1/provisioned-alert-rules)
for uid in node-disk-pressure pvc-usage-high backup-job-failed core-workload-unavailable repeated-job-failures; do
  printf '%s' "$RULES" | grep -q "\"uid\":[[:space:]]*\"${uid}\"" \
    || fail "alert rule ${uid} not provisioned in Grafana"
done
pass 'disk-pressure / PVC / backup / core-workload / repeated-Job rules provisioned'

wait_for 'Backup job failed alert firing' probe_backup_alert_firing
wait_for 'Repeated Job failures alert firing' probe_repeated_alert_firing

log 'current Grafana alert states (firing/pending):'
am_alerts | grep -o '"alertname":[^,]*' | sort -u || true

log 'smoke test complete'
