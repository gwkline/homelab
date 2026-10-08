#!/usr/bin/env bash
# Prunes old GHCR versions of the images this repo builds. Per package it
# keeps:
#   - the version tagged `latest` and the newest $KEEP `sha-` tagged versions.
#     The deployer runs a recent green commit's `sha-` build, so these cover
#     every digest the cluster runs;
#   - every digest pinned in the repo (e.g. pg-textsearch in cluster.yaml);
#   - every version pushed in the last day;
#   - the cosign signature and attestation tags of each kept digest;
#   - every manifest a kept version references (platform images, BuildKit
#     attestation manifests).
# Everything else is deleted. Every package is planned before the first
# delete, and any error aborts the run.
#
# Usage: scripts/ghcr-retention.sh [--delete]   (default: print the plan)
# Needs gh (GH_TOKEN that can read packages, and delete for --delete), jq and
# curl. Manifests are read anonymously, as the deployer does, so packages
# must be public.
set -euo pipefail

cd "$(dirname "$0")/.."

KEEP="${KEEP:-20}"
delete=false
[[ "${1:-}" == "--delete" ]] && delete=true

owner="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#' | tr '[:upper:]' '[:lower:]')"
if [[ "$(gh api "users/${owner}" --jq .type)" == "Organization" ]]; then
  api="orgs/${owner}/packages/container"
else
  api="users/${owner}/packages/container"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Digests pinned anywhere in the repo, as "<package> <digest>".
git grep -hoE "ghcr\.io/${owner}/homelab/[a-z0-9/_-]+@sha256:[0-9a-f]{64}" \
  | sed -E "s#^ghcr\.io/${owner}/(.*)@(sha256:.*)#\1 \2#" | sort -u >"$work/pinned" || true

# manifest_children <repo> <digest>: the digests an image index references.
# Uses $token, a pull token for <repo>.
manifest_children() {
  local manifest
  manifest="$(curl -fsS -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$1/manifests/$2")" || return 1
  jq -r '.manifests[]?.digest' <<<"$manifest"
}

# plan_package <package>: writes the versions to delete to $work/delete-<enc>.
plan_package() {
  local pkg="$1" enc="${1//\//%2F}" d i=0 token
  local -a queue=()
  token="$(curl -fsS "https://ghcr.io/token?scope=repository:${owner}/${pkg}:pull" | jq -r .token)"
  gh api --paginate "${api}/${enc}/versions?per_page=100" | jq -s 'add // []' >"$work/versions.json"
  # One line per version: id, digest, created_at, comma-joined tags.
  jq -r '.[] | [.id, .name, .created_at, ((.metadata.container.tags // []) | join(","))] | @tsv' \
    "$work/versions.json" >"$work/versions.tsv"

  awk -F'\t' '$4 ~ /(^|,)latest(,|$)/ { print $2 }' "$work/versions.tsv" >"$work/roots"
  if [[ ! -s "$work/roots" ]]; then
    echo "${pkg}: no latest tag; leaving it alone"
    return 0
  fi
  awk -F'\t' '$4 ~ /(^|,)sha-/' "$work/versions.tsv" | sort -t$'\t' -k3,3r \
    | awk -F'\t' -v n="$KEEP" 'NR <= n { print $2 }' >>"$work/roots"
  awk -v p="$pkg" '$1 == p { print $2 }' "$work/pinned" >>"$work/roots"
  # A publish in flight has pushed its digest but not tagged it yet.
  jq -r --argjson now "$(date +%s)" \
    '.[] | select((.created_at | fromdateiso8601) > $now - 86400) | .name' \
    "$work/versions.json" >>"$work/roots"

  while read -r d; do queue+=("$d"); done <"$work/roots"
  : >"$work/keep"
  while ((i < ${#queue[@]})); do
    d="${queue[i]}"
    i=$((i + 1))
    if grep -qxF "$d" "$work/keep"; then continue; fi
    echo "$d" >>"$work/keep"
    # Signature and attestation tags: sha256-<hex>.sig, .att, ...
    awk -F'\t' -v t="sha256-${d#sha256:}" 'index($4, t) { print $2 }' "$work/versions.tsv" >"$work/next"
    manifest_children "${owner}/${pkg}" "$d" >>"$work/next"
    while read -r d; do queue+=("$d"); done <"$work/next"
  done

  jq -r --rawfile keep "$work/keep" '
    ($keep | split("\n")) as $k
    | .[] | select(.name as $n | $k | index($n) | not)
    | [.id, .name, ((.metadata.container.tags // []) | join(","))] | @tsv' \
    "$work/versions.json" >"$work/delete-${enc}"
  printf '%s: %s versions, keep %s, delete %s\n' "$pkg" \
    "$(wc -l <"$work/versions.tsv" | tr -d ' ')" "$(wc -l <"$work/keep" | tr -d ' ')" \
    "$(wc -l <"$work/delete-${enc}" | tr -d ' ')"
}

packages=()
for df in apps/*/Dockerfile apps/factory/*/Dockerfile images/*/Dockerfile; do
  dir="${df%/Dockerfile}"
  packages+=("homelab/${dir#*/}")
done

for pkg in "${packages[@]}"; do
  plan_package "$pkg"
done

$delete || exit 0
for pkg in "${packages[@]}"; do
  enc="${pkg//\//%2F}"
  [[ -f "$work/delete-${enc}" ]] || continue
  while IFS=$'\t' read -r id _; do
    gh api -X DELETE "${api}/${enc}/versions/${id}" >/dev/null
  done <"$work/delete-${enc}"
  echo "${pkg}: deleted $(wc -l <"$work/delete-${enc}" | tr -d ' ')"
done
