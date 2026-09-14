# VictoriaMetrics — the metrics backend

Single-node **VictoriaMetrics** collects node, pod/container (cAdvisor), Kubernetes-object (kube-state-metrics) and PVC metrics for the whole cluster and serves them to Grafana. The metrics half of the observability ADR from #36 ([ADR-003](../../docs/adr/adr-003-metrics-logging-stack.md), D7/D8): plain kustomize, no Helm, no CRDs, no operators, one replica of everything. Grafana itself lives in [`deploy/grafana/base`](../grafana/base) (tailnet-only, `https://grafana.<tailnet>`); logs/events go to Loki via Alloy ([`deploy/loki`](../loki)).

## Deploy

```sh
kubectl apply -k deploy/victoriametrics/base
kubectl apply -k deploy/grafana/base        # adds the VM datasource, dashboards, alerts
```

No secrets to create: the stack reads the cluster with service-account tokens, and Grafana's admin credential is the one `grafana-admin` Secret documented in `deploy/grafana/base/deployment.yaml` (recreate in one command if lost):

```sh
kubectl create secret generic grafana-admin -n agents --from-literal=admin-password='<pw>'
```

## What runs, and at what cost (ADR D1/D8 budget)

| Workload | Requests | Limits | State |
| --- | --- | --- | --- |
| VictoriaMetrics (StatefulSet) | 250m / 512Mi | 1 CPU / 2Gi | PVC **15Gi** (hard ceiling) |
| kube-state-metrics (Deployment) | 20m / 64Mi | 200m / 256Mi | none |

Together with Grafana/Loki/Alloy this keeps the observability stack under the ADR's `~1Gi requests / ~3.5Gi limits / ≤21Gi claims` envelope on the 8 GB single-machine budget. Metrics retention is **30 days** at a **30s** base scrape (`-retentionPeriod=30d` in `victoriametrics.yaml`); at this scale that is a few GB of actual usage under the 15Gi ceiling — when the ceiling nears, the `homelab-pvc-nearly-full` alert fires and the fix is a retention flag change, not a migration.

## What is scraped (built-in discovery — no vmagent)

`victoriametrics.yaml` carries the promscrape config (ConfigMap `victoriametrics-scrape`):

- **kubelet `/metrics`** and **cAdvisor `/metrics/cadvisor`** for every node, reached *through the API-server proxy* (`kubernetes_sd` role `node`, `https://kubernetes.default.svc/api/v1/nodes/<node>/proxy/...`) — the pod only ever talks to the apiserver, never to node IPs.
- **kube-state-metrics** (static target) for Kubernetes object state: nodes, pods, jobs/cronjobs, deployments/statefulsets, PVCs (its `--resources` allowlist in `kube-state-metrics.yaml`).
- **self-scrape** for VM's own health.

The scrape identity is the read-only `victoriametrics` ServiceAccount (`rbac.yaml`): `nodes/metrics` + `nodes/proxy` get, plus get/list/watch on `nodes`, `pods`, `services`, `endpoints` for discovery. It is the documented security-model exception in the main README — no secrets, no writes, no CRDs.

VictoriaMetrics and kube-state-metrics are ClusterIP-only and never touch the tailnet (ADR D5): NetworkPolicies in `netpol.yaml` admit only Grafana → VM (`:8428`) and VM → kube-state-metrics (`:8080`). Ad-hoc access is `kubectl -n agents port-forward svc/victoriametrics 8428:8428`.

## Dashboards and alerts (in git, provisioned)

Grafana provisions two dashboards (folder **Homelab**, source JSON in `deploy/grafana/base/dashboards/`):

- **Homelab Nodes** — node saturation: CPU and memory vs allocatable, Ready / DiskPressure / MemoryPressure counts, pods per node.
- **Homelab Workloads** — pod restarts (24h), pending/failed Jobs, PVC usage %, Deployment availability (agents), StatefulSet readiness (agents).

Alert rules (provisioned from `deploy/grafana/base/alerting.yaml`, evaluated by Grafana's built-in alerting against the VM datasource, folder **Homelab**):

| Rule | Fires when |
| --- | --- |
| `homelab-node-disk-pressure` | a node reports `DiskPressure=True` for 10m |
| `homelab-pvc-nearly-full` | a PVC is >90% full for 30m |
| `homelab-backup-failed` | a `restic-backup` Job failed in the last 24h |
| `homelab-deployment-unavailable` | an agents Deployment is under-replicated 5m |
| `homelab-statefulset-unavailable` | an agents StatefulSet is not fully ready 5m |
| `homelab-jobs-repeatedly-failing` | ≥3 failed Job pods per namespace in 24h |

States are visible in Grafana's Alerting UI; notification routing is deliberately not configured yet (nothing here pages at 2 a.m., ADR D7) — wire a contact point in Grafana when that changes.

## Verification

```sh
scripts/metrics-smoke.sh
```

creates a controlled failing Job (`backoffLimit: 3`) and a 500m CPU-load pod in `sandbox`, then proves via the VM query API that `kube_job_status_failed`, the load pod's `container_cpu_usage_seconds_total`, `kubelet_volume_stats_*`, and the kube-state-metrics target all appear. Expected alert/dashboard effects: "Failed Job pods (24h)" ≥ 3, the load pod's core on the Nodes dashboard's CPU panel, and `homelab-jobs-repeatedly-failing` going Pending → Firing in Grafana's Alerting UI within ~2 evaluation intervals. Clean up is automatic (`--keep` leaves the fixtures).

## Recovery

Everything that matters is declarative and in git: scrape config, dashboards, datasources, alert rules, RBAC. A rebuilt node re-applies both kustomize dirs and the stack reappears. The VM PVC (like the Loki PVC and Grafana's SQLite) is **disposable telemetry, deliberately not backed up** (ADR D6): retention is the recovery plan, so do not add these PVCs to the nightly restic set without revisiting the ADR. Dashboards/datasources are re-provisioned on restart; only the `grafana-admin` Secret is hand-created (one command above).

## Version pins

`victoriametrics/victoria-metrics:v1.110.0` and `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0` are exact-tag pins (the repo's `:latest` gate rejects anything looser); Renovate's `pinDigests` hardens both to `tag@sha256` bumps. VM's flag surface moves between versions — bump deliberately.
