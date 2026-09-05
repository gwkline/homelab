# VictoriaMetrics — single-node cluster metrics

VictoriaMetrics stores every **node, container, Kubernetes-object, and PVC** metric cluster-wide and keeps them for **30 days** — the metrics half of the observability stack chosen in ADR-003 (#36), deployed by issue #44. Logs (Loki + Alloy) live beside it in `deploy/loki/`; Grafana (`deploy/grafana/base`) is the UI for both.

Stack: **VictoriaMetrics** single-node (built-in scraper, no vmagent) + **kube-state-metrics**. No Helm, no operators, no CRDs — plain manifests like the rest of this repo. Five small non-privileged pods total for the whole observability stack, per ADR-003 D7.

## Deploy

```sh
kubectl apply -k deploy/victoriametrics/base
```

## What is collected, and from where

VM's built-in scrape config (`vm.yaml` ConfigMap, 30s interval) pulls four targets:

| job | source | gives |
| --- | --- | --- |
| `victoria-metrics` | self, `localhost:8428` | scraper/ingestion health (`up`) |
| `kube-state-metrics` | `kube-state-metrics.agents.svc:8080` | `kube_*` object state: Jobs, Deployments, StatefulSets, Pods, PVCs |
| `kubelet` | apiserver proxy → node `:10250/metrics` | `node_*` (CPU/memory/filesystem), `kubelet_volume_stats_*` (PVC usage) |
| `cadvisor` | apiserver proxy → node `:10250/metrics/cadvisor` | `container_*` per-pod CPU/memory, `machine_*` |

Kubelet/cAdvisor are reached **through the apiserver proxy** (`/api/v1/nodes/<name>/proxy/…`) — no pod ever dials a node IP or hostPath. The `victoria-metrics` ServiceAccount holds a read-only ClusterRole (`nodes`, `nodes/proxy`, `nodes/metrics`, `pods/services/endpoints` list-watch) — it joins the audited "pods can't touch Kubernetes" exception list in the main README. Nothing in the stack is privileged; the `agents` namespace baseline PSA holds.

## Budget (ADR-003 D1/D8)

| Workload | Requests | Limits | Storage |
| --- | --- | --- | --- |
| VictoriaMetrics | 250m / 512Mi | 1 CPU / 2Gi | PVC **15Gi** (hard ceiling) |
| kube-state-metrics | 20m / 64Mi | 200m / 256Mi | — |

Together with the logging stack and Grafana this keeps the observability total ≤ ~1Gi requests / ~3.5Gi limits. Verify against the live cluster before/after deploying:

```sh
kubectl get nodes -o custom-columns='NODE:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'
kubectl top pods -n agents
```

VM's internal memory budget is capped (`-memory.allowedPercent=15`, ≈1.2Gi on the 8GB nodes) so it cannot burst past its 2Gi limit and get OOMKilled.

## Retention and disk ceiling

- **Retention: 30 days** (`-retentionPeriod=30d`) — outlives every Job TTL in the repo (factory 1h–24h, panel/new-job up to 7d) with margin for a debugging weekend.
- **Hard ceiling: 15Gi** — the StatefulSet PVC request, which a PVC cannot grow past. At this cluster's series count 30 days is ~4 GB; if the ceiling is ever hit, VM refuses writes loudly (dashboard + `VMUnhealthyData`-shaped gaps) instead of the disk growing. Options then: lower `-retentionPeriod`, or grow the PVC if the node has room.
- Retention is a flag, not a migration (ADR-003 D3).

## Grafana integration

`deploy/grafana/base` provisions this VM as its default datasource (`uid: victoriametrics`, Prometheus-type, `http://victoriametrics.agents.svc:8428`) plus the dashboards and alert rules:

- **Homelab Nodes** — CPU/memory saturation, root-filesystem usage, disk I/O, load: node saturation at a glance.
- **Homelab Workloads** — pod restarts, pending pods, failed Jobs, PVC usage, deployment/statefulset availability.
- **Provisioned alert rules** (Grafana unified alerting, group `homelab-core`): node disk pressure (>85% for 10m), PVC usage high (>80% for 10m), failed backups (`restic-backup-*` Jobs), unavailable core workloads (`agents`/`database`, 5m), repeated Job failures (≥2 in 2h per namespace). States are visible in Grafana's Alerting UI; delivery/paging is deliberately not wired — ADR-003's "alerting stays a non-goal until something actually pages at 2 a.m." applies to notifications, not to rule evaluation.

## Access and network policy

VictoriaMetrics is ClusterIP-only and never exposed to the tailnet — Grafana fronts it. `netpol.yaml` admits **Grafana only** (VM) and **VictoriaMetrics only** (kube-state-metrics). The query API carries no application auth by design (ADR-003 D5): the default-deny ingress + tailnet boundary is the substitute. Ad-hoc access:

```sh
kubectl port-forward svc/victoriametrics -n agents 8428:8428
curl -s 'http://localhost:8428/api/v1/query' --get --data-urlencode 'query=up'
```

## Recovery

Everything that matters is declarative and in git: scrape config, RBAC, dashboards, datasource, alert rules. A rebuilt node re-applies `kubectl apply -k deploy/victoriametrics/base` (plus `deploy/grafana/base`, `deploy/loki/base`) and the stack converges. The PVC is **disposable telemetry, backed up by nothing** (ADR-003 D6) — losing it loses only the last 30 days of metrics; do not add it to `deploy/backup/base` without revisiting the ADR.

## Verification

```sh
scripts/metrics-smoke.sh
```

Deploys a controlled failing Job (plus a `restic-backup-*` named one for the backup alert), a temporary CPU-load pod, then proves: scrape targets `up == 1`, the failing Job's `kube_job_status_failed` series appears, the load pod's CPU series appears, and the expected alert states flip in Grafana. Cleans up after itself.

## Known limits

- Single replica, no HA — deliberately (ADR-003 D2); the Prometheus escape hatch is one datasource ConfigMap swap.
- VM's flag surface moves between versions; the image is digest-pinned and Renovate-tracked — re-check the args on bump.
- Scrape-config changes need a pod restart (`kubectl rollout restart statefulset/victoriametrics -n agents`); ConfigMaps don't trigger rolls by themselves.
