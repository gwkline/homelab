#!/usr/bin/env bash
# Post-bring-up conformance sweep: verifies live cluster matches git and all
# workloads are healthy. Exit 0 = clean. Run after any rebuild or drift check.
#
# Usage: KUBECONFIG=... ./scripts/rebuild-check.sh
set -u
cd "$(dirname "$0")/.." || exit 1

fail=0

echo "== 1. manifest conformance (kubectl diff) =="
# Live homelab images are digests resolved by deploy/deployer while git says
# :latest, so image lines (and the generation they bump) are not drift.
drift=$(kubectl diff -k clusters/home \
  | grep -E '^[-+] ' | grep -vE '^[-+] +(- )?"?(image|generation)"?: ' || true)
if [ -n "$drift" ]; then
  printf '%s\n' "$drift" | head -40
  echo "  DRIFT: clusters/home"
  fail=1
else
  echo "  ok: clusters/home"
fi

echo "== 2. workloads Running =="
for pod in hermes-0 t3code-0; do
  status=$(kubectl get pod "$pod" -n agents -o jsonpath='{.status.phase}' 2>/dev/null)
  if [ "$status" = "Running" ]; then
    echo "  ok: $pod"
  else
    echo "  FAIL: $pod ($status)"
    fail=1
  fi
done

echo "== 3. gateway process inside hermes =="
gw=$(kubectl exec -n agents hermes-0 -- sh -c 'ps aux | grep -c "[g]ateway run"' 2>/dev/null)
if [ "${gw:-0}" -ge 1 ]; then
  echo "  ok: gateway running"
else
  echo "  FAIL: gateway not running (HERMES_COMMAND set?)"
  fail=1
fi

echo "== 4. tailscale exposure =="
# HTTPS 443 is the supported endpoint: check the URL users open. TLS errors
# (curl exit != 0) and non-200s both fail. Hostnames come from each Tailscale
# Ingress's status.
check_https() { # <namespace> <ingress> <required: 1|0>
  h=$(kubectl get ingress "$2" -n "$1" -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
  if [ -z "$h" ]; then
    if [ "$3" = 1 ]; then
      echo "  FAIL: ingress $1/$2 has no tailnet hostname yet"
      fail=1
    else
      echo "  WARN: ingress $1/$2 has no tailnet hostname (not deployed?)"
    fi
    return
  fi
  code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "https://${h}/")
  curl_rc=$?
  if [ "$curl_rc" -ne 0 ]; then
    echo "  FAIL: https://$h request failed (curl exit $curl_rc — certificate/TLS or connection error; code $code)"
    fail=1
  elif [ "$code" = "200" ]; then
    echo "  ok: https://$h -> 200"
  else
    echo "  FAIL: https://$h -> $code (proxy logs: kubectl logs -n tailscale -l tailscale.com/parent-resource=$2)"
    fail=1
  fi
}
check_https agents t3code-0 1
check_https agents panel 1
check_https work work-t3code-0 0
check_https agents grafana 0
check_https agents headlamp 0
check_https agents homepage 0
check_https agents cloudbeaver 0
check_https agents knowledge 0

echo "== 5. tailscale exposure annotations =="
# Every tailscale LoadBalancer Service must declare its hostname, and every
# tailscale-exposed Service or Ingress must carry tags=tag:k8s-operator
# (mirrors the static check in scripts/verify.sh). The lists are read into
# variables + here-docs (not process substitution) so the file stays
# POSIX-parseable (dash -n).
svcs=$(kubectl get svc -A \
  -o jsonpath='{range .items[?(@.spec.loadBalancerClass=="tailscale")]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' 2>/dev/null)
while IFS=' ' read -r ns name; do
  [ -n "$name" ] || continue
  host=$(kubectl get svc "$name" -n "$ns" \
    -o jsonpath='{.metadata.annotations.tailscale\.com/hostname}' 2>/dev/null)
  tags=$(kubectl get svc "$name" -n "$ns" \
    -o jsonpath='{.metadata.annotations.tailscale\.com/tags}' 2>/dev/null)
  if [ -n "$host" ] && [ "$tags" = "tag:k8s-operator" ]; then
    echo "  ok: svc $ns/$name ($host, $tags)"
  else
    echo "  FAIL: svc $ns/$name missing tailscale.com/hostname or tags=tag:k8s-operator (got host='$host' tags='$tags')"
    fail=1
  fi
done <<EOF
$svcs
EOF
ings=$(kubectl get ingress -A \
  -o jsonpath='{range .items[?(@.spec.ingressClassName=="tailscale")]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' 2>/dev/null)
while IFS=' ' read -r ns name; do
  [ -n "$name" ] || continue
  tags=$(kubectl get ingress "$name" -n "$ns" \
    -o jsonpath='{.metadata.annotations.tailscale\.com/tags}' 2>/dev/null)
  if [ "$tags" = "tag:k8s-operator" ]; then
    echo "  ok: ingress $ns/$name ($tags)"
  else
    echo "  FAIL: ingress $ns/$name missing tailscale.com/tags=tag:k8s-operator (got '$tags')"
    fail=1
  fi
done <<EOF
$ings
EOF

echo "== 6. operator proxy tag =="
# deploy/tailscale/values.yaml sets proxyConfig.defaultTags -> PROXY_TAGS.
ptags=$(kubectl get deploy operator -n tailscale \
  -o jsonpath='{.spec.template.spec.containers[*].env[?(@.name=="PROXY_TAGS")].value}' 2>/dev/null)
if [ "$ptags" = "tag:k8s-operator" ]; then
  echo "  ok: operator PROXY_TAGS=tag:k8s-operator"
else
  echo "  WARN: operator PROXY_TAGS='$ptags' (expected tag:k8s-operator — reinstall with -f deploy/tailscale/values.yaml)"
fi

echo "== 7. external secrets syncing =="
for es in tailscale/operator-oauth agents/github-token; do
  state=$(kubectl get externalsecret "${es#*/}" -n "${es%%/*}" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
  if [ "$state" = "True" ]; then
    echo "  ok: externalsecret/$es Ready"
  else
    echo "  FAIL: externalsecret/$es not Ready (state: ${state:-missing}) — see deploy/eso/README.md"
    fail=1
  fi
done

echo "== 8. node IP =="
# NetworkPolicies allow the API by the node IP from clusters/home/node; a
# server that came back on another address breaks them silently.
rendered=$(kubectl kustomize deploy/policies/base 2>/dev/null |
  awk '/name: headlamp-kube-api/ { f = 1 } f && /cidr:/ { n++; if (n == 2) { sub(/.*cidr: */, ""); sub(/\/.*/, ""); print; exit } }')
live=$(kubectl get endpointslices -n default -l kubernetes.io/service-name=kubernetes \
  -o jsonpath='{.items[*].endpoints[*].addresses[*]}' 2>/dev/null)
case " $live " in
  *" $rendered "*)
    if [ -n "$rendered" ]; then
      echo "  ok: API endpoint $rendered matches clusters/home/node"
    else
      echo "  FAIL: no node IP rendered from deploy/policies/base"
      fail=1
    fi
    ;;
  *)
    echo "  FAIL: API endpoint '${live}' != rendered node IP '${rendered}' (update clusters/home/node/node.yaml)"
    fail=1
    ;;
esac

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASS ✅"
else
  echo "CHECKS FAILED ❌"
  exit 1
fi
