# CloudNativePG operator — pinned 1.30.0 (issue #49)

The CloudNativePG operator runs in `cnpg-system`. Version **1.30.0** (released
2026-06-29) is the latest stable >= 1.29: it carries the 1.29 extension
ecosystem (Image Catalogs, Kubernetes ImageVolume-mounted extensions — the
prerequisite for `deploy/postgres`, whose `pg-textsearch` extension in
`deploy/postgres/base/cluster.yaml` needs CNPG 1.29+) plus the 1.29.1/1.29.2
CVE and HA fixes. The 1.29.x line goes EOL 2026-09-29, so tracking the 1.30
line is deliberate, not incidental.

## Layout

- `base/upstream.yaml` — verbatim upstream bundle for v1.30.0 (CRDs,
  `cnpg-system` namespace, RBAC, controller Deployment). Never hand-edit.
- `base/kustomization.yaml` — digest-pins the operator image
  (`:1.30.0@sha256:a2701…efebb`, the multi-arch manifest digest from GHCR)
  and sets `OPERATOR_IMAGE_NAME` to the same pinned reference.

Security posture is upstream's own: the manager runs as UID 10001 with
`ALL` capabilities dropped, read-only root filesystem, and
`RuntimeDefault` seccomp — compatible with the `database` namespace's
restricted PSA.

## Apply / verify

```sh
kubectl apply --server-side -k deploy/cnpg/base
kubectl rollout status deploy/cnpg-controller-manager -n cnpg-system
kubectl -n cnpg-system get pods -o wide
kubectl get crd clusters.postgresql.cnpg.io -o jsonpath='{.metadata.annotations}'
```

`--server-side` matters: the CRDs are large enough to exceed the
client-side annotation size limit on upgrade.

## Upgrading

1. Check https://github.com/cloudnative-pg/cloudnative-pg/releases for the
   newest stable minor (stay on a supported line — see EOL dates in the
   release notes).
2. Download the new `cnpg-<version>.yaml` over `base/upstream.yaml`.
3. Resolve the new multi-arch digest:
   ```sh
   TOKEN=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:cloudnative-pg/cloudnative-pg:pull" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
   curl -sI -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.index.v1+json" \
     https://ghcr.io/v2/cloudnative-pg/cloudnative-pg/manifests/<version> \
     | grep -i docker-content-digest
   ```
4. Update the `digest:` and `OPERATOR_IMAGE_NAME` values in
   `base/kustomization.yaml`, then apply + verify as above.
