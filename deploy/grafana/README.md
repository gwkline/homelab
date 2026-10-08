# Grafana

Grafana 13.2.1 in `agents`: anonymous Viewer over the tailnet at `https://grafana.<tailnet>.ts.net`, with an `admin` login. Everything is provisioned. Datasources: VictoriaMetrics (uid `victoriametrics`, default) and Loki (uid `loki`). Dashboards: `base/dashboards/*.json`, generated into ConfigMap `grafana-dashboards`, in the `Homelab` folder. Alerting: `base/provisioning/alerting/` (rules, and the ntfy contact point every alert goes to).

## Prerequisites

1Password items (vault `homelab`), synced by ExternalSecrets of the same name; Grafana doesn't start without them:

- `grafana-admin`, field `admin-password`: the `admin` login. The database is an emptyDir, so a rotated password applies at the next pod start.
- `grafana-ntfy`, field `url`: `https://ntfy.sh/<topic>` with an unguessable topic (`openssl rand -hex 16`). Subscribe to the topic in the ntfy app on your phone.

Deploy `deploy/victoriametrics/base` and `deploy/loki/base` first so the datasources resolve.

## Apply

```sh
kubectl apply -k deploy/grafana/base
kubectl -n agents rollout status deploy/grafana
```

## Notes

- All provisioning (datasources, dashboards, alerting) is in hash-suffixed ConfigMaps, so an apply that changes any of it rolls Grafana. Grafana's database is an emptyDir, so the new pod holds exactly what the repo defines: deleted rules and dashboards disappear.
- To add or change a dashboard, edit or add the JSON in `base/dashboards/` and list new files in `base/kustomization.yaml`. UI edits are not saved (`allowUiUpdates: false`).
- Grafana interpolates `$VAR` and `${VAR}` from its environment into provisioning files (contact point settings, datasource fields); that's how `NTFY_URL` gets in. Write a literal `$` there as `$$`. Alert annotations are not interpolated, so `{{ $labels.x }}` stays as written.
- Test the pager: Alerting → Contact points → `ntfy` → Test (admin login).
- Metrics panels bind through a `DS_METRICS` datasource variable. The nodes and workloads dashboards and all alert rules pin uid `victoriametrics`. Loki derived fields turn `job_name="..."`/`pod="..."` into links to that run's logs.
- No postgres exporter is deployed, so the Postgres dashboard shows only Kubernetes-level metrics.
