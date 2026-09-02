#!/bin/sh
# Least-privilege conformance for the Tailscale serve-fixers (issue #32).
#
# Static checks (always run): every fixer image must be digest-pinned, no
# fixer Role may grant pods/log, both Deployments must run non-root with a
# read-only root filesystem, and the agents-namespace reads must be
# name-pinned.
#
# Live RBAC checks (run when kubectl reaches the cluster; needs a kubeconfig
# whose user may impersonate service accounts — the bootstrap admin
# kubeconfig does): the fixer identities may touch only their own targets
# (t3code-0 pod / panel Endpoints, pods/exec create) and nothing else —
# not other workloads' pods, not pods/log, not secrets, not any write on
# pods or the operator Deployment. Exec into unrelated operator/proxy pods
# is the documented residual (deploy/tailscale/README.md): RBAC cannot
# scope pods/exec by pod name, so it is reported as INFO, not asserted.
#
# Exit 0 = conforming, 1 = a check failed.
set -u

cd "$(dirname "$0")/.." || exit 1

fail=0
note() { echo "  $1"; }
bad() { echo "  FAIL: $1"; fail=1; }

echo '==> static: fixer images digest-pinned'
for f in deploy/tailscale/serve-fixer.yaml deploy/tailscale/panel-serve-fixer.yaml; do
  if grep -E '^[[:space:]]*image:' "$f" | grep -v '@sha256:' >/dev/null 2>&1; then
    bad "unpinned image ref in $f"
  else
    note "ok: digest-pinned image in $f"
  fi
done

echo '==> static: no pods/log grant anywhere in deploy/tailscale'
if grep -E 'resources:.*pods/log' deploy/tailscale/*.yaml >/dev/null 2>&1; then
  bad 'pods/log still granted'
else
  note 'ok: no pods/log grant'
fi

echo '==> static: non-root, read-only rootfs, no privilege escalation'
for f in deploy/tailscale/serve-fixer.yaml deploy/tailscale/panel-serve-fixer.yaml; do
  for want in 'runAsNonRoot: true' 'readOnlyRootFilesystem: true' 'allowPrivilegeEscalation: false' 'drop: \["ALL"\]'; do
    if grep -qE "$want" "$f"; then
      note "ok: $f has $want"
    else
      bad "$f missing $want"
    fi
  done
done

echo '==> static: agents-namespace reads name-pinned'
if grep -q 'resourceNames: \["t3code-0"\]' deploy/tailscale/serve-fixer.yaml; then
  note 'ok: serve-fixer agents read pinned to pod t3code-0'
else
  bad 'serve-fixer.yaml: agents pods read not pinned to t3code-0'
fi
if grep -q 'resourceNames: \["panel"\]' deploy/tailscale/panel-serve-fixer.yaml; then
  note 'ok: panel-serve-fixer agents read pinned to endpoints panel'
else
  bad 'panel-serve-fixer.yaml: agents read not pinned to panel endpoints'
fi

if ! command -v kubectl >/dev/null 2>&1; then
  note 'kubectl unavailable — live RBAC checks skipped'
  if [ "$fail" -eq 0 ]; then echo 'CHECKS PASS (static)'; else echo 'CHECKS FAILED'; fi
  exit "$fail"
fi
if ! kubectl get nodes >/dev/null 2>&1; then
  note 'cluster unreachable — live RBAC checks skipped (KUBECONFIG=... to enable)'
  if [ "$fail" -eq 0 ]; then echo 'CHECKS PASS (static)'; else echo 'CHECKS FAILED'; fi
  exit "$fail"
fi

# Live checks: assert access as each fixer identity via impersonation.
T3="--as=system:serviceaccount:tailscale:serve-fixer"
PAN="--as=system:serviceaccount:tailscale:panel-serve-fixer"

can() {
  # can <as-flags> <verb> <resource[/name]> <namespace> -> 0 when allowed
  kubectl auth can-i "$2" "$3" -n "$4" "$1" 2>/dev/null | grep -q '^yes$'
}

expect() {
  # expect <want-yes|no> <as-flags> <verb> <resource[/name]> <namespace> <ok-msg> <fail-msg>
  want="$1"; as="$2"; verb="$3"; res="$4"; ns="$5"; okmsg="$6"; failmsg="$7"
  if can "$as" "$verb" "$res" "$ns"; then
    if [ "$want" = yes ]; then note "ok: $okmsg"; else bad "$failmsg"; fi
  else
    if [ "$want" = yes ]; then bad "$failmsg"; else note "ok: $okmsg"; fi
  fi
}

echo '==> live: fixer identities may touch only their own target'
expect yes "$T3" get pod/t3code-0 agents 'serve-fixer can read pod t3code-0' 'serve-fixer cannot read pod/t3code-0'
expect yes "$T3" create pods/exec tailscale 'serve-fixer can create pods/exec (documented residual)' 'serve-fixer cannot create pods/exec'
expect yes "$PAN" get endpoints/panel agents 'panel-serve-fixer can read endpoints panel' 'panel-serve-fixer cannot read endpoints/panel'
expect yes "$PAN" create pods/exec tailscale 'panel-serve-fixer can create pods/exec (documented residual)' 'panel-serve-fixer cannot create pods/exec'

echo '==> live: fixer identities denied everywhere else'
expect no "$T3" get pod/hermes-0 agents 'serve-fixer denied pod/hermes-0' 'serve-fixer can read pod hermes-0'
expect no "$T3" list pods agents 'serve-fixer cannot list pods in agents' 'serve-fixer can list pods in agents'
expect no "$T3" get pods/log tailscale 'serve-fixer cannot read pods/log' 'serve-fixer can read pods/log'
expect no "$T3" create pods tailscale 'serve-fixer cannot create pods' 'serve-fixer can create pods'
expect no "$T3" delete pods tailscale 'serve-fixer cannot delete pods' 'serve-fixer can delete pods'
expect no "$T3" list secrets tailscale 'serve-fixer cannot list secrets' 'serve-fixer can list secrets (proxy authkeys!)'
expect no "$T3" patch deployments tailscale 'serve-fixer cannot patch deployments' 'serve-fixer can patch deployments (operator)'
expect no "$PAN" get pod/t3code-0 agents 'panel-serve-fixer cannot read pod/t3code-0' 'panel-serve-fixer can read pod t3code-0'
expect no "$PAN" get endpoints/t3code-0 agents 'panel-serve-fixer cannot read endpoints/t3code-0' 'panel-serve-fixer can read endpoints t3code-0'
expect no "$PAN" list pods agents 'panel-serve-fixer cannot list pods in agents' 'panel-serve-fixer can list pods in agents'
expect no "$PAN" list secrets tailscale 'panel-serve-fixer cannot list secrets' 'panel-serve-fixer can list secrets (proxy authkeys)'

note 'INFO: pods/exec create is namespace-scoped by necessity (operator-generated pod names, RBAC cannot pin names) — a compromised fixer image could exec into unrelated operator/proxy pods; documented in deploy/tailscale/README.md'

if [ "$fail" -eq 0 ]; then
  echo 'CHECKS PASS'
else
  echo 'CHECKS FAILED'
fi
exit "$fail"
