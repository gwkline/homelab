# Grafana

Grafana 13.2.1 (single replica, anonymous Viewer behind the tailnet — see `deployment.yaml`). Dashboards are provisioned, not saved in the UI: `dashboards/*.json` is the source of truth, `dashboard-files.yaml` is the generated ConfigMap mounted at `/etc/grafana/dashboards` (re-generate/append when a JSON file changes), and `dashboards-provider.yaml` loads them into the `Homelab` folder. The Loki datasource is provisioned from `datasources.yaml` (uid `loki`).

## Dashboard catalog

| Dashboard | File | Shows | Datasource |
| --- | --- | --- | --- |
| Homelab Logs | `dashboards/homelab-logs.json` | Log volume by namespace, live agents-namespace tail, error-line count | Loki (pinned, uid `loki`) |
| Homelab Factory Jobs | `dashboards/homelab-factory-jobs.json` | Factory pipeline health: sandbox Job counts by status, failed-job rate, Job durations, CronJob firing gaps, plus the ledger-activity logs from the factory CronJob pods | `DS_METRICS` variable + Loki (pinned) for the logs panel |
| Homelab Postgres | `dashboards/homelab-postgres.json` | CNPG `pg-primary` health at the k8s level: pod CPU/memory vs requests, restarts, pod phase, PVC usage/capacity | `DS_METRICS` variable |
| Homelab Tailscale | `dashboards/homelab-tailscale.json` | Operator + `ts-*` proxy + serve-fixer health: resource usage, restarts, phases, serve-fixer and operator/proxy logs | `DS_METRICS` variable + Loki (pinned) for the logs panels |
| Homelab Chaos | `dashboards/homelab-chaos.json` | Chaos-monkey kill/recovery timeline built from `[chaos]` log lines (kills, recoveries, failed drills, no-ops) | Loki (pinned, uid `loki`) |

## Datasource strategy

Metrics panels use a dashboard-level **`DS_METRICS` template variable** (`type: datasource`, restricted to Prometheus-compatible datasources) rather than a pinned uid, so they bind to whatever metrics backend is provisioned at view time — they work both before and after a VictoriaMetrics datasource lands, without dashboard edits. Log panels are pinned to the provisioned Loki (uid `loki`, from `datasources.yaml`), whose derived fields turn every `job_name="..."`/`pod="..."` log line into a jump-to-that-run link.

## Known gaps

- **No postgres exporter is deployed** yet, so `homelab-postgres` is k8s-level only (pod resources, restarts, PVCs). `deploy/postgres/base/netpol.yaml` already reserves scrape access for an exporter on port 9187 — when one lands, add pg-level panels (connections, replication lag, cache hit rate) there.
