#!/bin/sh
# Offline tests for deploy/deployer/base/lib.sh: which commit gets deployed,
# which image build each workload gets, and how the rendered stream is filtered.
set -eu

lib="$(cd "$(dirname "$0")/../base" && pwd)/lib.sh"
# shellcheck source=deploy/deployer/base/lib.sh
. "$lib"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# expect WANT GOT WHAT
expect() {
  [ "$1" = "$2" ] || fail "$3: want '$1', got '$2'"
}

# Main, newest first. c5 is HEAD with CI still running, c4 failed, c3 passed,
# c2's run was cancelled before building, c1 passed. Full SHAs are 40 hex
# characters; the first 7 name the image tags.
c5=5555555aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
c4=4444444aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
c3=3333333aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
c2=2222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
c1=1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
printf '%s\n' "$c5" "$c4" "$c3" "$c2" "$c1" >"$tmp/commits"

# The workflow-runs API response, trimmed to the fields ci_runs reads. c3 has
# a failed scheduled rebuild newer than its green push run.
cat >"$tmp/runs.json" <<EOF
{"total_count": 6, "workflow_runs": [
  {"head_sha": "$c5", "event": "push", "status": "in_progress", "conclusion": null},
  {"head_sha": "$c4", "event": "push", "status": "completed", "conclusion": "failure"},
  {"head_sha": "$c3", "event": "schedule", "status": "completed", "conclusion": "failure"},
  {"head_sha": "$c3", "event": "push", "status": "completed", "conclusion": "success"},
  {"head_sha": "$c2", "event": "push", "status": "completed", "conclusion": "cancelled"},
  {"head_sha": "$c1", "event": "push", "status": "completed", "conclusion": "success"}
]}
EOF
ci_runs <"$tmp/runs.json" >"$tmp/runs"
expect "$c5 in_progress none" "$(sed -n 1p "$tmp/runs")" 'ci_runs line for a running build'
expect 6 "$(wc -l <"$tmp/runs" | tr -d ' ')" 'ci_runs line count'
awk '$3 == "success" { print $1 }' "$tmp/runs" >"$tmp/green"

expect in_progress "$(ci_state "$c5" "$tmp/runs")" 'ci_state of a running build'
expect failure "$(ci_state "$c3" "$tmp/runs")" 'ci_state reports the newest run'
expect 'not started' "$(ci_state 0000000 "$tmp/runs")" 'ci_state of a commit with no run'
expect 3333333 "$(short "$c3")" 'short'

# With HEAD pending and its parent red, the newest green commit deploys.
expect "$c3" "$(newest_green "$tmp/commits" "$tmp/green")" 'newest_green skips pending and red commits'
printf '%s\n' "$c5" >"$tmp/green-head"
expect "$c5" "$(newest_green "$tmp/commits" "$tmp/green-head")" 'newest_green takes a green HEAD'
: >"$tmp/no-green"
if newest_green "$tmp/commits" "$tmp/no-green" >/dev/null; then
  fail 'newest_green succeeded with no green commit'
fi

# build_tag at c3, per image.
# Rebuilt by c3 itself: its own build.
printf '%s\n' sha-5555555 sha-3333333 sha-1111111 >"$tmp/tags"
expect sha-3333333 "$(build_tag "$c3" "$tmp/commits" "$tmp/green" "$tmp/tags")" \
  'build_tag takes the deployed commit when it rebuilt the image'
# Not rebuilt by c3: the last green build before it. c4's and c5's builds are
# newer than the deployed commit, and c2 never went green, so all are skipped.
printf '%s\n' sha-5555555 sha-4444444 sha-2222222 sha-1111111 >"$tmp/tags"
expect sha-1111111 "$(build_tag "$c3" "$tmp/commits" "$tmp/green" "$tmp/tags")" \
  'build_tag falls back to the newest green build at or before the deployed commit'
# Only red or newer builds: nothing safe to deploy.
printf '%s\n' sha-5555555 sha-4444444 sha-2222222 >"$tmp/tags"
if build_tag "$c3" "$tmp/commits" "$tmp/green" "$tmp/tags" >/dev/null; then
  fail 'build_tag picked a build from a red or newer commit'
fi
: >"$tmp/no-tags"
if build_tag "$c3" "$tmp/commits" "$tmp/green" "$tmp/no-tags" >/dev/null; then
  fail 'build_tag succeeded with no tags'
fi

# A rendered stream as kubectl kustomize prints it: a ConfigMap whose data
# holds a kind: line, a Role, a CronJob, a Deployment and a StatefulSet.
cat >"$tmp/stream.yaml" <<'EOF'
apiVersion: v1
data:
  profile.json: |
    kind: NotTopLevel
    "image": "ghcr.io/gwkline/homelab/factory/worker:latest"
kind: ConfigMap
metadata:
  name: profile
  namespace: sandbox
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: role
  namespace: sandbox
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: job
  namespace: sandbox
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - image: ghcr.io/gwkline/homelab/worker:latest
              name: job
---
apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    name: not-the-name
  name: panel
  namespace: agents
spec:
  template:
    metadata:
      name: pod
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: work-t3code
  namespace: work
EOF

select_kinds ConfigMap CronJob <"$tmp/stream.yaml" >"$tmp/selected.yaml"
expect 'ConfigMap/profile CronJob/job' \
  "$(awk '/^kind:/ { k = $2 } /^  name:/ { printf "%s%s/%s", sep, k, $2; sep = " " }' "$tmp/selected.yaml")" \
  'select_kinds documents'
grep -q 'kind: NotTopLevel' "$tmp/selected.yaml" || fail 'select_kinds cut a document short'
select_kinds Secret <"$tmp/stream.yaml" >"$tmp/none.yaml"
[ ! -s "$tmp/none.yaml" ] || fail 'select_kinds kept a kind it was not given'

workloads <"$tmp/stream.yaml" >"$tmp/workloads"
printf '%s\n' 'agents deployment/panel' 'work statefulset/work-t3code' >"$tmp/want-workloads"
diff -u "$tmp/want-workloads" "$tmp/workloads" || fail 'workloads'

# pin_image rewrites one image everywhere, including inside ConfigMap data,
# and leaves an image whose name merely ends the same way alone.
pin_image ghcr.io/gwkline/homelab/factory/worker:latest sha256:aaa "$tmp/selected.yaml"
grep -q '"image": "ghcr.io/gwkline/homelab/factory/worker@sha256:aaa"' "$tmp/selected.yaml" ||
  fail 'pin_image missed the image in ConfigMap data'
grep -q 'image: ghcr.io/gwkline/homelab/worker:latest$' "$tmp/selected.yaml" ||
  fail 'pin_image rewrote a different image'

echo 'deploy.test.sh: ok'
