#!/usr/bin/env bash
# Repo static checks; CI's `validate` job runs this. It does not cover the
# `check` job (ultracite, oxfmt, typecheck, npm test), shell fixture tests,
# or the panel e2e.
#
# Usage: ./scripts/verify.sh   (needs bash, shellcheck, kubectl, git)
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }

echo '==> shellcheck'
# Fail on errors; print warnings without failing.
if ! shellcheck -S error bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh >/dev/null 2>&1; then
  shellcheck -S error bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh 2>&1 | head -n 80
  fail 'shell script lint (error)'
fi
shellcheck bootstrap/*.sh apps/shared/*.sh apps/factory/**/run.sh apps/factory/**/entrypoint.sh apps/factory/**/run-reviewer.sh apps/*/run-*.sh apps/*/init-*.sh scripts/*.sh 2>&1 | head -n 100 || true

echo '==> kustomize builds'
# Every base, the non-base kustomizations, and the root (proves the core set
# renders with no duplicate resource IDs).
for d in deploy/*/base deploy/namespaces deploy/tailscale \
          clusters/home; do
  kubectl kustomize "$d" >/dev/null || fail "kustomize build: $d"
done

echo '==> factory CronJob schedule collision lint'
# Two factory CronJobs whose schedules expand to the same minute/hour pattern
# hit the GitHub API at the same instant; fail on any such pair.
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
  local -a key_keys=() key_owners=()
  local idx
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
            idx=-1
            for i in "${!key_keys[@]}"; do
              if [[ "${key_keys[$i]}" == "$key" ]]; then idx="$i"; break; fi
            done
            if (( idx >= 0 )); then
              {
                echo "  CronJob schedule collision — identical minute/hour pattern: ${key}"
                echo "    first:  ${key_owners[$idx]}"
                echo "    second: ${file}: ${doc_name:-<unnamed>} (schedule: \"${val}\")"
              } >&2
              return 1
            fi
            key_keys+=("$key")
            key_owners+=("${file}: ${doc_name:-<unnamed>} (schedule: \"${val}\")")
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

echo '==> tailscale exposure declares hostname + required tags'
# Per rendered document: a LoadBalancer Service with loadBalancerClass:
# tailscale needs tailscale.com/hostname + tailscale.com/tags=tag:k8s-operator;
# an Ingress with ingressClassName: tailscale needs the tags annotation and a
# tls host (its tailnet hostname).
for d in deploy/*/base; do
  if ! kubectl kustomize "$d" | awk '
      function check() {
        if (lb && (!host || !tags)) { print "  tailscale Service " name ": missing tailscale.com/hostname or tailscale.com/tags=tag:k8s-operator"; bad = 1 }
        if (ing && (!tags || !tlshost)) { print "  tailscale Ingress " name ": missing tailscale.com/tags=tag:k8s-operator or spec.tls[0].hosts"; bad = 1 }
      }
      /^---/ { check(); lb = 0; ing = 0; host = 0; tags = 0; tlshost = 0; name = "" }
      /^  name:/ && name == "" { name = $2 }
      /loadBalancerClass:[[:space:]]*tailscale/ { lb = 1 }
      /ingressClassName:[[:space:]]*tailscale/ { ing = 1 }
      /tailscale\.com\/hostname:/ { host = 1 }
      /tailscale\.com\/tags:/ && /tag:k8s-operator/ { tags = 1 }
      /^  - hosts:/ { tlshost = 1 }
      END { check(); exit bad }'; then
    fail "tailscale exposure annotations: $d"
  fi
done

echo '==> no hard-coded personal tailnet DNS suffix'
# The tailnet suffix is runtime config (deploy/tailscale/README.md), never
# committed. `<tailnet>` placeholders and "e.g." examples are allowed.
if grep -rnE '[a-z0-9][a-z0-9-]*\.ts\.net' scripts/ deploy/ apps/ bootstrap/ examples/ docs/ README.md \
    | grep -v '<tailnet>' | grep -viE 'e\.g\.|for example|never hard-coded' | grep .; then
  fail 'hard-coded tailnet DNS suffix committed'
fi

echo '==> secret patterns (working tree)'
# Tracked + untracked files only; history is not scanned. Excluded files hold
# redaction/scan patterns or synthetic fixtures by design.
pattern='(github_pat_|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bp]-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|tskey-auth-)'
secret_exclusions=':!scripts/verify.sh :!deploy/loki/base/alloy.yaml :!apps/shared/skills-lib.sh :!apps/factory/github-app/tests/token-service.test.ts :!apps/knowledge/tests/git-source.test.ts :!apps/factory/collector/tests/collector.test.ts :!deploy/loki/README.md'
# shellcheck disable=SC2086 # pathspecs are a word list
if git grep --untracked -nIE "$pattern" -- $secret_exclusions 2>/dev/null | grep .; then
  fail 'secret-looking string in working tree'
fi

echo '==> personal-skills fixture contract'
sh scripts/check-personal-skills.sh >/dev/null || fail 'personal-skills contract (run scripts/check-personal-skills.sh)'

echo '==> homelab image references match the published namespace'
owner="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#')"
while IFS=: read -r file line; do
  [[ "$line" == *"ghcr.io/${owner}/homelab/"* ]] || fail "foreign image ref in ${file}: ${line}"
done < <(grep -rnE 'image: ghcr\.io/[^/]+/homelab/' deploy/ apps/ examples/ scripts/ || true)

echo 'ALL CHECKS PASSED'
