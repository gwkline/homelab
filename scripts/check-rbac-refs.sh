#!/bin/sh
# Enforce bare API groups in RBAC role references (issue #7).
#
# A RoleBinding/ClusterRoleBinding `roleRef.apiGroup` must carry the API
# group only (`rbac.authorization.k8s.io`) — a group/version pair such as
# `rbac.authorization.k8s.io/v1` is not a valid role reference: the API
# server rejects the whole RoleBinding at admission, so the bound
# ServiceAccount silently receives none of the Role's permissions. Kustomize
# renders both forms equally well, so the regression only surfaces against a
# real API server — this check catches it at lint time instead.
#
# Runs in the CI validate job beside scripts/verify.sh — verify.sh itself is
# bash and must stay untouched by dash-gated worker edits (see ci.yaml).
# Scans every YAML manifest under deploy/ and only top-level `roleRef:` keys
# (the RoleBinding/ClusterRoleBinding field), so `apiVersion:` lines and the
# `roleRef:` strings inside CRD schemas are never confused with it.
set -eu

cd "$(dirname "$0")/.."

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

if ! command -v awk >/dev/null 2>&1 || ! command -v find >/dev/null 2>&1; then
  fail 'awk and find are required'
fi

# Emit "file:line: ..." for every roleRef.apiGroup that carries a version
# suffix (any '/' at all), and exit non-zero when at least one is found.
scan() {
  find deploy -type f \( -name '*.yaml' -o -name '*.yml' \) -print0 |
    xargs -0 awk '
      /^---/ { in_ref = 0; next }
      /^roleRef:/ { in_ref = 1; next }
      in_ref && /^[^[:space:]]/ { in_ref = 0; next }
      in_ref && /^[[:space:]]+apiGroup:/ {
        group = $0
        sub(/^[[:space:]]+apiGroup:[[:space:]]*/, "", group)
        sub(/#.*$/, "", group)
        sub(/[[:space:]]+$/, "", group)
        if (group ~ /\//) {
          printf "%s:%d: roleRef.apiGroup must be a bare API group, got %s\n", FILENAME, FNR, group
          bad = 1
        }
      }
      END { exit bad ? 1 : 0 }
    '
}

if ! hits="$(scan)"; then
  [ -n "$hits" ] && printf '%s\n' "$hits" >&2
  fail 'versioned roleRef.apiGroup — use the bare API group, e.g. rbac.authorization.k8s.io (issue #7)'
fi

echo 'all roleRef.apiGroup values are bare API groups'
