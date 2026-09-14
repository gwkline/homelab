# CloudNativePG operator — pinned 1.30.0 (issue #49)

The CloudNativePG operator runs in `cnpg-system`. Version **1.30.0** (released 2026-06-29) is the latest stable >= 1.29: it carries the 1.29 extension ecosystem (Image Catalogs, Kubernetes ImageVolume-mounted extensions — the prerequisite for `deploy/postgres`, whose `pg-textsearch` extension in `deploy/postgres/base/cluster.yaml` needs CNPG 1.29+) plus the 1.29.1/1.29.2 CVE and HA fixes. The 1.29.x line goes EOL 2026-09-29, so tracking the 1.30 line is deliberate, not incidental.

## Layout

- `base/upstream.yaml` — verbatim upstream bundle for v1.30.0 (CRDs, `cnpg-system` namespace, RBAC, controller Deployment). Never hand-edit.
- `base/kustomization.yaml` — the only local mutations: digest-pins the operator image (`:1.30.0@sha256:a2701…efebb`, the multi-arch manifest digest from GHCR) and sets `OPERATOR_IMAGE_NAME` to the same pinned reference; adds baseline PSA labels to `cnpg-system`; adds the metrics discovery annotations; re-asserts the reviewed resource bounds (see below).
- `scripts/cnpg-smoke.sh` (repo root `scripts/`) — disposable-Cluster lifecycle proof, see [Verification](#verification).

Security posture is upstream's own: the manager runs as UID 10001 with `ALL` capabilities dropped, read-only root filesystem, and `RuntimeDefault` seccomp — it passes `restricted` PSA. The namespace itself carries the **baseline** labels, the same convention as the other operator namespace (`external-secrets`, `deploy/eso/base/namespace.yaml`); the `database` namespace where CNPG-managed instances run enforces `restricted` (`deploy/namespaces.yaml`).

## NetworkPolicies

`cnpg-system` deliberately has **no NetworkPolicy**, matching the platform convention for operator namespaces (`external-secrets`, `tailscale`): the namespace is cluster control-plane plumbing — the API server must always reach its admission webhooks (failurePolicy: Fail), and the operator must always reach the API server, DNS, and managed instance pods. Isolation is enforced where the workloads live: `deploy/postgres/base/netpol.yaml` default-denies the `database` namespace and scopes exactly what may reach PostgreSQL instances (operator management plane on 8000/9187, SQL clients on 5432). Do not "fix" the operator namespace with a default-deny policy — a blocked webhook bricks every Cluster create/update.

## Resource bounds

Pinned in `base/kustomization.yaml` to upstream's own values so a bundle refresh cannot silently change the reviewed footprint: requests **100m / 100Mi**, limits **100m CPU / 200Mi**. That is a rounding error against the machine's ~4.2Gi request headroom (ADR-003 D1 budget, 8 GB-RAM nodes) and leaves CPU headroom for reconcile bursts without unbounded memory growth.

## Metrics

The controller-manager serves Prometheus text metrics on its `metrics` container port **8080**, and `base/kustomization.yaml` stamps the standard discovery annotations onto the pod template:

```yaml
prometheus.io/scrape: "true"
prometheus.io/port: "8080"
```

The selected metrics stack (ADR-003: single-node VictoriaMetrics with built-in `kubernetes_sd`, no Prometheus-operator CRDs) discovers the operator through those annotations — the future `deploy/victoriametrics` scrape config keeps pods with `prometheus.io/scrape=true` and rewrites the address to the annotated port:

```yaml
- job_name: cnpg-operator
  kubernetes_sd_configs:
    - role: pod
  relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: "true"
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
      action: replace
      target_label: __metrics_path__
      regex: (.+)
    - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
      action: replace
      regex: ([^:]+)(?::\d+)?;(\d+)
      replacement: $1:$2
      target_label: __address__
```

`scripts/cnpg-smoke.sh` asserts the annotations and probes `/metrics` live. CNPG's per-Cluster `monitoring.enablePodMonitor` (a `PodMonitor` CRD) stays off: the metrics stack intentionally ships no Prometheus-operator CRDs (ADR-003 D7); scraping the PostgreSQL instances' 9187 endpoints is part of the database-cluster issues, together with the matching `database`-namespace NetworkPolicy allowance.

## Install / recover (plain kubectl, idempotent, no Flux)

```sh
kubectl apply --server-side -k deploy/cnpg/base
kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager
kubectl -n cnpg-system get pods
```

- **Idempotent:** re-running the apply is the recovery path (same contract as `deploy/eso/base`). Nothing here needs Flux — this is a plain kustomize base, so a later Flux `Kustomization` can point at `deploy/cnpg/base` unchanged (ADR-003 defers GitOps; the factory reconciler keeps only `deploy/factory/base` converged).
- **`--server-side` is required:** the CRDs are large enough to exceed the client-side `last-applied-configuration` annotation size limit on upgrade (same reason as the ESO install).

### CRD ordering

One `kubectl apply` carries CRDs, RBAC and the Deployment; kubectl applies CRDs before the workload in a single transaction, so the versions always agree. The ordering rules that remain:

1. **Never create `Cluster`/`Database`/`Backup` resources before `kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io`** (and the controller rollout): the admission webhooks have `failurePolicy: Fail`, so requests fail (not queue) until the webhook is serving.
2. **Upgrades update CRDs and controller in the same apply** — do not split them across steps. New CRD schemas land first (same command), then the new controller rolls; both understand the stored `v1` resources, so no manual conversion step is needed.
3. **Rolling back an operator minor is a downgrade of the CRDs too** — re-apply the previous `upstream.yaml` (server-side); created resources are kept, but fields introduced by the newer schema may be dropped by conversion. Prefer forward-fixes on a disposable cluster (README top: everything here is disposable by design).

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
4. Update the `digest:` and `OPERATOR_IMAGE_NAME` values in `base/kustomization.yaml` (and the version comment at the top of both files), then apply + verify as above. Re-run `scripts/cnpg-smoke.sh all` before merging — it proves the upgraded operator still drives a Cluster through its full lifecycle.

## Verification

The issue's verification gate, as a script (run against a disposable cluster; safe on the homelab cluster too — it only applies `deploy/cnpg/base` idempotently and everything else lives in the throwaway `cnpg-smoke` namespace):

```sh
scripts/cnpg-smoke.sh all
```

`up` installs/verifies the pinned operator, creates a minimal one-instance PostgreSQL 18 Cluster, waits for `Ready`, connects with `psql` as the operator-created `app` user and round-trips a row; `down` deletes the Cluster and proves the operator cleaned up (every pod/PVC/Service gone with it, namespace deletable, operator still healthy).

## Uninstall

```sh
kubectl delete -k deploy/cnpg/base   # refuses nothing, but delete Clusters first (below)
```

The operator Deployment/RBAC/CRDs go, but any existing `Cluster` objects must be deleted first (the operator's finalizers do the PVC/pod cleanup — deleting the CRD orphans them). Full purge:

```sh
kubectl delete cluster,database -A --all   # careful: deletes all PostgreSQL data
# the eleven postgresql.cnpg.io CRDs, selected by API group (the bundle's CRDs
# carry no upstream labels — do not delete by label, other bases label too):
kubectl delete crd \
  $(kubectl get crd -o jsonpath='{range .items[?(@.spec.group=="postgresql.cnpg.io")]}{.metadata.name}{" "}{end}')
kubectl delete ns cnpg-system
```
