#!/usr/bin/env bash
# Repo static checks; CI's `validate` job runs this. It does not cover the
# `check` job (ultracite, oxfmt, typecheck, npm test), shell fixture tests,
# or the panel e2e.
#
# Usage: ./scripts/verify.sh
# Needs bash, git, shellcheck, kubectl, jq, openssl and gitleaks. actionlint,
# zizmor and hadolint are skipped when absent, except in CI, which installs
# every tool at a pinned version with scripts/install-ci-tools.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "FAIL: $1" >&2; exit 1; }

# optional_tool <name>: true when installed; outside CI a missing tool skips
# its check.
optional_tool() {
  command -v "$1" >/dev/null 2>&1 && return 0
  [[ -z "${CI:-}" ]] || fail "$1 not installed (scripts/install-ci-tools.sh)"
  echo "  SKIP: $1 not installed"
  return 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> shellcheck ($(git ls-files '*.sh' | wc -l | tr -d ' ') scripts)"
# Every tracked script. Sourced libraries without a shebang declare
# `# shellcheck shell=sh`.
git ls-files -z '*.sh' | xargs -0 shellcheck -S warning || fail 'shell script lint'

echo '==> hadolint (Dockerfiles)'
if optional_tool hadolint; then
  git ls-files -z '*Dockerfile' | xargs -0 hadolint --config .hadolint.yaml || fail 'Dockerfile lint'
fi

echo '==> actionlint (workflows)'
if optional_tool actionlint; then
  actionlint || fail 'workflow lint'
fi

echo '==> zizmor (workflow security)'
if optional_tool zizmor; then
  zizmor --offline --quiet .github/workflows || fail 'workflow security lint'
fi

echo '==> kustomize builds'
# Every base, the non-base kustomizations, and the root (proves the core set
# renders with no duplicate resource IDs). Renders are kept for the reference
# checks below.
mkdir -p "$work/render"
for d in deploy/*/base deploy/namespaces deploy/tailscale \
          clusters/home; do
  kubectl kustomize "$d" >"$work/render/${d//\//_}.yaml" || fail "kustomize build: $d"
done

echo '==> rendered references'
# All renders as one JSON array. `kubectl label --local` is an offline
# YAML-to-JSON converter here; the label it adds is never inspected.
for f in "$work/render"/*.yaml; do
  KUBECONFIG=/dev/null kubectl label --local -f "$f" verify=render -o json
done | jq -s . >"$work/rendered.json"
owner="$(git remote get-url origin | sed -E 's#.*[:/]([^/]+)/[^/]+(\.git)?$#\1#')"
# rendered_check <jq filter>: prints one line per problem the filter emits.
rendered_check() {
  jq -r --arg homelab "ghcr.io/${owner}/homelab/" '
    def pod_template:
      if .kind == "CronJob" then .spec.jobTemplate.spec.template
      elif .kind == "Pod" then .
      elif (.kind | IN("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job")) then .spec.template
      else empty end;
    def ns: .metadata.namespace // "default";
    def ref: "\(.kind)/\(.metadata.name) (\(ns))";
    [ '"$1"' ] | unique | .[] | "  \(.)"' "$work/rendered.json"
}
sa_problems="$(rendered_check '
  [.[] | select(.kind == "ServiceAccount") | "\(ns)/\(.metadata.name)"] as $sas
  | .[] | ref as $ref | ns as $ns
  | pod_template | .spec.serviceAccountName // empty
  | select(IN($sas[]; "\($ns)/\(.)") | not)
  | "\($ref): ServiceAccount \(.) is not in any rendered manifest"')"
if [[ -n "$sa_problems" ]]; then
  echo "$sa_problems"
  fail 'pod template references a missing ServiceAccount'
fi
profile_problems="$(rendered_check '
  [.[] | select(.kind == "NetworkPolicy") | ns as $ns | .spec.podSelector
    | (.matchLabels["factory.gwkline.io/profile"] // empty),
      (.matchExpressions[]? | select(.key == "factory.gwkline.io/profile" and .operator == "In") | .values[])
    | "\($ns)/\(.)"] as $selected
  | .[] | ref as $ref | ns as $ns
  | pod_template | .metadata.labels["factory.gwkline.io/profile"] // empty
  | select(IN($selected[]; "\($ns)/\(.)") | not)
  | "\($ref): no NetworkPolicy selects factory.gwkline.io/profile=\(.)"')"
if [[ -n "$profile_problems" ]]; then
  echo "$profile_problems"
  fail 'factory profile without its own NetworkPolicy'
fi
# Admission does not verify third-party images, so the digest is their only
# integrity pin (docs/adr/adr-004-cosign-admission-verification.md).
digest_problems="$(rendered_check '
  .[] | select(.kind != "CustomResourceDefinition") | ref as $ref
  | .. | objects | .image?
  | if type == "string" then . elif type == "object" then .reference // empty else empty end
  | select(startswith($homelab) | not)
  | select(contains("@sha256:") | not)
  | "\($ref): \(.) is not pinned by digest"')"
if [[ -n "$digest_problems" ]]; then
  echo "$digest_problems"
  fail 'third-party image without a digest'
fi

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

echo '==> no vendor IP ranges in NetworkPolicies'
# Egress is public-internet-minus-private-ranges (docs/egress-policy.md): a
# SaaS CIDR goes stale without notice. Only 0.0.0.0/0 and private/special
# ranges may appear as an ipBlock cidr.
if grep -rnE 'cidr:' deploy/ | awk '
    {
      v = $0
      sub(/.*cidr:[[:space:]]*/, "", v)
      sub(/[[:space:],}#].*/, "", v)
      split(v, o, ".")
      ok = v == "0.0.0.0/0" || o[1] == 10 || o[1] == 127 \
        || (o[1] == 172 && o[2] >= 16 && o[2] <= 31) \
        || (o[1] == 192 && o[2] == 168) || (o[1] == 169 && o[2] == 254) \
        || (o[1] == 100 && o[2] >= 64 && o[2] <= 127)
      if (!ok) { print "  " $0; bad = 1 }
    }
    END { exit !bad }'; then
  fail 'vendor IP range in deploy/ (use public-minus-private egress)'
