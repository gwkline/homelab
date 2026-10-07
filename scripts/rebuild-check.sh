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

echo "== 4. secrets present =="
# extend as more namespaces adopt workloads
if kubectl get secret github-token -n agents >/dev/null 2>&1; then
  echo "  ok: agents/github-token"
else
  echo "  WARN: agents/github-token missing (private repos disabled)"
fi

echo "== 5. tailscale exposure =="
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

echo "== 6. tailscale exposure annotations =="
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

echo "== 7. operator default tag (pinned workaround) =="
# The chart (1.102.3) hardcodes PROXY_TAGS=tag:k8; the documented workaround
# pins it to tag:k8s-operator via `kubectl set env` (deploy/tailscale/README.md).
ptags=$(kubectl get deploy operator -n tailscale \
  -o jsonpath='{.spec.template.spec.containers[*].env[?(@.name=="PROXY_TAGS")].value}' 2>/dev/null)
if [ "$ptags" = "tag:k8s-operator" ]; then
  echo "  ok: operator PROXY_TAGS=tag:k8s-operator"
else
  echo "  WARN: operator PROXY_TAGS='$ptags' (expected tag:k8s-operator — apply documented workaround)"
fi

echo "== 8. external secrets operator =="
# deploy/eso/base runs a fake-provider smoke ExternalSecret; Ready means the
# controller reconciles end to end without any real credentials (issue #38).
state=$(kubectl get externalsecret eso-smoke -n external-secrets \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
if [ "$state" = "True" ]; then
  echo "  ok: externalsecret/eso-smoke Ready (controller reconciling)"
else
  echo "  FAIL: externalsecret/eso-smoke not Ready (state: ${state:-missing}) — install/recover: deploy/eso/base/README.md"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASS ✅"
else
  echo "CHECKS FAILED ❌"
  exit 1
fi
