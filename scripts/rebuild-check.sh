#!/bin/sh
# Live-cluster conformance check: after a rebuild, an upgrade, or to look for
# drift. Exits 0 only when every check passes; any failure, including an
# unreachable API server or a kubectl error, exits 1.
#
# Usage: KUBECONFIG=... ./scripts/rebuild-check.sh [--phase cluster|manual|all]
#   cluster  what a fresh cluster must pass with no human steps; the recovery
#            drill runs this phase
#   manual   what needs the manual steps in docs/rebuild-runbook.md 3.10
#   all      both (default)
set -u
cd "$(dirname "$0")/.." || exit 1

usage() {
  echo "usage: $0 [--phase cluster|manual|all]" >&2
  exit 2
}

PHASE=all
case "${1:-}" in
  '') ;;
  --phase) [ $# -eq 2 ] || usage; PHASE=$2 ;;
  *) usage ;;
esac
case "$PHASE" in
  cluster | manual | all) ;;
  *) usage ;;
esac

# Namespaces this repo owns; a workload anywhere in them must come from git.
HOMELAB_NS="agents sandbox work database"
# Bases applied outside clusters/home: the server-side operators (3.2, 3.5),
# the operator-namespace policies (3.7), knowledge and executor (3.9) in
# docs/rebuild-runbook.md. Their objects may be live, so they count as
# rendered.
EXTRA_BASES="deploy/eso/base deploy/cnpg/base deploy/operator-policies/base deploy/knowledge/base deploy/executor/base"
DEPLOYER_MAX_AGE=900

fail=0
ok() { printf '  ok: %s\n' "$*"; }
bad() {
  printf '  FAIL: %s\n' "$*"
  fail=1
}
warn() { printf '  WARN: %s\n' "$*"; }

# RFC 3339 UTC timestamp (2026-10-07T21:52:42Z) to Unix seconds, without
# GNU/BSD date differences.
to_epoch() {
  printf '%s\n' "$1" | awk '{
    y = substr($0, 1, 4) + 0; m = substr($0, 6, 2) + 0; d = substr($0, 9, 2) + 0
    a = int((14 - m) / 12); yy = y + 4800 - a; mm = m + 12 * a - 3
    days = d + int((153 * mm + 2) / 5) + 365 * yy + int(yy / 4) - int(yy / 100) + int(yy / 400) - 32045 - 2440588
    print days * 86400 + substr($0, 12, 2) * 3600 + substr($0, 15, 2) * 60 + substr($0, 18, 2)
  }'
}

if ! kubectl get --raw=/readyz --request-timeout=10s >/dev/null 2>&1; then
  echo "FAIL: API server unreachable (KUBECONFIG=${KUBECONFIG:-<default>})" >&2
  exit 1
fi

cluster_checks() {
  echo "== nodes: Ready, no pressure, kubelet matches the pin =="
  # shellcheck disable=SC2016 # the pattern matches a literal ${...}
  pin=$(sed -n 's/^K3S_VERSION="\${K3S_VERSION:-\(.*\)}"$/\1/p' bootstrap/bootstrap.sh)
  nodes=$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.nodeInfo.kubeletVersion}{" ,"}{range .status.conditions[*]}{.type}={.status}{","}{end}{"\n"}{end}') ||
    bad "cannot list nodes"
  while read -r name ver conds; do
    [ -n "$name" ] || continue
    if [ "$ver" = "$pin" ]; then
      ok "node $name kubelet $ver"
    else
      bad "node $name kubelet $ver, pinned $pin (re-run bootstrap/bootstrap.sh)"
    fi
    case "$conds" in
      *,Ready=True,*) ok "node $name Ready" ;;
      *) bad "node $name not Ready" ;;
    esac
    for p in MemoryPressure DiskPressure PIDPressure; do
      case "$conds" in
        *",$p=True,"*) bad "node $name $p" ;;
      esac
    done
  done <<EOF
