# CloudNativePG operator — pinned 1.30.0 (issue #49)

The CloudNativePG operator runs in `cnpg-system`. Version **1.30.0** (released 2026-06-29) is the latest stable >= 1.29: it carries the 1.29 extension ecosystem (Image Catalogs, Kubernetes ImageVolume-mounted extensions — the prerequisite for `deploy/postgres`, whose `pg-textsearch` extension in `deploy/postgres/base/cluster.yaml` needs CNPG 1.29+) plus the 1.29.1/1.29.2 CVE and HA fixes. The 1.29.x line goes EOL 2026-09-29, so tracking the 1.30 line is deliberate, not incidental.

## Layout

- `base/upstream.yaml` — verbatim upstream bundle for v1.30.0 (CRDs, `cnpg-system` namespace, RBAC, controller Deployment). Never hand-edit.
- `base/kustomization.yaml` — digest-pins the operator image (`:1.30.0@sha256:a2701…efebb`, the multi-arch manifest digest from GHCR), sets `OPERATOR_IMAGE_NAME` to the same pinned reference, and adds the namespace's PSA labels. Everything else is additive and never touches the bundle.
- `base/metrics-service.yaml` — ClusterIP Service `cnpg-metrics` (port 8080 → the manager's `metrics` container port) with `prometheus.io/scrape` annotations; see "Metrics".
- `base/netpol.yaml` — default-deny in `cnpg-system` plus the one exposure policy: webhook (9443) from the API server, metrics (8080) from `agents`, egress only DNS + the Kubernetes API (same allowance as headlamp/dispatcher).
- `../../scripts/cnpg-smoke.sh` — disposable-cluster end-to-end proof (install → temp Cluster → psql → delete → cleanup check).

## Pod security and networking

`cnpg-system` enforces `restricted` PSA (kustomize patch): the upstream manager pod is already restricted-compatible — UID 10001, all capabilities dropped, no privilege escalation, read-only root filesystem, `RuntimeDefault` seccomp — the same posture the `database` namespace enforces on instance pods. NetworkPolicies live beside the manifests (`base/netpol.yaml`) per the platform convention (default-deny + per-workload exposure rules). One operational consequence: all admission webhooks ship with `failurePolicy: Fail`, so the API server **must** be able to reach the operator's webhook port — if Cluster creation times out while the manager pod is Ready, the webhook ingress rule in `base/netpol.yaml` (node/LAN range `192.168.0.0/16`, the range documented in `deploy/policies/base`) is the first suspect.

## Resource sizing

Upstream ships the manager at `100m CPU / 100Mi` requests and `100m / 200Mi` limits. That is deliberately kept: this is a two-node, 8 GB-RAM machine (ADR-003 D1 budget, ~4.2Gi request headroom after the existing workload requests), and the operator's steady state at this cluster size (a handful of reconciles, no leader-election churn) sits far below those numbers. Re-measure with `kubectl top pods -n cnpg-system` before raising anything; a higher limit is only warranted if the operator is OOM-killed during a reconcile storm.

## Metrics

The manager exposes Prometheus metrics at `:8080/metrics` (upstream `metrics` container port). `base/metrics-service.yaml` makes that a stable, annotation-discoverable target (`prometheus.io/scrape: "true"`, `prometheus.io/port: "8080"`): the metrics stack chosen in ADR-003 — single-node VictoriaMetrics in `agents` — scrapes through its built-in kubernetes_sd discovery honoring exactly these annotations, so the metrics-stack issue only needs to keep annotation-based relabeling on. `base/netpol.yaml` admits port 8080 from the `agents` namespace. The operator also injects the `cnpg-default-monitoring` ConfigMap's queries into every Cluster's exporter; instance-side metrics (port 9187) are deploy/postgres scope. Grafana's CNPG dashboards can be pointed at the resulting datasource when the metrics stack lands.

## CRD ordering

The bundle is one server-side-apply file whose internal order already encodes the dependency rule: **CRDs → namespace → RBAC → Deployment**, and `kubectl apply --server-side` submits documents in that order. Two ordering rules matter beyond the initial apply:

- **Fresh install:** wait for the CRD to be `Established` before applying anything under `deploy/postgres` — the recovery drill (`scripts/recovery-drill.sh`, `cnpg-operator` stage) and `scripts/cnpg-smoke.sh` both do `kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io`. The admission webhooks are `failurePolicy: Fail`, so the controller must be Ready before any `postgresql.cnpg.io` resource is created; applying Clusters first would wedge those requests.
- **Upgrades:** never delete a CRD while Clusters exist (their status is stored in the CRD's served versions). Reapplying a new bundle updates the CRDs in place and then rolls the Deployment; storage of existing objects is preserved. The `--server-side` flag is what makes CRD upgrades possible at all — these CRDs exceed the 262 KB client-side-apply annotation limit on re-apply.

## Smoke test (disposable cluster)

```sh
./scripts/cnpg-smoke.sh
```

Installs the operator exactly as production does, creates a minimal one-instance `pg-smoke` Cluster in a scratch `cnpg-smoke` namespace (restricted PSA, managed role, 1Gi PVC), connects with `psql` over TCP+SCRAM, then deletes the Cluster and asserts the cleanup behavior: pod and PVC are garbage-collected with the Cluster object, the namespace deletes empty, and the operator stays healthy. Safe to re-run; never point it at the `database` namespace.

## Apply / verify

```sh
kubectl apply --server-side -k deploy/cnpg/base
kubectl rollout status deploy/cnpg-controller-manager -n cnpg-system
kubectl -n cnpg-system get pods -o wide
kubectl get crd clusters.postgresql.cnpg.io -o jsonpath='{.metadata.annotations}'
```

`--server-side` matters: the CRDs are large enough to exceed the client-side annotation size limit on upgrade.

## Upgrading

1. Check https://github.com/cloudnative-pg/cloudnative-pg/releases for the newest stable minor (stay on a supported line — see EOL dates in the release notes).
2. Download the new `cnpg-<version>.yaml` over `base/upstream.yaml`.
3. Resolve the new multi-arch digest:
   ```sh
   TOKEN=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:cloudnative-pg/cloudnative-pg:pull" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
   curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     https://ghcr.io/v2/cloudnative-pg/cloudnative-pg/manifests/<version> \
     | grep -i docker-content-digest
   ```
4. Update the `digest:` and `OPERATOR_IMAGE_NAME` values in `base/kustomization.yaml`, then apply + verify as above.
