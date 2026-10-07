#!/bin/sh
# Offline tests for deploy/deployer/lib.sh.
set -eu

lib="$(cd "$(dirname "$0")/.." && pwd)/lib.sh"
# shellcheck source=deploy/deployer/lib.sh
. "$lib"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# A rendered stream: a ConfigMap whose data holds a kind: line, a Role, and a
# CronJob, as kubectl kustomize prints them.
cat >"$tmp/stream.yaml" <<'EOF'
apiVersion: v1
data:
  profile.json: |
    kind: NotTopLevel
    "image": "ghcr.io/gwkline/homelab/factory/worker:latest"
kind: ConfigMap
metadata:
  name: profile
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: role
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: job
spec:
  image: ghcr.io/gwkline/homelab/worker:latest
EOF

select_kinds ConfigMap CronJob <"$tmp/stream.yaml" >"$tmp/selected.yaml"
cat >"$tmp/want.yaml" <<'EOF'
---
apiVersion: v1
data:
  profile.json: |
    kind: NotTopLevel
    "image": "ghcr.io/gwkline/homelab/factory/worker:latest"
kind: ConfigMap
metadata:
  name: profile
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: job
spec:
  image: ghcr.io/gwkline/homelab/worker:latest
EOF
diff -u "$tmp/want.yaml" "$tmp/selected.yaml" || fail 'select_kinds kept the wrong documents'

select_kinds Deployment <"$tmp/stream.yaml" >"$tmp/none.yaml"
[ ! -s "$tmp/none.yaml" ] || fail 'select_kinds kept a kind it was not given'

# pin_image rewrites one image everywhere, including inside ConfigMap data,
# and leaves an image whose name merely ends the same way alone.
pin_image ghcr.io/gwkline/homelab/factory/worker:latest sha256:aaa "$tmp/selected.yaml"
grep -q '"image": "ghcr.io/gwkline/homelab/factory/worker@sha256:aaa"' "$tmp/selected.yaml" ||
  fail 'pin_image missed the image in ConfigMap data'
grep -q 'image: ghcr.io/gwkline/homelab/worker:latest$' "$tmp/selected.yaml" ||
  fail 'pin_image rewrote a different image'

echo 'deploy.test.sh: ok'
