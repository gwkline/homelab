#!/usr/bin/env bash
# Post-bring-up conformance sweep: verifies live cluster matches git and all
# workloads are healthy. Exit 0 = clean. Run after any rebuild or drift check.
#
# Usage: KUBECONFIG=... ./scripts/rebuild-check.sh
set -u
cd "$(dirname "$0")/.." || exit 1

fail=0

echo "== 1. manifest conformance (kubectl diff) =="
for d in deploy/namespaces.yaml deploy/policies/base deploy/t3code/base \
         deploy/hermes/base deploy/loop-agent/base deploy/panel/base \
         deploy/homepage/base deploy/headlamp/base deploy/tailscale \
         deploy/factory/base; do
  if [ -f "$d" ] || [ -d "$d" ]; then
    if ! kubectl diff -f "$d" >/dev/null 2>&1 && ! kubectl diff -k "$d" >/dev/null 2>&1; then
      echo "  DRIFT: $d"
      fail=1
    else
      echo "  ok: $d"
    fi
  fi
done

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
host=$(kubectl get svc t3code-0 -n agents -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
if [ -n "$host" ]; then
  code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://${host}/")
  if [ "$code" = "200" ]; then
    echo "  ok: http://$host -> 200"
  else
    echo "  FAIL: http://$host -> $code (serve-fixer logs: kubectl logs -n tailscale deploy/t3code-serve-fixer)"
    fail=1
  fi
else
  echo "  FAIL: t3code-0 LB address pending"
  fail=1
fi

echo "== 6. tailscale service annotations =="
# Every exposed Service must declare its hostname and required tags in the
# live cluster (mirrors the static check in scripts/verify.sh). The list is
# read into a variable + here-doc (not process substitution) so the file
# stays POSIX-parseable (dash -n).
svcs=$(kubectl get svc -A \
  -o jsonpath='{range .items[?(@.spec.loadBalancerClass=="tailscale")]}{.metadata.namespace} {.metadata.name}{"\n"}{end}' 2>/dev/null)
while IFS=' ' read -r ns name; do
  [ -n "$name" ] || continue
  host=$(kubectl get svc "$name" -n "$ns" \
    -o jsonpath='{.metadata.annotations.tailscale\.com/hostname}' 2>/dev/null)
  tags=$(kubectl get svc "$name" -n "$ns" \
    -o jsonpath='{.metadata.annotations.tailscale\.com/tags}' 2>/dev/null)
  if [ -n "$host" ] && [ "$tags" = "tag:k8s-operator" ]; then
    echo "  ok: $ns/$name ($host, $tags)"
  else
    echo "  FAIL: $ns/$name missing tailscale.com/hostname or tags=tag:k8s-operator (got host='$host' tags='$tags')"
    fail=1
  fi
done <<EOF
$svcs
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

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL CHECKS PASS ✅"
else
  echo "CHECKS FAILED ❌"
  exit 1
fi
