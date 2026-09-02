# ADR-003: Observability stack — Grafana + single-node VictoriaMetrics + Loki/Alloy

**Status:** Accepted (2026-09-02) **Deciders:** Gavin Kline, ox-alpha **Implements:** #36 · **Blocks:** metrics-stack and logging-stack implementation issues (boundary fixed in D8)

## Context

Observability must fit the actual hardware before anything is deployed: old servers with 8 GB RAM per node and a spare 16 GB+ disk each (`docs/runbook-server-cluster.md` §0), possibly reduced to a single node on a given day. The cluster's operating model is disposable-by-design — everything converges from git as kustomize bases under `deploy/` — and the panel dev-tools catalog already pins the Grafana contract: `deploy/grafana/base`, Service `grafana` in namespace `agents`, port 80, health path `/api/health` (`apps/panel/server/devtools.ts`).

Constraints (from #36 and repo direction):

- Compare Grafana + Prometheus vs Grafana + VictoriaMetrics for metrics, and Loki + Grafana Alloy for logs, against `kube-prometheus-stack` as the convenient baseline.
- No HA topology: single replicas everywhere; nothing to babysit.
- Access is tailnet-only; tailnet identity is the auth layer for every UI (`deploy/tailscale/README.md`).
- `scripts/verify.sh` enforces the exposure conventions (tailscale hostname + tags annotations) and rejects `:latest` image refs — the stack must be plain kustomize with pinned versions.

## D1. Measured budget

Steady-state requests already committed in `deploy/` manifests (CronJobs excluded — they are transient bursts, `activeDeadlineSeconds`-bounded):

| Workload                            | Requests                |
| ----------------------------------- | ----------------------- |
| t3code (per replica)                | 1 CPU / 2Gi             |
| hermes                              | 500m / 1Gi              |
| panel + homepage                    | 50m / 128Mi each        |
| **Total steady (1 t3code replica)** | **≈ 1.6 CPU / ≈ 3.3Gi** |

Worst-case node budget (documented figures): 8 GB RAM node → ~7.5Gi allocatable after OS + k3s reservations; ~4.2Gi left after existing requests. The observability stack must therefore stay **≤ ~1Gi memory requests / ~3.5Gi limits and ≤ 21Gi of PVC claims** (local-path, thinly provisioned on the node's spare disk; actual usage governed by retention, see D3). Re-measure on the live cluster before deploying:

```sh
kubectl get nodes -o custom-columns='NODE:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory'
kubectl top nodes && kubectl top pods -A --sort-by=memory
kubectl get pvc -A && df -h        # per node: local-path backing disk
```

## D2. Candidates compared

Footprint estimates are planning figures from vendor-documented capacity guidance (linked) and upstream defaults, sized for this cluster (~50k active series, 2 nodes, ~15 concurrent pods). Each implementation issue re-measures with `kubectl top` against the D1 budget — figures, not feature lists.

| Candidate | Steady footprint (est.) | Storage (30d) | Fit | Verdict |
| --- | --- | --- | --- | --- |
| [kube-prometheus-stack](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack) | 8–10 pods: operator (~100m/192Mi), Prometheus (500m–1 CPU / 1–2Gi req, 2–3Gi lim), Alertmanager, Grafana + sidecars (~200m/400Mi), node-exporter ×2, KSM | 25–50Gi claims | Convenient out-of-box dashboards/alerts, but heaviest option; Helm release + 4 CRDs sit outside the repo's git→kustomize reconciler governance; node-exporter needs hostPath/hostPID, blocked by the `agents` baseline PSA | **Rejected** (baseline, too heavy) |
| Grafana + bare Prometheus (no operator) | ~5 pods; Prometheus ~1.5–2Gi RAM steady | ~1.5–2 B/sample → ~260 MB/day → ~8 GB/30d → 25–30Gi claim | Half of the baseline's weight, keeps PromQL; but 2–4× VM's RAM and ~2× its disk at this scale | **Rejected** (keep as escape hatch, D7) |
| Grafana + [VictoriaMetrics](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/) single-node | 1 pod, ~250m/512Mi req, 1 CPU/2Gi lim | [0.4–0.8 B/sample documented](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#retention) → ~120 MB/day → ~4 GB/30d → 15Gi claim | PromQL-compatible query API; built-in scrape (`-promscrape.config`) so no vmagent; lowest RAM/disk on old hardware | **Chosen** |
| kubectl-only logs (status quo) | — | — | No search across TTL-reaped Jobs; no Kubernetes event history; done by hand | **Rejected** |
| Loki + Promtail | — | — | Promtail is deprecated upstream (documented EOL, migration target is Alloy) | **Rejected** |
| [Loki](https://grafana.com/docs/loki/latest/) single binary + [Grafana Alloy](https://grafana.com/docs/alloy/latest/) DaemonSet | 2 pods + 1 DS: Loki ~50m/128Mi req, Alloy ~30m/64Mi req | [≥10× log compression](https://grafana.com/docs/loki/latest/) → ≤ 1 GB/30d at 100–300 MB/day raw → 5Gi claim | Single-binary filesystem mode fits this scale; Alloy's API-based sources need no hostPath (baseline-PSA-safe) and ship short-lived Job logs before TTL reaping (D4) | **Chosen** |

Also consulted: Fluent Bit (solid log tailing, weaker Kubernetes-events story for Loki, one more config dialect to maintain) and Grafana Agent (deprecated upstream — Alloy is its documented successor).

## D3. Retention targets

| Data | Target | Mechanism | Disk (planning) |
| --- | --- | --- | --- |
| Metrics | 30 days, 30s base scrape | VM `-retentionPeriod=30d` (documented suffixes h/d/w/m/y) | ~4 GB / 30d → 15Gi claim |
| Logs | 30 days | Loki compactor with `retention_enabled: true`, `retention_period: 30d` | ≤ 1 GB / 30d → 5Gi claim |
| Kubernetes events | 30 days | Shipped as structured log lines into Loki by Alloy | shares the Loki claim |

30 days covers every TTL in the repo (factory Jobs: 1h; loop-agent: 24h) with margin for a debugging weekend. Shorter if disk pressure shows up; retention is a flag, not a migration.

## D4. Kubernetes events and short-lived Job logs

Job logs and events are the only durable record of sandbox work — the pods themselves are reaped (`ttlSecondsAfterFinished: 3600` on factory profiles, 86400 on loop-agent).

- **Grafana Alloy runs as a DaemonSet and streams container logs as they are written** (`loki.source.kubernetes`, via the kubelet API): log lines reach Loki in seconds, so TTL deletion never outruns shipping. Job/pod/namespace/container names become Loki labels, so `kubectl logs` remains the only thing lost at reaping.
- **Kubernetes events** are captured cluster-wide by `loki.source.kubernetes_events` into the same Loki: OOMKilled, evictions, scheduling and probe failures of already-reaped pods stay queryable for 30d.
- **Known gap, accepted:** if Alloy is down while a Job runs, its lines are lost — API-based sources have no backfill. The durable archive for factory runs remains the controller's log/PVC artifact capture (ADR-001 D2); observability is for debugging, not archival. No TTL values change.
- RBAC is read-only (pods, pods/log, events, nodes/metrics, nodes/proxy) — consistent with the "agents can't touch nodes" security model; no privileged pods anywhere in the stack (the kube-prometheus-stack node-exporter path would have required hostPath and a PSA-relaxed namespace).

## D5. Access and authentication — tailnet-only

- **Only Grafana is exposed**, exactly like homepage/panel/t3code: one Service, `type: LoadBalancer`, `loadBalancerClass: tailscale`, annotations `tailscale.com/hostname: grafana` + `tailscale.com/tags: tag:k8s-operator` (enforced by `scripts/verify.sh`), `https://grafana.<tailnet>`; NetworkPolicy admits ingress from the `tailscale` namespace only (t3code pattern, `deploy/t3code/base/netpol.yaml`).
- VictoriaMetrics, kube-state-metrics, Loki, Alloy: ClusterIP (or nothing), default-deny in front; Alloy → Loki and Grafana → VM/Loki are the only intra-namespace ingress rules. Their HTTP APIs carry **no application auth** — the default-deny NetworkPolicy plus the tailnet boundary is the conscious substitute, documented here so nobody "fixes" it by exposing a port.
- Grafana: anonymous auth disabled; a single admin login from a Secret `grafana-admin` (created once with kubectl, never in git); no per-user accounts, no OAuth v1 — the operator is the only reader. Panel probes `/api/health` unauthenticated, which Grafana serves without login.

## D6. Backup posture

- **Durable (in git, already covered):** dashboards, datasources, VM scrape config, Loki/Alloy configs — all provisioned from ConfigMaps in git, seeded Grafana-init style (`deploy/homepage/base/deployment.yaml` pattern). A rebuilt node re-applies kustomize and dashboards reappear; the nightly restic set (`deploy/backup/base`: t3code + hermes) stays **unchanged**.
- **Disposable (backed up by nothing):** VM and Loki PVCs, and Grafana's SQLite (users/preferences). Retention is the recovery plan for telemetry; losing it is acceptable by design, and `grafana-admin` is re-created in one command.

## D7. Decision

**Grafana + single-node VictoriaMetrics + kube-state-metrics + kubelet/cAdvisor scraping for metrics; Loki single binary + Grafana Alloy for logs** — five small non-privileged pods in namespace `agents`, plain kustomize, exact image pins (never `:latest`), no Helm, no CRDs, no operators, no HA. This is #36's recommended shape ("Grafana, Alloy, Loki, kube-state-metrics, single-node VictoriaMetrics or Prometheus; avoid a large HA topology") with Prometheus resolved to VictoriaMetrics on footprint: at ~50k active series it runs in ~512Mi RAM instead of 2Gi+ and needs ~4 GB instead of ~8 GB of disk for the same 30d, on hardware that has ~4.2Gi of request headroom (D1). The escape hatch is cheap: both backends speak the Prometheus query API, so leaving means swapping one Grafana datasource ConfigMap — dashboards survive.

Grafana belongs to the metrics issue (it is the metrics UI first; the logging issue only adds a datasource + log dashboards to it).

## D8. Implementation boundaries (two issues)

**Metrics issue** — everything needed for node/pod metrics + dashboards:

1. `deploy/victoriametrics/base/`: VM StatefulSet (pinned image; requests 250m/512Mi, limits 1 CPU/2Gi; PVC 15Gi; `-retentionPeriod=30d`, `-promscrape.config` from a ConfigMap), ClusterIP Service, ingress netpol allowing Grafana only.
2. Scrape targets via VM's built-in discovery: kubelet `/metrics` + cAdvisor through the apiserver proxy (kubernetes_sd), kube-state-metrics, self-scrape. One ServiceAccount + read-only ClusterRole (nodes/metrics, nodes/proxy, pods/services/endpoints list-watch) + ClusterRoleBinding.
3. kube-state-metrics Deployment (requests 20m/64Mi, limits 200m/256Mi).
4. `deploy/grafana/base/`: Grafana StatefulSet (pinned image, requests 50m/128Mi, limits 500m/512Mi, PVC 1Gi), Service `grafana` port 80→3000 — the LB-with-tailnet-annotations shape from D5 — provisioning ConfigMaps for the VM datasource + a minimal node/pod dashboard set (JSON in git), admin Secret documented in the dir's README.
5. Verification gate: `./scripts/verify.sh`, `kubectl top pods -n agents` within D1 budget, scrape-uptime query green, dashboards render.
6. **Out of scope:** alerting, Loki datasource, log dashboards, node-exporter (needs hostPath → would force a privileged namespace; revisit only if kubelet/cAdvisor metrics prove insufficient).

**Logging issue** — logs + events onto the existing Grafana:

1. `deploy/loki/base/`: Loki single-binary StatefulSet (pinned image; requests 50m/128Mi, limits 500m/512Mi; PVC 5Gi; filesystem backend, compactor retention per D3), ClusterIP Service, netpol allowing ingress from Alloy and Grafana only.
2. `deploy/alloy/base/`: Alloy DaemonSet (pinned image; requests 30m/64Mi, limits 250m/256Mi; position/heartbeat files on emptyDir), config in git: `loki.source.kubernetes` + `loki.source.kubernetes_events` → `loki.write` to the Loki Service; its own read-only SA/ClusterRole/Binding per D4.
3. Additions to `deploy/grafana/base/`: Loki datasource + Jobs/Events dashboard ConfigMaps (dashboards still in git).
4. Verification gate: `scripts/new-job.sh` smoke job's logs queryable in Grafana within seconds; logs of a TTL-reaped factory job still searchable; events visible; verify.sh green.
5. **Out of scope:** log-based alerting, multi-tenant Loki, S3 storage, parsing pipelines beyond label extraction.

No GitHub-token ExternalSecret coverage is needed for either issue (nothing checks out repos), and no panel code changes — its Grafana card lights up when `deploy/grafana/base` exists.

## Consequences

- +5 pods at ≈ 400m / ≈ 0.9Gi requests (limits ≈ 3.5Gi burst) and ≤ 21Gi claims (~5 GB actual usage / 30d) — fits D1's worst-case node with > 3Gi request headroom; two nodes leave more.
- The heavier, familiar baseline is deliberately not taken: kube-prometheus-stack's operator/CRD/Helm machinery would be the only part of the cluster outside the git→kustomize reconciler model, its node-exporter would fight the baseline PSA, and its convenience (prebuilt alerts) is not needed yet. Alerting stays a non-goal until something actually pages at 2 a.m.
- VM's flag surface moves between versions — images are pinned and Renovate-updated; the PromQL-compatible datasource swap in D7 is the documented exit.
- Log capture has an accepted gap window when Alloy is down (D4); factory artifacts remain the durable record per ADR-001 D2.
- Telemetry is unbacked-up by design (D6); do not add these PVCs to `deploy/backup/base` without revisiting this ADR.
