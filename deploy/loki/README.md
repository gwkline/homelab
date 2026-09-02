# Loki — persistent cluster logs

Loki stores every pod's logs cluster-wide and keeps them for **30 days** — long
after `ttlSecondsAfterFinished` (7 days) deletes a finished sandbox Job and
`kubectl logs` stops working. Debugging a completed or TTL-deleted coding run
means querying Loki, from Grafana or the API.

Stack (per the observability ADR from #36): **Loki** single-binary on a
filesystem PVC + **Grafana Alloy** reading pod logs through the Kubernetes API.
No Helm, no operators — plain manifests like the rest of this repo. Grafana
itself is issue #44 (`deploy/grafana/base`); this directory ships what Grafana
needs to query Loki.

## Deploy

```sh
kubectl apply -k deploy/loki/base
```

## What is collected, and as what

Alloy (one replica, `agents` namespace) discovers every pod in every namespace
(including `kube-system` — that is the node/system log story here, since k3s
runs its system components as pods) and streams each container's logs to Loki.
No hostPath, no privileged collectors: it reads `pods/log` over the API.

Stream labels — the vocabulary every dashboard and query should use:

| label      | source                                            | bound                                                    |
| ---------- | ------------------------------------------------- | -------------------------------------------------------- |
| `namespace`| pod namespace                                     | a handful (agents, sandbox, kube-system, …)              |
| `workload` | pod label `app` / `app.kubernetes.io/name` / `k8s-app` | one per deployed app                               |
| `profile`  | pod label `factory.gwkline.io/profile`            | one per factory profile                                  |
| `job_name` | pod label `batch.kubernetes.io/job-name`          | **the run identifier** — one per run; ages out with data |
| `pod`      | pod name                                          | per run × containers; ages out with data                 |
| `container`| container name                                    | a few per pod                                            |

Cardinality is therefore bounded by the number of workloads, the run rate, and
the 30-day retention — and hard-capped in Loki itself
(`max_global_streams_per_user: 50000`, `ingestion_rate_mb: 4`). Per-run labels
(`job_name`, `pod`) are indexed on purpose: they are what "jump to this run's
logs" queries need, and on this cluster they number thousands per month, not
millions.

**Never labels**: pod env is not read at all, so `LOOP_COMMAND` (command text),
issue bodies/titles, and secrets cannot become labels. Factory issue numbers
are recoverable from `job_name` (`factory-issue-<n>-…`); for panel jobs the
name itself is the run id (`panel-<slug>-<hash>`).

## Redaction at source

The Alloy pipeline (`alloy.yaml`, `loki.process "redact"`) rewrites credentials
out of every line before it touches disk:

- `Authorization: Bearer …` / basic credentials, wherever they appear
- generic `Authorization:` / `x-api-key:` / `api-key:` / `private-token:` headers with any scheme
- GitHub tokens: classic (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and fine-grained (`github_pat_`)
- model-provider keys (`sk-…`)

This is best-effort pattern matching, not a guarantee: an agent can print a
secret in a form no pattern catches. It narrows the blast radius; it does not
close it.

## Retention and disk ceiling

- **Retention: 30 days** (`retention_period: 720h`), enforced by the compactor
  (`retention_enabled: true`). 30 days ≫ the 7-day sandbox Job TTL, so logs
  always outlive the pods they describe.
- **Hard ceiling: 10Gi** — the StatefulSet PVC request, which a PVC cannot
  exceed. Soft guardrails underneath: ingestion rate 4 MB/s (burst 8), 50k
  streams, ancient-log rejection (168h).
- If the ceiling is hit, Loki refuses writes loudly (visible in Grafana, pod
  logs) instead of growing the disk. Options then: lower `retention_period`,
  or grow the PVC if the node has room. Watch PVC usage on the #44 dashboards.

## Grafana integration

`grafana-datasource.yaml` ships a provisioned Loki datasource (`uid: loki`,
pointed at `http://loki.agents.svc:3100`):

- If #44's Grafana runs the standard datasource sidecar, the
  `grafana_datasource: "1"` label gets it picked up automatically.
- Otherwise mount this ConfigMap as a Grafana provisioning file (its `data`
  key is already named `loki.yaml`).

The datasource defines **derived fields** `Job run logs` and `Pod logs`: any
log line containing `job_name="…"` / `pod="…"` gets a link that opens Explore
pre-filtered to that run — the jump from a failed Job's log line to the full
run, and the label contract (`namespace`, `workload`, `job_name`) #44's
dashboards can link against.

Loki is ClusterIP-only and never exposed to the tailnet: Grafana fronts it, and
ad-hoc access is `kubectl port-forward svc/loki -n agents 3100:3100` (network
policy: `netpol.yaml` allows ingress from `agents` only).

## Backups

Logs are **disposable telemetry and deliberately not backed up**: restic
(`deploy/backup/base`) snapshots only the t3code/hermes stateful PVCs, and this
stack adds no mount there. Losing the Loki PVC loses only the last 30 days of
logs; dashboards and datasource config are in git, so nothing else is at risk.
If you ever want log snapshots anyway, add the `data` PVC of `loki-0` to the
nightly restic CronJob as another read-only mount — one entry, same pattern as
the existing ones.

## Verification

Run a uniquely identified Job, delete it, then read its logs from Loki by run
identifier:

```sh
kubectl apply -k deploy/loki/base
scripts/new-job.sh loki-smoke 'echo hello-from-run-$RANDOM'
kubectl wait --for=condition=complete job/loki-smoke -n sandbox --timeout=180s
kubectl delete job loki-smoke -n sandbox          # pod + kubectl logs gone

kubectl port-forward svc/loki -n agents 3100:3100 &
curl -s 'http://localhost:3100/loki/api/v1/query_range' \
  --get --data-urlencode 'query={namespace="sandbox", job_name="loki-smoke"}'
```

The response contains the run's lines; the same query in Grafana Explore (or a
dashboard panel on `{namespace="sandbox", job_name="<job>"}`) is the UI path.

## Known limits

- One collector replica (two would double-push every line) — at-least-once,
  so a collector reschedule can re-read lines still held by the kubelet.
- True node/journald logs (not running as pods) are out of scope; collecting
  them needs a privileged DaemonSet, which this cluster's PSA posture
  deliberately avoids. Everything k3s runs as a pod (coredns, …) is covered.
- Alloy reads terminated containers' logs via the kubelet, so a collector gap
  shorter than the pod's lifetime self-heals; only logs from pods deleted
  during a collector outage are lost.
