# ADR-005: Observability stack — Grafana + single-node VictoriaMetrics + Loki/Alloy

**Status:** Accepted, implemented (`deploy/grafana`, `deploy/victoriametrics`, `deploy/loki`) **Deciders:** Gavin Kline

## Context

Observability must fit old servers, any of which may be down on a given day. When this was decided they had 8 GB RAM each; the cluster is now one node with 32 CPUs and 64 GiB (D1). Everything converges from git as plain kustomize under `deploy/`; access is tailnet-only; `scripts/verify.sh` enforces the Tailscale exposure annotations. No HA topology: single replicas, nothing to babysit.

## D1. Budget

Steady requests already committed before this stack: t3code 1 CPU / 2Gi, hermes 500m / 1Gi, panel and homepage 50m / 128Mi each — ≈ 1.6 CPU / 3.3Gi. An 8 GB node has ~7.5Gi allocatable, so the stack must stay **≤ ~1Gi memory requests / ~3.5Gi limits**.

**Superseded:** that budget assumed 8 GB nodes. On today's node the stack requests about 1.2Gi of memory, with limits of about 5.3Gi, and memory no longer constrains it. Re-measure with:

```sh
kubectl top nodes && kubectl top pods -A --sort-by=memory
```

## D2. Candidates

Planning figures for ~50k active series and ~15 concurrent pods.

| Candidate | Footprint (est.) | Storage (30 d) | Verdict |
| --- | --- | --- | --- |
| [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) | 8–10 pods; Prometheus 1–2Gi | 25–50Gi | Rejected: heaviest; Helm + CRDs; node-exporter needs hostPath/hostPID, which the namespace's Pod Security blocks |
| Grafana + bare Prometheus | ~1.5–2Gi RAM | ~8 GB | Rejected: 2–4× VictoriaMetrics' RAM, ~2× its disk; kept as the escape hatch |
| Grafana + [VictoriaMetrics](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/) single-node | 1 pod, 250m / 512Mi | ~4 GB | **Chosen**: PromQL-compatible, built-in scraping (no vmagent) |
| Loki + Promtail | — | — | Rejected: Promtail is deprecated upstream |
| [Loki](https://grafana.com/docs/loki/latest/) single binary + [Grafana Alloy](https://grafana.com/docs/alloy/latest/) | 2 small pods | ≤ 1 GB | **Chosen**: Alloy reads pod logs through the API — no hostPath, so it passes `restricted` Pod Security |

## D3. Retention and disk budget

PVC sizes are not ceilings. local-path doesn't enforce them, the StorageClass has `allowVolumeExpansion: false`, and `kubelet_volume_stats_capacity_bytes` reports the whole node filesystem for every claim. Every claim shares the node's root disk with images, container layers and logs, and the requests add up to more than the disk. What bounds each component is its own guard. The kubelet's eviction threshold is `nodefs.available<10%` (`bootstrap/k3s-config.yaml`), and every guard has to trip before it.

| Data | Retention | Measured | Budget | Guard |
| --- | --- | --- | --- | --- |
| Metrics (30 s scrape) | `-retentionPeriod=30d` | ~75 MB per 18 h (`vm_data_size_bytes`), so ~3 GB per 30 d | 5 GB | `-storage.minFreeDiskSpaceBytes=15GB`: read-only while the node has < 15 GB free, above the 10% eviction line on disks up to ~150 GB |
| Logs | compactor `retention_period: 720h` | 187 MB of chunks in 35 d (`loki_ingester_chunk_stored_bytes_total`) | 10 GB | `ingestion_rate_mb: 1` / burst 4: a sustained flood writes at most ~7 GB/day, so it reaches the budget in about a day and a half |

The other claims on the node have no guard and are budgeted by use. Postgres has 20Gi, hermes 20Gi, t3code and work-t3code 20Gi + 5Gi each, cloudbeaver 1Gi and panel-stats 1Gi. Measure real use on the node with `sudo du -sh /var/lib/rancher/k3s/storage/*`.

Priorities decide what the kubelet evicts under disk or memory pressure. Postgres, Loki, VictoriaMetrics, the panel, ESO and the Tailscale operator and proxies run as `homelab-platform`; factory CronJobs, worker Jobs and the panel's stats snapshot run as `homelab-batch` (`deploy/policies/base/priorityclasses.yaml`). Every emptyDir has a `sizeLimit`, and every long-running pod except the panel, the knowledge Deployments and Postgres declares ephemeral-storage requests and limits, so scratch space is bounded per pod.

30 days outlives every Job TTL in the repo (factory and ad-hoc Jobs 24 h, the deployer 1 h, the panel's stats snapshot 7 d).

## D4. Short-lived Job logs

Alloy (one replica, `loki.source.kubernetes`) streams container logs within seconds, so TTL deletion never outruns shipping; `job_name` is a label, so a reaped run stays queryable. Credentials are redacted at source. Accepted gap: lines written while Alloy is down are lost (no backfill). RBAC is read-only; nothing in the stack is privileged. Details: [deploy/loki/README.md](../../deploy/loki/README.md).

## D5. Access

- Only Grafana is exposed, on the tailnet through the Tailscale operator (`deploy/tailscale/README.md`); its NetworkPolicy admits only the `tailscale` namespace.
- VictoriaMetrics, kube-state-metrics, Loki, and Alloy are ClusterIP behind default-deny NetworkPolicies. Their APIs have no auth by design — the netpol plus the tailnet is the boundary; do not expose them.
- Grafana: anonymous read-only Viewer (tailnet identity is the gate) plus one admin login from Secret `grafana-admin`.

## D6. Durability

Dashboards, datasources, alert rules, and scrape/Loki/Alloy configs are ConfigMaps in git. VictoriaMetrics and Loki PVCs are disposable and Grafana's own state is an emptyDir; nothing is backed up.

## D7. Decision

Grafana + single-node VictoriaMetrics + kube-state-metrics + kubelet/cAdvisor scraping for metrics; Loki single binary + Alloy for logs. Small non-privileged pods in `agents`, plain kustomize, digest/version-pinned images (Renovate bumps them), no Helm, no CRDs, no HA. Alert rules are provisioned in Grafana (`deploy/grafana/base/provisioning/alerting/`) and notify one ntfy topic. Leaving VictoriaMetrics means swapping one datasource; dashboards survive.

## Consequences

- Superseded with D1: fits the D1 budget with headroom on one 8 GB node.
- kube-prometheus-stack's prebuilt alerts and node-exporter metrics are deliberately forgone; revisit node-exporter only if kubelet/cAdvisor metrics prove insufficient.
- Telemetry is disposable; do not start backing up these PVCs without revisiting this ADR.