$nodes
EOF

  echo "== node IP in the repo matches the API endpoint =="
  # NetworkPolicies allow the API by the node IP from clusters/home/node; a
  # server that came back on another address breaks them silently.
  rendered=$(kubectl kustomize deploy/policies/base 2>/dev/null |
    awk '/name: headlamp-kube-api/ { f = 1 } f && /cidr:/ { n++; if (n == 2) { sub(/.*cidr: */, ""); sub(/\/.*/, ""); print; exit } }')
  live=$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes \
    -o jsonpath='{.items[*].endpoints[*].addresses[*]}') || bad "cannot read the kubernetes EndpointSlice"
  if [ -z "$rendered" ]; then
    bad "no node IP rendered from deploy/policies/base"
  else
    case " $live " in
      *" $rendered "*) ok "API endpoint $rendered matches clusters/home/node" ;;
      *) bad "API endpoint '$live' != rendered node IP '$rendered' (update clusters/home/node/node.yaml)" ;;
    esac
  fi

  echo "== manifest conformance (kubectl diff) =="
  # Live homelab images are digests resolved by deploy/deployer while git says
  # :latest, so image lines (and the generation they bump) are not drift.
  # kubectl diff exits 0 for no diff, 1 for a diff, and above 1 on error.
  diff_out=$(kubectl diff -k clusters/home 2>&1)
  rc=$?
  if [ "$rc" -gt 1 ]; then
    printf '%s\n' "$diff_out" | tail -n 20
    bad "kubectl diff -k clusters/home failed (exit $rc)"
  else
    drift=$(printf '%s\n' "$diff_out" | grep -E '^[-+] ' | grep -vE '^[-+] +(- )?"?(image|generation)"?: ')
    if [ -n "$drift" ]; then
      printf '%s\n' "$drift" | head -n 40
      bad "drift: clusters/home"
    else
      ok "clusters/home matches the live cluster"
    fi
  fi

  echo "== live objects not in the render =="
  # Report only: apply never prunes, so anything removed from git lingers until
  # deleted by hand. Labelled objects of any kind, plus unlabelled workloads in
  # homelab namespaces (the deployer applies some files without kustomize
  # labels). Controller-owned objects are skipped.
  render=$(for d in clusters/home $EXTRA_BASES; do
    if [ -d "$d" ]; then
      kubectl kustomize "$d" || echo "RENDER-FAILED"
      echo ---
    fi
  done | awk '
    /^---/ { if (k != "") print k "/" ns "/" n; k = ""; n = ""; ns = ""; meta = 0; next }
    /^RENDER-FAILED$/ { print; next }
    /^kind:/ { k = $2 }
    /^[^ ]/ { meta = ($0 ~ /^metadata:/) ; next }
    meta && /^  name:/ && n == "" { n = $2 }
    meta && /^  namespace:/ && ns == "" { ns = $2 }
    END { if (k != "") print k "/" ns "/" n }' | sort -u)
  kinds=$(kubectl api-resources --verbs=list -o name 2>/dev/null |
    grep -vE '^(events|events\.events\.k8s\.io|pods|jobs\.batch|replicasets\.apps|endpoints|endpointslices\.discovery\.k8s\.io|controllerrevisions\.apps|leases\.coordination\.k8s\.io|componentstatuses)$' |
    paste -sd, -)
  fmt='{range .items[*]}{.kind}/{.metadata.namespace}/{.metadata.name} {.metadata.ownerReferences[0].kind}{"\n"}{end}'
  live=$(
    kubectl get "$kinds" -A -l app.kubernetes.io/part-of=homelab -o jsonpath="$fmt" || echo "LIST-FAILED"
    for ns in $HOMELAB_NS; do
      kubectl get deployments,statefulsets,cronjobs,networkpolicies -n "$ns" -o jsonpath="$fmt" || echo "LIST-FAILED"
    done
  )
  case "$render$live" in
    *RENDER-FAILED* | *LIST-FAILED*) warn "orphan scan incomplete (render or list failed)" ;;
  esac
  orphans=$(printf '%s\n' "$live" | awk 'NF == 1 { print $1 }' | sort -u |
    while read -r key; do
      printf '%s\n' "$render" | grep -qxF "$key" || printf '%s\n' "$key"
    done)
  if [ -n "$orphans" ]; then
    printf '%s\n' "$orphans" | sed 's/^/    /'
    warn "live objects above are not in git; delete them or add them back"
  else
    ok "no orphans"
  fi

  echo "== workloads ready =="
  wl=$(kubectl get deployments,statefulsets -A -o jsonpath='{range .items[*]}{.kind}/{.metadata.namespace}/{.metadata.name} {.spec.replicas} {.status.readyReplicas}{"\n"}{end}') ||
    bad "cannot list workloads"
  notready=$(printf '%s\n' "$wl" | awk 'NF >= 2 && ($3 + 0) < ($2 + 0) { print $1 " (" ($3 + 0) "/" $2 ")" }')
  if [ -n "$notready" ]; then
    printf '%s\n' "$notready" | while read -r w; do bad "$w not ready"; done
    fail=1
  else
    ok "every Deployment and StatefulSet is ready ($(printf '%s\n' "$wl" | grep -c .))"
  fi

  echo "== image admission (policy-controller) =="
  avail=$(kubectl -n cosign-system get deploy policy-controller-webhook \
    -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null)
  if [ "$avail" = "True" ]; then
    ok "policy-controller-webhook Available"
  else
    bad "policy-controller-webhook not Available (${avail:-missing}); docs/rebuild-runbook.md 3.4"
  fi

  echo "== secret sync (ESO) =="
  stores=$(kubectl get clustersecretstores,secretstores -A -o jsonpath='{range .items[*]}{.kind}/{.metadata.namespace}/{.metadata.name} {.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}') ||
    bad "cannot list secret stores"
  [ -n "$stores" ] || bad "no secret store exists"
  ess=$(kubectl get externalsecrets -A -o jsonpath='{range .items[*]}{.kind}/{.metadata.namespace}/{.metadata.name} {.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}') ||
    bad "cannot list ExternalSecrets"
  printf '%s\n%s\n' "$stores" "$ess" | while read -r obj state; do
    [ -n "$obj" ] || continue
    if [ "$state" = "True" ]; then ok "$obj Ready"; else echo "  FAIL: $obj not Ready (${state:-no status})"; fi
  done
  if printf '%s\n%s\n' "$stores" "$ess" | awk 'NF && $2 != "True" { found = 1 } END { exit !found }'; then
    fail=1
  fi

  echo "== postgres (CNPG) =="
  pg=$(kubectl -n database get cluster pg-primary -o jsonpath='{.status.phase}|{.status.readyInstances}|{.spec.instances}' 2>/dev/null)
  case "$pg" in
    "Cluster in healthy state|"*)
      ready=$(printf '%s' "$pg" | cut -d'|' -f2)
      want=$(printf '%s' "$pg" | cut -d'|' -f3)
      if [ "${ready:-0}" = "$want" ]; then ok "pg-primary healthy, $ready/$want ready"; else bad "pg-primary ${ready:-0}/$want instances ready"; fi
      ;;
    *) bad "pg-primary not healthy (${pg:-missing}): kubectl -n database get cluster pg-primary" ;;
  esac

  echo "== deployer =="
  last=$(kubectl -n agents get cronjob deployer -o jsonpath='{.status.lastSuccessfulTime}' 2>/dev/null)
  if [ -z "$last" ]; then
    bad "deployer has never succeeded"
  else
    age=$(($(date -u +%s) - $(to_epoch "$last")))
    if [ "$age" -le "$DEPLOYER_MAX_AGE" ]; then
      ok "deployer last succeeded ${age}s ago"
    else
      bad "deployer last succeeded ${age}s ago (limit ${DEPLOYER_MAX_AGE}s): {job_name=~\"deployer-.*\"} in Loki"
    fi
  fi

  echo "== tailscale exposure =="
  # HTTPS 443 is what users open. TLS errors (curl exit != 0) and non-200s
  # both fail. Hostnames come from each Tailscale Ingress's status.
  check_https() { # <namespace> <ingress> <required: 1|0> [path, default /]
    h=$(kubectl get ingress "$2" -n "$1" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
    if [ -z "$h" ]; then
      if [ "$3" = 1 ]; then
        bad "ingress $1/$2 has no tailnet hostname yet"
      else
        warn "ingress $1/$2 has no tailnet hostname (not deployed?)"
      fi
      return
    fi
    url="https://${h}${4:-/}"
    code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "$url")
    curl_rc=$?
    if [ "$curl_rc" -ne 0 ]; then
      bad "$url request failed (curl exit $curl_rc: certificate/TLS or connection error; code $code)"
    elif [ "$code" = "200" ]; then
      ok "$url -> 200"
    else
      bad "$url -> $code (proxy logs: kubectl logs -n tailscale -l tailscale.com/parent-resource=$2)"
    fi
  }
  check_https agents t3code-0 1
  check_https agents panel 1
  check_https work work-t3code-0 0
  check_https agents grafana 0
  check_https agents headlamp 0
  check_https agents homepage 0
  check_https agents cloudbeaver 0
  # An API with no page at /; its liveness route proves the proxy path.
  check_https agents knowledge 0 /healthz

  # Every tailscale LoadBalancer Service needs its hostname, and every
  # tailscale Service or Ingress needs tags=tag:k8s-operator (the static
  # check in scripts/verify.sh, against live objects).
  svcs=$(kubectl get svc -A \
    -o jsonpath='{range .items[?(@.spec.loadBalancerClass=="tailscale")]}{.metadata.namespace} {.metadata.name} {.metadata.annotations.tailscale\.com/hostname} {.metadata.annotations.tailscale\.com/tags}{"\n"}{end}') ||
    bad "cannot list Services"
  while read -r ns name host tags; do
    [ -n "$name" ] || continue
    if [ -n "$host" ] && [ "$tags" = "tag:k8s-operator" ]; then
      ok "svc $ns/$name ($host, $tags)"
    else
      bad "svc $ns/$name missing tailscale.com/hostname or tags=tag:k8s-operator (host='$host' tags='$tags')"
    fi
  done <<EOF
