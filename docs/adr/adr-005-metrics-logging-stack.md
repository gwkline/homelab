# ADR-005: Observability stack — Grafana + single-node VictoriaMetrics + Loki/Alloy

**Status:** Accepted, implemented (`deploy/grafana`, `deploy/victoriametrics`, `deploy/loki`) **Deciders:** Gavin Kline

## Context

Observability must fit old servers with 8 GB RAM per node, any of which may be down on a given day. Everything converges from git as plain kustomize under `deploy/`; access is tailnet-only; `scripts/verify.sh` enforces the Tailscale exposure annotations. No HA topology: single replicas, nothing to babysit.

## D1. Budget

Steady requests already committed before this stack: t3code 1 CPU / 2Gi, hermes 500m / 1Gi, panel and homepage 50m / 128Mi each — ≈ 1.6 CPU / 3.3Gi. An 8 GB node has ~7.5Gi allocatable, so the stack must stay **≤ ~1Gi memory requests / ~3.5Gi limits**. Re-measure with:

```sh
kubectl top nodes && kubectl top pods -A --sort-by=memory
kubectl get pvc -A
```

## D2. Candidates

Planning figures for ~50k active series and ~15 concurrent pods.

| Candidate | Footprint (est.) | Storage (30 d) | Verdict |
| --- | --- | --- | --- |
| [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) | 8–10 pods; Prometheus 1–2Gi | 25–50Gi | Rejected: heaviest; Helm + CRDs; node-exporter needs hostPath/hostPID, blocked by baseline PSA |
| Grafana + bare Prometheus | ~1.5–2Gi RAM | ~8 GB | Rejected: 2–4× VictoriaMetrics' RAM, ~2× its disk; kept as the escape hatch |
| Grafana + [VictoriaMetrics](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/) single-node | 1 pod, 250m / 512Mi | ~4 GB | **Chosen**: PromQL-compatible, built-in scraping (no vmagent) |
| Loki + Promtail | — | — | Rejected: Promtail is deprecated upstream |
| [Loki](https://grafana.com/docs/loki/latest/) single binary + [Grafana Alloy](https://grafana.com/docs/alloy/latest/) | 2 small pods | ≤ 1 GB | **Chosen**: Alloy reads pod logs through the API — no hostPath, baseline-PSA-safe |

## D3. Retention

| Data                  | Retention                          | Ceiling  |
| --------------------- | ---------------------------------- | -------- |
| Metrics (30 s scrape) | `-retentionPeriod=30d`             | 15Gi PVC |
| Logs                  | compactor `retention_period: 720h` | 10Gi PVC |

30 days outlives every Job TTL in the repo (factory 1 h, ad-hoc 24 h, panel jobs 7 d).

## D4. Short-lived Job logs

Alloy (one replica, `loki.source.kubernetes`) streams container logs within seconds, so TTL deletion never outruns shipping; `job_name` is a label, so a reaped run stays queryable. Credentials are redacted at source. Accepted gap: lines written while Alloy is down are lost (no backfill). RBAC is read-only; nothing in the stack is privileged. Details: [deploy/loki/README.md](../../deploy/loki/README.md).

## D5. Access

- Only Grafana is exposed: a Tailscale LoadBalancer Service with hostname + tags annotations, ingress from the `tailscale` namespace only.
- VictoriaMetrics, kube-state-metrics, Loki, and Alloy are ClusterIP behind default-deny NetworkPolicies. Their APIs have no auth by design — the netpol plus the tailnet is the boundary; do not expose them.
- Grafana: anonymous read-only Viewer (tailnet identity is the gate) plus one admin login from Secret `grafana-admin`.

## D6. Durability

Dashboards, datasources, alert rules, and scrape/Loki/Alloy configs are ConfigMaps in git. VictoriaMetrics and Loki PVCs are disposable and Grafana's own state is an emptyDir; nothing is backed up.

## D7. Decision

Grafana + single-node VictoriaMetrics + kube-state-metrics + kubelet/cAdvisor scraping for metrics; Loki single binary + Alloy for logs. Small non-privileged pods in `agents`, plain kustomize, digest/version-pinned images (Renovate bumps them), no Helm, no CRDs, no HA. Alert rules are provisioned in Grafana (`deploy/grafana/base/alerting.yaml`) with no notification routing until something needs to page. Leaving VictoriaMetrics means swapping one datasource; dashboards survive.

## Consequences

- Fits the D1 budget with headroom on one 8 GB node.
- kube-prometheus-stack's prebuilt alerts and node-exporter metrics are deliberately forgone; revisit node-exporter only if kubelet/cAdvisor metrics prove insufficient.
- Telemetry is disposable; do not start backing up these PVCs without revisiting this ADR.
