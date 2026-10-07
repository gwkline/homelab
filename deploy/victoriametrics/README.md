# VictoriaMetrics

Single-node VictoriaMetrics plus kube-state-metrics in `agents`: the metrics backend for Grafana ([ADR-005](../../docs/adr/adr-005-metrics-logging-stack.md)). Scrape interval 30s, retention 30 days, on a 15Gi PVC (the hard ceiling; the `homelab-pvc-nearly-full` alert fires first). It uses built-in promscrape: no vmagent, operators, or CRDs.

Scrape targets (ConfigMap `victoriametrics-scrape`):

- kubelet `/metrics` and `/metrics/cadvisor` for every node, scraped directly at the node's InternalIP on port 10250 and verified against the cluster CA.
- kube-state-metrics, limited by its `--resources` allowlist to nodes, pods, jobs/cronjobs, deployments/statefulsets, and PVCs.
- VictoriaMetrics itself.

k3s metrics-server is not scraped; nothing consumes its series.

## Apply

```sh
kubectl apply -k deploy/victoriametrics/base
kubectl apply -k deploy/grafana/base   # datasource, dashboards, alerts
```

There are no secrets: scraping uses the read-only `victoriametrics` ServiceAccount, which can read `nodes/metrics` and discover nodes. It has no `nodes/proxy`, so it cannot exec, attach, or read host logs through the kubelet.

## Verify

```sh
kubectl -n agents port-forward svc/victoriametrics 8428:8428 &
curl -s 'http://localhost:8428/api/v1/query?query=up'
```

## Notes

Both services are ClusterIP-only. Ingress is limited to Grafana → VictoriaMetrics (8428) and VictoriaMetrics → kube-state-metrics (8080). Metrics are disposable telemetry and not backed up.