$svcs
EOF
  ings=$(kubectl get ingress -A \
    -o jsonpath='{range .items[?(@.spec.ingressClassName=="tailscale")]}{.metadata.namespace} {.metadata.name} {.metadata.annotations.tailscale\.com/tags}{"\n"}{end}') ||
    bad "cannot list Ingresses"
  while read -r ns name tags; do
    [ -n "$name" ] || continue
    if [ "$tags" = "tag:k8s-operator" ]; then
      ok "ingress $ns/$name ($tags)"
    else
      bad "ingress $ns/$name missing tailscale.com/tags=tag:k8s-operator (got '$tags')"
    fi
  done <<EOF
$ings
EOF

  # deploy/tailscale/values.yaml sets proxyConfig.defaultTags -> PROXY_TAGS.
  ptags=$(kubectl get deploy operator -n tailscale \
    -o jsonpath='{.spec.template.spec.containers[*].env[?(@.name=="PROXY_TAGS")].value}' 2>/dev/null)
  if [ "$ptags" = "tag:k8s-operator" ]; then
    ok "operator PROXY_TAGS=tag:k8s-operator"
  else
    bad "operator PROXY_TAGS='$ptags' (reinstall with -f deploy/tailscale/values.yaml)"
  fi
}

manual_checks() {
  echo "== hermes gateway (after hermes setup --portal) =="
  gw=$(kubectl exec -n agents hermes-0 -- sh -c 'ps aux | grep -c "[g]ateway run"' 2>/dev/null)
  if [ "${gw:-0}" -ge 1 ]; then
    ok "gateway running"
  else
    bad "gateway not running: run the hermes step in docs/rebuild-runbook.md 3.10"
  fi
}

case "$PHASE" in
  cluster) cluster_checks ;;
  manual) manual_checks ;;
  all)
    cluster_checks
    manual_checks
    ;;
esac

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASS ($PHASE)"
else
  echo "CHECKS FAILED ($PHASE)"
  exit 1
fi
