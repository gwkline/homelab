#!/usr/bin/env bash
# Runs every check CI runs. Must pass before pushing.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }

echo '==> shellcheck'
# Strictness: fail on errors, allow warnings/info (existing repo has intentional WORKDIR/ISSUE_BODY patterns).
# The outer `if ! shellcheck` would trip on any warning (exit 1), so gate on -S error.
if ! shellcheck -S error bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh >/dev/null 2>&1; then
  shellcheck -S error bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh 2>&1 | head -n 80
  fail 'shell script lint (error)'
fi
# Also show warnings for visibility without failing
shellcheck bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh 2>&1 | head -n 100 || true

echo '==> kustomize builds'
for d in deploy/*/base; do
  kubectl kustomize "$d" >/dev/null || fail "kustomize build: $d"
done

echo '==> tailscale Services declare hostname + required tags'
# Every LoadBalancer Service with loadBalancerClass: tailscale must declare
# tailscale.com/hostname and tailscale.com/tags=tag:k8s-operator (issue #92).
for d in deploy/*/base; do
  if ! kubectl kustomize "$d" | awk '
      /^---/ { lb = 0; host = 0; tags = 0 }
      /loadBalancerClass:[[:space:]]*tailscale/ { lb = 1 }
      /tailscale\.com\/hostname:/ { host = 1 }
      /tailscale\.com\/tags:/ && /tag:k8s-operator/ { tags = 1 }
      END {
        if (lb && (!host || !tags)) {
          print "  exposed Service missing tailscale.com/hostname or tailscale.com/tags=tag:k8s-operator"
          exit 1
        }
      }'; then
    fail "tailscale Service annotations: $d"
  fi
done

echo '==> no hard-coded personal tailnet DNS suffix'
# Tailnet suffix must come from the single documented value (see
# deploy/tailscale/README.md), never be committed. `<tailnet>` placeholders are fine.
if grep -rnE '[a-z0-9][a-z0-9-]*\.ts\.net' scripts/ deploy/ apps/ bootstrap/ examples/ docs/ README.md \
    | grep -v '<tailnet>' | grep .; then
  fail 'hard-coded tailnet DNS suffix committed'
fi

echo '==> secret patterns (working tree + all reachable history)'
pattern='(github_pat_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|tskey-auth-)'
if git grep --untracked -nIE "$pattern" -- ':!scripts/verify.sh' 2>/dev/null | grep .; then
  fail 'secret-looking string in working tree'
fi
if git grep -nIE "$pattern" "$(git rev-list --all)" -- ':!scripts/verify.sh' 2>/dev/null | grep .; then
  fail 'secret-looking string found in history'
fi

echo '==> homelab image references match the published namespace'
owner="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#')"
while IFS=: read -r file line; do
  [[ "$line" == *"ghcr.io/${owner}/homelab/"* ]] || fail "foreign image ref in ${file}: ${line}"
done < <(grep -rnE 'image: ghcr\.io/[^/]+/homelab/' deploy/ apps/ examples/ scripts/ || true)

echo 'ALL CHECKS PASSED'
