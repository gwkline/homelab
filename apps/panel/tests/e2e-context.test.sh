#!/bin/sh
# scripts/panel-e2e-smoke.sh may only ever talk to the kind cluster. Runs it
# against stub kind/kubectl/docker while the caller's current context is
# "prod", and checks the context of every kubectl call it made.
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SMOKE="${ROOT}/scripts/panel-e2e-smoke.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home/.kube"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# The caller's own kubeconfig, pointing at production.
printf 'apiVersion: v1\nkind: Config\ncurrent-context: prod\n' > "$WORK/home/.kube/config"
cp "$WORK/home/.kube/config" "$WORK/original-kubeconfig"

# kubectl resolves its context like the real one (KUBECONFIG, else
# ~/.kube/config) and logs "<context> <args>". apply fails, so each run
# stops at the script's first write.
cat > "$WORK/bin/kubectl" <<'EOF'
#!/bin/sh
ctx="$(sed -n 's/^current-context: //p' "${KUBECONFIG:-$HOME/.kube/config}" 2>/dev/null)"
echo "${ctx:-none} $*" >> "$STUB_LOG"
if [ "$1 $2" = "config current-context" ]; then
  [ -z "$ctx" ] || echo "$ctx"
fi
[ "$1" != apply ]
EOF
# kind lists STUB_CLUSTERS and exports a kubeconfig whose context is
# STUB_EXPORT_CONTEXT.
cat > "$WORK/bin/kind" <<'EOF'
#!/bin/sh
echo "kind $*" >> "$STUB_LOG"
case "$1" in
  get) [ -z "$STUB_CLUSTERS" ] || echo "$STUB_CLUSTERS" ;;
  export)
    while [ $# -gt 0 ]; do
      if [ "$1" = --kubeconfig ]; then out="$2"; fi
      shift
    done
    printf 'apiVersion: v1\nkind: Config\ncurrent-context: %s\n' "$STUB_EXPORT_CONTEXT" > "${out:?}"
    ;;
esac
EOF
# The runs stop before these do anything; they only need to exist.
for tool in docker node curl; do
  printf '#!/bin/sh\n' > "$WORK/bin/$tool"
done
chmod +x "$WORK/bin/"*

# run <log> <existing clusters> <exported context> [extra env...]
run() {
  log="$1"
  clusters="$2"
  context="$3"
  shift 3
  : > "$log"
  if env -u KUBECONFIG HOME="$WORK/home" PATH="$WORK/bin:$PATH" TMPDIR="$WORK" \
    STUB_LOG="$log" STUB_CLUSTERS="$clusters" STUB_EXPORT_CONTEXT="$context" \
    "$@" sh "$SMOKE" > "$log.out" 2>&1; then
    fail "smoke run unexpectedly passed against stubs"
  fi
}

echo "==> pre-existing kind cluster, caller on prod"
run "$WORK/existing.log" panel-e2e kind-panel-e2e
if grep -v '^kind ' "$WORK/existing.log" | grep -qv '^kind-panel-e2e '; then
  grep -v '^kind ' "$WORK/existing.log" >&2
  fail "kubectl ran outside kind-panel-e2e"
fi
grep -q '^kind-panel-e2e apply ' "$WORK/existing.log" ||
  fail "the run never reached the kind cluster"
grep -q '^kind-panel-e2e delete pod ' "$WORK/existing.log" ||
  fail "cleanup did not remove the panel pod"
if grep -q '^kind delete ' "$WORK/existing.log"; then
  fail "deleted a kind cluster the run did not create"
fi
cmp -s "$WORK/original-kubeconfig" "$WORK/home/.kube/config" ||
  fail "the caller's kubeconfig changed"

echo "==> exported kubeconfig points elsewhere: refuse before any write"
run "$WORK/wrong.log" panel-e2e prod
if grep -v '^kind ' "$WORK/wrong.log" | grep -qv ' config current-context$'; then
  grep -v '^kind ' "$WORK/wrong.log" >&2
  fail "kubectl ran beyond the context check"
fi
grep -q 'refusing to run' "$WORK/wrong.log.out" ||
  fail "no refusal message"

echo "==> created cluster: deleted after the run, kept with PANEL_E2E_KEEP=1"
run "$WORK/created.log" "" kind-panel-e2e
grep -q '^kind create cluster ' "$WORK/created.log" || fail "cluster not created"
grep -q '^kind delete cluster ' "$WORK/created.log" ||
  fail "created cluster not deleted"
run "$WORK/kept.log" "" kind-panel-e2e PANEL_E2E_KEEP=1
if grep -q '^kind delete ' "$WORK/kept.log"; then
  fail "PANEL_E2E_KEEP=1 still deleted the cluster"
fi
if grep -q '^kind-panel-e2e delete ' "$WORK/kept.log"; then
  fail "PANEL_E2E_KEEP=1 still deleted fixtures"
fi

echo "PASS: panel-e2e-smoke.sh touches only kind-panel-e2e"
