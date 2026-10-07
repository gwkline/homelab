# Grafana

Grafana 13.2.1 in `agents`: anonymous Viewer over the tailnet at `https://grafana.<tailnet>.ts.net`, with an `admin` login. Everything is provisioned. Datasources: VictoriaMetrics (uid `victoriametrics`, default) and Loki (uid `loki`). Dashboards: `base/dashboards/*.json`, generated into ConfigMap `grafana-dashboards`, in the `Homelab` folder. Alert rules: `base/alerting.yaml` (no contact point is configured, so nothing pages).

## Prerequisites

```sh
kubectl -n agents create secret generic grafana-admin --from-literal=admin-password='<pw>'
```

Deploy `deploy/victoriametrics/base` and `deploy/loki/base` first so the datasources resolve.

## Apply

```sh
kubectl apply -k deploy/grafana/base
kubectl -n agents rollout status deploy/grafana
```

## Notes

- To add or change a dashboard, edit or add the JSON in `base/dashboards/` and list new files in `base/kustomization.yaml`. UI edits are not saved (`allowUiUpdates: false`).
- Metrics panels bind through a `DS_METRICS` datasource variable. The nodes and workloads dashboards and all alert rules pin uid `victoriametrics`. Loki derived fields turn `job_name="..."`/`pod="..."` into links to that run's logs.
- No postgres exporter is deployed, so the Postgres dashboard shows only Kubernetes-level metrics.
