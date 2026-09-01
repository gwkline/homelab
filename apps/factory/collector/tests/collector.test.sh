#!/bin/bash
# Offline behavior test for the issue collector.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../.."

FIX="$(mktemp -d)"
SHIM="$FIX/bin"
mkdir -p "$SHIM"
trap 'rm -rf "$FIX"' EXIT
cat > "$SHIM/gh" <<'EOF'
#!/bin/bash
set -eu
case "$*" in
  *"auth status"*) exit 0 ;;
  *"issues?state=open"*)
    python3 -c 'import json,sys; print(json.dumps([json.load(open(sys.argv[1]))]))' "$GH_FIXTURE_DIR/issues.json" ;;
  *"/labels"*)
    printf '%s\n' "$*" >> "$GH_FIXTURE_DIR/writes.log" ;
    printf '{"ok":true}\n' ;;
  *)
    echo '{}' ;;
esac
EOF
chmod +x "$SHIM/gh"

cat > "$FIX/issues.json" <<'EOF'
[
  {"number":1,"title":"unlabeled","labels":[]},
  {"number":2,"title":"already queued","labels":[{"name":"factory/queued"}]},
  {"number":3,"title":"already failed","labels":[{"name":"factory/failed"}]},
  {"number":4,"title":"pull request","pull_request":{},"labels":[]}
]
EOF
: > "$FIX/writes.log"

GH_AUTH_SKIP=1 GH_TOKEN=test GH_BIN="$SHIM/gh" GH_FIXTURE_DIR="$FIX" FACTORY_REPOS=gwkline/homelab \
  PATH="$SHIM:$PATH" sh apps/factory/collector/run-collector.sh

count=$(wc -l < "$FIX/writes.log" | tr -d ' ')
[ "$count" = 1 ] || { echo "FAIL: expected one label write, got $count"; exit 1; }
grep -q 'issues/1/labels' "$FIX/writes.log" || { echo "FAIL: issue #1 was not queued"; exit 1; }
! grep -Eq 'issues/(2|3|4)/labels' "$FIX/writes.log" || { echo "FAIL: ineligible issue was queued"; exit 1; }
echo "PASS: collector queues only eligible issues"
