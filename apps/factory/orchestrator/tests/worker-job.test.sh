#!/bin/sh
# Offline test for worker-job.jq: the worker Job follows its RunProfile, has a
# TTL and storage limits, runs restricted, and gives the GitHub token only to
# the clone initContainer.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
TEMPLATE="${ROOT}/apps/factory/orchestrator/worker-job.jq"
FIX="$(mktemp -d)"
trap 'rm -rf "${FIX}"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

# profile.json as the ConfigMap ships it (the block under `profile.json: |`).
profile_of() {
  awk '/profile\.json: \|/ { on = 1; next } on && /^    / { sub(/^    /, ""); print; next } on { exit }' \
    "${ROOT}/deploy/factory/base/profile-$1.yaml"
}

render() { # $1 = profile JSON file
  jq -n --argjson profile "$(cat "$1")" --arg job factory-issue-7-1 --arg issue 7 \
    --arg repo gwkline/homelab --arg brief_b64 e30= --arg worker_cmd "opencode run" \
    -f "${TEMPLATE}"
}

for name in code-pr security; do
  profile_of "${name}" > "${FIX}/${name}.json"
  jq -e . "${FIX}/${name}.json" > /dev/null || fail "${name}: profile.json is not valid JSON"
  render "${FIX}/${name}.json" > "${FIX}/${name}-job.json"
  P="${FIX}/${name}.json" J="${FIX}/${name}-job.json"

  # Every profile field is consumed (capabilities by run.sh's needs: check);
  # one nobody reads is drift.
  extra=$(jq -r '[keys[] | select(IN("name", "image", "serviceAccount", "activeDeadlineSeconds",
    "backoffLimit", "ttlSecondsAfterFinished", "resources", "workSizeLimit", "capabilities") | not)] | join(",")' "$P")
  [ -z "${extra}" ] || fail "${name}: profile fields no Job reads: ${extra}"
  jq -e '(.capabilities | type) == "array"' "$P" > /dev/null || fail "${name}: profile declares no capabilities"

  jq -e --slurpfile p "$P" '
    $p[0] as $p
    | .spec.ttlSecondsAfterFinished == $p.ttlSecondsAfterFinished
    and .spec.activeDeadlineSeconds == $p.activeDeadlineSeconds
    and .spec.backoffLimit == $p.backoffLimit
    and .spec.template.spec.serviceAccountName == $p.serviceAccount
    and ([.spec.template.spec.initContainers[], .spec.template.spec.containers[]] | all(.image == $p.image))
    and .spec.template.spec.containers[0].resources == $p.resources
    and (.spec.template.spec.volumes[] | select(.name == "work") | .emptyDir.sizeLimit) == $p.workSizeLimit
    and .metadata.labels["factory.gwkline.io/profile"] == $p.name
    and .spec.template.metadata.labels["factory.gwkline.io/profile"] == $p.name' "$J" > /dev/null \
    || fail "${name}: Job does not follow its profile"

  jq -e '.spec.template.spec.containers[0].resources.limits["ephemeral-storage"] != null
    and .spec.template.spec.initContainers[0].resources.limits["ephemeral-storage"] != null
    and .spec.ttlSecondsAfterFinished > 0' "$J" > /dev/null \
    || fail "${name}: missing TTL or ephemeral-storage limits"

  jq -e '.spec.template.spec.securityContext == {runAsNonRoot: true, runAsUser: 1000, seccompProfile: {type: "RuntimeDefault"}}
    and ([.spec.template.spec.initContainers[], .spec.template.spec.containers[]]
      | all(.securityContext == {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}))
    and .spec.template.spec.automountServiceAccountToken == false' "$J" > /dev/null \
    || fail "${name}: worker pod is not restricted"

  jq -e '([.spec.template.spec.containers[].env[].name] | any(test("GH_TOKEN|GITHUB_TOKEN|OPENCODE_AUTH_B64")) | not)
    and ([.spec.template.spec.initContainers[0].env[].name] | index("GH_TOKEN") != null)' "$J" > /dev/null \
    || fail "${name}: a credential reaches the agent container, or the clone has none"
done
echo "PASS: code-pr and security Jobs follow their profiles, restricted, with TTL and storage limits"

# A profile edit reaches the next Job without touching the orchestrator.
jq '.ttlSecondsAfterFinished = 600 | .resources.limits.cpu = "3" | .resources.limits["ephemeral-storage"] = "20Gi" | .workSizeLimit = "15Gi"' \
  "${FIX}/code-pr.json" > "${FIX}/edited.json"
render "${FIX}/edited.json" | jq -e '.spec.ttlSecondsAfterFinished == 600
  and .spec.template.spec.containers[0].resources.limits.cpu == "3"
  and .spec.template.spec.containers[0].resources.limits["ephemeral-storage"] == "20Gi"
  and .spec.template.spec.initContainers[0].resources.limits["ephemeral-storage"] == "20Gi"
  and (.spec.template.spec.volumes[] | select(.name == "work") | .emptyDir.sizeLimit) == "15Gi"' > /dev/null \
  || fail "edited profile did not change the rendered Job"
echo "PASS: changing resources, TTL or work size in a profile changes the next Job"