fi

echo '==> gitleaks rules catch the credential formats this repo handles'
# One synthetic token per rule, named by rule ID and built at run time so no
# tracked file carries one.
rand() { openssl rand -base64 600 | tr -dc 'A-Za-z0-9' | cut -c "1-$1"; }
mkdir -p "$work/canary"
printf 'ops_eyJ%s\n' "$(rand 300)" >"$work/canary/1password-service-account-token"
printf 'ghs_%s\n' "$(rand 36)" >"$work/canary/github-app-token"
printf 'sk-or-v1-%s\n' "$(openssl rand -hex 32)" >"$work/canary/openrouter-api-key"
printf 'sk-ant-oat01-%sAA\n' "$(rand 93)" >"$work/canary/anthropic-oauth-token"
printf 'tskey-client-k%sCNTRL-%s\n' "$(rand 12)" "$(rand 33)" >"$work/canary/tailscale-key"
for f in "$work/canary"/*; do
  rule="$(basename "$f")"
  rc=0
  gitleaks dir --config .gitleaks.toml --enable-rule "$rule" --no-banner --log-level error \
    --exit-code 42 "$f" >/dev/null || rc=$?
  [[ "$rc" == 42 ]] || fail "gitleaks rule $rule does not flag its format (exit $rc)"
done

echo '==> secret scan (gitleaks, working tree)'
# Tracked and untracked-but-not-ignored files, copied out so node_modules and
# other ignored output stay out of the scan. CI also scans mainline history.
repo="$PWD"
mkdir -p "$work/tree"
git ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' f; do if [[ -f "$f" ]]; then printf '%s\0' "$f"; fi; done \
  | tar --null -T - -cf - | tar -xf - -C "$work/tree"
(cd "$work/tree" && gitleaks dir --config "$repo/.gitleaks.toml" --no-banner --no-color --redact -v --log-level warn .) \
  || fail 'secret-looking string in working tree'

echo '==> personal-skills fixture contract'
sh scripts/check-personal-skills.sh >/dev/null || fail 'personal-skills contract (run scripts/check-personal-skills.sh)'

echo '==> homelab image references match the published namespace'
while IFS=: read -r file line; do
  [[ "$line" == *"ghcr.io/${owner}/homelab/"* ]] || fail "foreign image ref in ${file}: ${line}"
done < <(grep -rnE 'image: ghcr\.io/[^/]+/homelab/' deploy/ apps/ examples/ scripts/ || true)

echo 'ALL CHECKS PASSED'
