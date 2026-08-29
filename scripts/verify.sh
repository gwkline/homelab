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

echo '==> factory CronJob schedule collision lint'
# All factory CronJobs firing on the same minute-of-hour pattern hit the GitHub
# API simultaneously (rate-limit noise, races — issue #105). Extract
# spec.schedule from every CronJob in deploy/factory/base/*.yaml and fail when
# two jobs expand to the same minute/hour pattern. The current stagger
# (orchestrator "0 */6", reviewer "0 */3", security "15 */3") stays distinct.
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s\n' "$s"
}
# Expand one cron field ('*', '*/n', 'a', 'a/n', 'a-b', 'a-b/n') into a sorted
# space-separated integer set. Returns 1 on anything unparseable.
expand_cron_field() {
  local field="$1" lo="$2" hi="$3" part range step start end n
  local -a parts=() out=()
  IFS=',' read -ra parts <<< "$field"
  for part in "${parts[@]}"; do
    step=1
    range="$part"
    if [[ "$part" == */* ]]; then
      range="${part%%/*}"
      step="${part#*/}"
      if [[ ! "$step" =~ ^[0-9]+$ ]] || (( 10#$step == 0 )); then return 1; fi
      step=$((10#$step))
    fi
    if [[ "$range" == '*' ]]; then
      start="$lo"
      end="$hi"
    elif [[ "$range" =~ ^([0-9]+)-([0-9]+)$ ]]; then
      start=$((10#${BASH_REMATCH[1]}))
      end=$((10#${BASH_REMATCH[2]}))
    elif [[ "$range" =~ ^[0-9]+$ ]]; then
      start=$((10#$range))
      if [[ "$part" == */* ]]; then end="$hi"; else end="$start"; fi
    else
      return 1
    fi
    if (( start < lo || end > hi || start > end )); then return 1; fi
    for (( n = start; n <= end; n += step )); do
      out+=("$n")
    done
  done
  ((${#out[@]})) || return 1
  printf '%s\n' "${out[@]}" | sort -nu | tr '\n' ' '
}
# Fail when two CronJobs under $1 declare spec.schedule values that expand to
# the same minute/hour pattern (they would fire at exactly the same times).
check_cronjob_schedule_collisions() {
  local dir="$1" file line val kind doc_name sched mset hset key m h dom mon dow extra
  local -A key_owner=()
  for file in "$dir"/*.yaml; do
    [[ -f "$file" ]] || continue
    kind=''
    doc_name=''
    sched=''
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        '---'*)
          kind='' doc_name='' sched=''
          continue
          ;;
        kind:*)
          if [[ "$line" =~ ^kind:[[:space:]]*CronJob[[:space:]]*$ ]]; then
            kind='CronJob'
          fi
          continue
          ;;
      esac
      [[ "$kind" == 'CronJob' ]] || continue
      case "$line" in
        '  name:'*)
          if [[ -z "$doc_name" ]]; then
            doc_name="$(trim "${line#*:}")"
          fi
          ;;
        '  schedule:'*)
          if [[ -z "$sched" ]]; then
            sched='seen'
            val="$(trim "${line#*:}")"
            case "$val" in
              '"'*) val="${val#\"}" ; val="${val%%\"*}" ;;
              "'"*) val="${val#\'}" ; val="${val%%\'*}" ;;
              *'#'*) val="${val%%#*}" ; val="$(trim "$val")" ;;
            esac
            [[ -n "$val" ]] || continue
            read -r m h dom mon dow extra <<< "$val"
            key="RAW:${val}"
            if [[ -z "$extra" && -n "${m:-}" && -n "${h:-}" ]] \
               && mset="$(expand_cron_field "$m" 0 59)" \
               && hset="$(expand_cron_field "$h" 0 23)"; then
              key="M[${mset}]H[${hset}]${dom}|${mon}|${dow}"
            fi
            if [[ -n "${key_owner[$key]:-}" ]]; then
              {
                echo "  CronJob schedule collision — identical minute/hour pattern: ${key}"
                echo "    first:  ${key_owner[$key]}"
                echo "    second: ${file}: ${doc_name:-<unnamed>} (schedule: \"${val}\")"
              } >&2
              return 1
            fi
            key_owner["$key"]="${file}: ${doc_name:-<unnamed>} (schedule: \"${val}\")"
          fi
          ;;
      esac
    done < "$file"
  done
  return 0
}
if ! check_cronjob_schedule_collisions deploy/factory/base; then
  fail 'factory CronJob schedule collision (deploy/factory/base)'
fi

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
# "e.g. tail<...>.ts.net" doc examples are allowed; only real-looking suffixes
# outside comment/placeholder contexts fail.
if grep -rnE '[a-z0-9][a-z0-9-]*\.ts\.net' scripts/ deploy/ apps/ bootstrap/ examples/ docs/ README.md \
    | grep -v '<tailnet>' | grep -viE 'e\.g\.|for example|never hard-coded' | grep .; then
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

echo '==> image refs on the latest tag are grandfathered, not extended'
# Digest-pinned images are the end goal (issue #91): a mutable latest tag makes
# rollbacks and audits ambiguous. Every image ref ending in the latest tag must
# be in the grandfather allowlist below (path:ref); anything new fails so
# factory-authored PRs pin a digest instead (issue #109). Grep-only on the
# working tree — no kubectl. Matches YAML image keys and JSON "image" keys;
# imagePullPolicy lines are excluded by design.
grandfathered_latest=(
  'deploy/tailscale/serve-fixer.yaml:ghcr.io/gwkline/homelab/loop-agent:latest'
  'deploy/factory/base/reviewer-cronjob.yaml:ghcr.io/gwkline/homelab/factory/reviewer:latest'
  'deploy/factory/base/security-cronjob.yaml:ghcr.io/gwkline/homelab/factory/security:latest'
  'deploy/factory/base/profile-security.yaml:ghcr.io/gwkline/homelab/factory/security:latest'
  'deploy/factory/base/profile-reviewer.yaml:ghcr.io/gwkline/homelab/factory/reviewer:latest'
  'deploy/factory/base/profile-code-pr.yaml:ghcr.io/gwkline/homelab/factory/worker:latest'
)
new_latest=0
while IFS= read -r hit; do
  [[ -n "$hit" ]] || continue
  file="${hit%%:*}"
  rest="${hit#*:}"
  rest="${rest#*:}"
  ref="$(trim "$rest")"
  ref="${ref#*- }"
  ref="${ref//[\"\']/}"
  ref="${ref#image:}"
  ref="${ref%%#*}"
  ref="$(trim "$ref")"
  ref="${ref%,}"
  grand=''
  for g in "${grandfathered_latest[@]}"; do
    if [[ "$g" == "${file}:${ref}" ]]; then grand=1; break; fi
  done
  if [[ -n "$grand" ]]; then
    echo "  grandfathered: ${hit}"
  else
    echo "  NEW image ref on the latest tag — pin to a digest: ${hit}" >&2
    new_latest=1
  fi
done < <(grep -rnEI "(^|[[:space:]])\"?image\"?:[[:space:]]*\"?[^[:space:]]+:latest\"?([[:space:]]|,|\$)" deploy/ apps/ examples/ scripts/ || true)
if (( new_latest )); then
  fail 'new image ref on the latest tag — pin to an immutable digest (issue #91)'
fi

echo 'ALL CHECKS PASSED'
