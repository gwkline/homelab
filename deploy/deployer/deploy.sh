#!/bin/sh
# Deploys the newest commit on main whose CI succeeded: renders the targets at
# that commit, pins each homelab image to the signed build of its inputs, dry
# runs the result through admission, applies it server-side, and waits for the
# workloads to roll out. The deployer CronJob runs this every 5 minutes;
# README.md has the rules.
set -eu

# shellcheck source=deploy/deployer/lib.sh
. "$(dirname "$0")/lib.sh"

repo=gwkline/homelab
work=/tmp/deployer
# Commits searched for green CI and for image builds. The CI runs fetched cover
# about a month of main, and every image is rebuilt at least weekly.
depth=100

# One target per line: a kustomization, then the kinds the deployer applies
# from it. The rest of each base, RBAC included, is applied by hand.
targets='
deploy/factory/base ConfigMap CronJob ExternalSecret NetworkPolicy ServiceAccount
deploy/hermes/base StatefulSet
deploy/knowledge/base Deployment NetworkPolicy
deploy/panel/base CronJob Deployment
deploy/t3code/base StatefulSet
deploy/work-t3code/base StatefulSet
'

rm -rf "$work"
mkdir -p "$work"
git clone -q --filter=blob:none --no-checkout "https://github.com/${repo}.git" "$work/repo"
cd "$work/repo"
git rev-list --first-parent --max-count="$depth" HEAD >"$work/commits"
head=$(sed -n 1p "$work/commits")

# One anonymous GitHub API call per pass (the limit is 60 an hour). A commit is
# green when any of its CI runs succeeded, the rule CI's `changes` job uses to
# decide which images to rebuild.
if ! curl -fsS "https://api.github.com/repos/${repo}/actions/workflows/ci.yaml/runs?branch=main&per_page=100" |
  ci_runs >"$work/runs"; then
  echo "cannot read CI runs from the GitHub API; applying nothing" >&2
  exit 1
fi
awk '$3 == "success" { print $1 }' "$work/runs" >"$work/green"
echo "main @ $(short "$head"): newest ci run $(ci_state "$head" "$work/runs")"
if ! sha=$(newest_green "$work/commits" "$work/green"); then
  echo "no commit in the last $depth on main has green ci; applying nothing" >&2
  exit 1
fi
echo "deploying $(short "$sha"): the newest commit with a successful ci run"
git -c advice.detachedHead=false checkout -q "$sha"

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

# The manifests name :latest. Each image is pinned to its build as of the
# deployed commit (build_tag in lib.sh), never to whatever :latest is now: a
# red or re-run build can move :latest.
grep -oE "ghcr\.io/${repo}/[a-z0-9/-]+:latest" "$rendered" | sort -u >"$work/refs"
while read -r ref; do
  image=${ref%:latest}
  if ! ghcr_build_tags "${image#ghcr.io/}" >"$work/tags"; then
    echo "cannot list the tags of $image; applying nothing" >&2
    exit 1
  fi
  if ! tag=$(build_tag "$sha" "$work/commits" "$work/green" "$work/tags"); then
    echo "no green build of $image in the last $depth commits; applying nothing" >&2
    exit 1
  fi
  d=$(ghcr_digest "${image#ghcr.io/}" "$tag")
  [ -n "$d" ] || { echo "cannot resolve $image:$tag; applying nothing" >&2; exit 1; }
  echo "$image:$tag -> $d"
  pin_image "$ref" "$d" "$rendered"
done <"$work/refs"

# Server-side apply: the API server merges per field owner, so an unchanged
# manifest is a no-op, and a field the manifests leave out (a CronJob's
# suspend) keeps whatever an operator set. --force-conflicts: for the fields
# the manifests do set, git wins over whoever changed them last.
ssa="--server-side --field-manager=deployer --force-conflicts"
# kubectl diff is that apply as a server-side dry run, so admission (the
# policy-controller signature check included) rejects a bad object here, before
# anything changes. Exit 0: no changes; 1: changes; above 1: an error, such as
# an admission rejection.
rc=0
# shellcheck disable=SC2086 # ssa is a word list
kubectl diff $ssa -f "$rendered" || rc=$?
case "$rc" in
  0) echo "$(short "$sha"): no changes" ;;
  1)
    # shellcheck disable=SC2086
    kubectl apply $ssa -f "$rendered"
    ;;
  *)
    echo "server-side dry run failed; applying nothing" >&2
    exit 1
    ;;
esac

# Every workload the deployer manages must be rolled out and ready, changed in
# this pass or not; otherwise the Job fails (README.md: Alerts).
rc=0
pids=
workloads <"$rendered" >"$work/workloads"
while read -r ns workload; do
  kubectl -n "$ns" rollout status "$workload" --timeout=150s &
  pids="$pids $!"
done <"$work/workloads"
for pid in $pids; do
  wait "$pid" || rc=1
done
exit "$rc"
