# Loki

Cluster logs, kept for 30 days: well past the 7-day TTL on sandbox Jobs, so finished runs stay debuggable after `kubectl logs` stops working. Loki runs single-binary on a 10Gi PVC. One Grafana Alloy replica reads every pod's logs through the API (`pods/log`; no hostPath, no privilege) and pushes them to Loki. Grafana queries it (`deploy/grafana`). Loki is ClusterIP-only.

## Apply

```sh
kubectl apply -k deploy/loki/base
```

## Labels

| Label              | Source                                                 |
| ------------------ | ------------------------------------------------------ |
| `namespace`        | pod namespace                                          |
| `workload`         | pod label `app` / `app.kubernetes.io/name` / `k8s-app` |
| `profile`          | pod label `factory.gwkline.io/profile`                 |
| `job_name`         | pod label `batch.kubernetes.io/job-name` (the run id)  |
| `pod`, `container` | names                                                  |

Pod env is never read, so commands, issue text, and secrets can't become labels. Cardinality is capped in Loki (`max_global_streams_per_user: 50000`, `ingestion_rate_mb: 4`).

## Redaction

Before storage, Alloy's `loki.process "redact"` stage rewrites Authorization/API-key headers, GitHub tokens (ghp_, gho_, github_pat_ and similar), and `sk-…` model keys. This is best-effort pattern matching: it narrows exposure, it doesn't guarantee it.

## Verify

```sh
scripts/new-job.sh loki-smoke 'echo hello-from-run-$RANDOM'
kubectl -n sandbox wait --for=condition=complete job/loki-smoke --timeout=180s
kubectl -n sandbox delete job loki-smoke
kubectl -n agents port-forward svc/loki 3100:3100 &
curl -s 'http://localhost:3100/loki/api/v1/query_range' --get \
  --data-urlencode 'query={namespace="sandbox", job_name="loki-smoke"}'
```

## Notes

- If the PVC fills, Loki refuses writes rather than growing. Lower `retention_period` or enlarge the PVC.
- Delivery is at least once: an Alloy restart may re-read lines the kubelet still holds. Logs from pods deleted during a collector outage are lost.
- Node and journald logs that don't run as pods are out of scope; collecting them would need a privileged DaemonSet.
- Logs are not backed up.
