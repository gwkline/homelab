# Grafana

Grafana 13.2.1 (single replica, anonymous Viewer behind the tailnet — see `deployment.yaml`). Dashboards are provisioned, not saved in the UI: `dashboards/*.json` is the source of truth, `dashboard-files.yaml` is the generated ConfigMap mounted at `/etc/grafana/dashboards` (re-generate/append when a JSON file changes), and `dashboards-provider.yaml` loads them into the `Homelab` folder. Two datasources are provisioned from `datasources.yaml`: Loki (uid `loki`) and VictoriaMetrics (uid `victoriametrics`, the default — the metrics backend from `deploy/victoriametrics/base`). Alert rules are provisioned from `alerting.yaml` into the `Homelab` alert folder.

## Dashboard catalog

| Dashboard | File | Shows | Datasource |
| --- | --- | --- | --- |
| Homelab Logs | `dashboards/homelab-logs.json` | Log volume by namespace, live agents-namespace tail, error-line count | Loki (pinned, uid `loki`) |
| Homelab Factory Jobs | `dashboards/homelab-factory-jobs.json` | Factory pipeline health: sandbox Job counts by status, failed-job rate, Job durations, CronJob firing gaps, plus the ledger-activity logs from the factory CronJob pods | `DS_METRICS` variable + Loki (pinned) for the logs panel |
| Homelab Postgres | `dashboards/homelab-postgres.json` | CNPG `pg-primary` health at the k8s level: pod CPU/memory vs requests, restarts, pod phase, PVC usage/capacity | `DS_METRICS` variable |
| Homelab Tailscale | `dashboards/homelab-tailscale.json` | Operator + `ts-*` proxy health: resource usage, restarts, phases, operator and proxy logs | `DS_METRICS` variable + Loki (pinned) for the logs panels |
| Homelab Chaos | `dashboards/homelab-chaos.json` | Chaos-monkey kill/recovery timeline built from `[chaos]` log lines (kills, recoveries, failed drills, no-ops) | Loki (pinned, uid `loki`) |
| Homelab Nodes | `dashboards/homelab-nodes.json` | Node saturation: CPU/memory usage vs allocatable, Ready/DiskPressure/MemoryPressure, pods per node | VictoriaMetrics (pinned, uid `victoriametrics`) |
| Homelab Workloads | `dashboards/homelab-workloads.json` | Pod restarts (24h), pending/failed Jobs, PVC usage %, Deployment availability (agents), StatefulSet readiness (agents) | VictoriaMetrics (pinned, uid `victoriametrics`) |

## Datasource strategy

Metrics panels use a dashboard-level **`DS_METRICS` template variable** (`type: datasource`, restricted to Prometheus-compatible datasources) rather than a pinned uid, so they bind to whatever metrics backend is provisioned at view time — with the VictoriaMetrics datasource provisioned (uid `victoriametrics`, the default datasource), the variable resolves to it without dashboard edits. The issue-#44 dashboards (`homelab-nodes`, `homelab-workloads`) and every alert rule pin the `victoriametrics` uid directly instead. Log panels are pinned to the provisioned Loki (uid `loki`, from `datasources.yaml`), whose derived fields turn every `job_name="..."`/`pod="..."` log line into a jump-to-that-run link.

## Regenerating the ConfigMap

`dashboard-files.yaml` must contain **exactly one valid JSON document per `*.json` key**. #285 briefly shipped `homelab-logs.json` with the same dashboard pasted three times into one scalar — Grafana logged a JSON provisioning error on every provider scan (every 30s) until it was collapsed back to the single source JSON. When appending a dashboard, copy the file's JSON verbatim once; a quick check is `python3 -m json.tool` on each scalar.

## Known gaps

- **No postgres exporter is deployed** yet, so `homelab-postgres` is k8s-level only (pod resources, restarts, PVCs). `deploy/postgres/base/netpol.yaml` already reserves scrape access for an exporter on port 9187 — when one lands, add pg-level panels (connections, replication lag, cache hit rate) there.
