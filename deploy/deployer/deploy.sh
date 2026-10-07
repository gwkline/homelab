#!/bin/sh
# Applies the homelab workloads from main, each homelab :latest image pinned to
# its current digest. The deployer CronJob runs this every 5 minutes.
set -eu

# shellcheck source=deploy/deployer/lib.sh
. "$(dirname "$0")/lib.sh"

repo=gwkline/homelab
work=/tmp/deployer

# One target per line: a kustomization, then the kinds the deployer applies
# from it. The rest of each base is applied by hand.
targets='
deploy/factory/base ConfigMap CronJob ExternalSecret NetworkPolicy Role RoleBinding ServiceAccount
deploy/hermes/base StatefulSet
deploy/knowledge/base Deployment NetworkPolicy
deploy/panel/base CronJob Deployment
deploy/t3code/base StatefulSet
deploy/work-t3code/base StatefulSet
'

rm -rf "$work"
mkdir -p "$work"
git clone -q --depth 1 "https://github.com/${repo}.git" "$work/repo"
cd "$work/repo"
echo "main @ $(git rev-parse --short HEAD)"

# Rendering keeps each base's labels and namespace. kustomize writes to a file
# first so a failed render stops the run instead of yielding a short stream.
rendered="$work/rendered.yaml"
: >"$rendered"
while read -r dir kinds; do
  [ -n "$dir" ] || continue
  kubectl kustomize "$dir" >"$work/base.yaml"
  # shellcheck disable=SC2086 # kinds is a word list
  select_kinds $kinds <"$work/base.yaml" >>"$rendered"
done <<EOF
$targets
EOF

grep -oE "ghcr\.io/${repo}/[a-z0-9/-]+:latest" "$rendered" | sort -u >"$work/refs"
while read -r ref; do
  image=${ref%:latest}
  d=$(ghcr_digest "${image#ghcr.io/}" latest)
  [ -n "$d" ] || { echo "cannot resolve $ref" >&2; exit 1; }
  echo "$ref -> $d"
  pin_image "$ref" "$d" "$rendered"
done <"$work/refs"

# Server-side apply: the API server merges per field owner, so an unchanged
# manifest is a no-op, and a field the manifests leave out (a CronJob's
# suspend) keeps whatever an operator set. --force-conflicts: for the fields
# the manifests do set, git wins over whoever changed them last.
kubectl apply --server-side --field-manager=deployer --force-conflicts -f "$rendered"
