#!/bin/bash
# Offline contract test for the factory reclaimer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FIX="$(mktemp -d)"
SHIM="${FIX}/bin"
mkdir -p "${SHIM}"
trap 'rm -rf "${FIX}"' EXIT

cat > "${SHIM}/gh" <<'EOF'
#!/bin/bash
set -eu
args="$*"
case "$args" in
  *"auth status"*) exit 0 ;;
  *"issues/1/comments"*) cat "$GH_FIXTURE_DIR/comments-1.json" ;;
  *"issues/2/comments"*) cat "$GH_FIXTURE_DIR/comments-2.json" ;;
  *"issues/3/comments"*) cat "$GH_FIXTURE_DIR/comments-3.json" ;;
  *"issues/4/comments"*) cat "$GH_FIXTURE_DIR/comments-4.json" ;;
  *"issues?"*)
    python3 - "$GH_FIXTURE_DIR/issues.json" <<'PY'
import json, sys
print(json.dumps([json.load(open(sys.argv[1]))]))
PY
    ;;
  *"pr list"*)
    case "$args" in
      *"factory/issue-4/code-pr"*) printf '1\n' ;;
      *) printf '0\n' ;;
    esac
    ;;
  *"issue edit"*|*"issue comment"*)
    printf '%s\n' "$args" >> "$GH_FIXTURE_DIR/writes.log"
    printf 'https://github.com/gwkline/launchpad/issues/1#issuecomment-1\n'
    ;;
  *"repos/*/labels"*) printf '%s\n' "$args" >> "$GH_FIXTURE_DIR/writes.log" ;;
  *) printf '{}\n' ;;
esac
EOF
chmod +x "${SHIM}/gh"

cat > "${FIX}/issues.json" <<'EOF'
[
  {"number":1,"title":"old failure","labels":[{"name":"factory/failed"}]},
  {"number":2,"title":"cooling failure","labels":[{"name":"factory/failed"}]},
  {"number":3,"title":"exhausted failure","labels":[{"name":"factory/failed"}]},
  {"number":4,"title":"has open PR","labels":[{"name":"factory/failed"}]}
]
EOF
cat > "${FIX}/comments-1.json" <<'EOF'
[{"body":"<!-- factory:run:1:2026-09-03T05:00:00Z -->"}]
EOF
cat > "${FIX}/comments-2.json" <<'EOF'
[{"body":"<!-- factory:run:2:2026-09-04T12:00:00Z -->"}]
EOF
cat > "${FIX}/comments-3.json" <<'EOF'
[
  {"body":"<!-- factory:run:3:2026-09-01T00:00:00Z -->"},
  {"body":"<!-- factory:run:3:2026-09-02T00:00:00Z -->"},
  {"body":"<!-- factory:run:3:2026-09-03T00:00:00Z -->"},
  {"body":"<!-- factory:run:3:2026-09-04T00:00:00Z -->"}
]
EOF
cat > "${FIX}/comments-4.json" <<'EOF'
[]
EOF
: > "${FIX}/writes.log"

# Issue 1 is oldest and eligible for exactly one requeue. The other actions
# must not happen in the same tick.
GH_AUTH_SKIP=1 GH_TOKEN=test GH_BIN="${SHIM}/gh" GH_FIXTURE_DIR="${FIX}" \
FACTORY_REPOS=gwkline/launchpad FACTORY_RECLAIM_DRY_RUN=false \
RECLAIMER_FIX_CUTOFF=2026-09-03T17:43:00Z RECLAIMER_MAX_ATTEMPTS=4 \
RECLAIMER_COOLDOWN_H=24 PATH="${SHIM}:${PATH}" \
  sh "${ROOT}/apps/factory/orchestrator/run-reclaimer.sh"

writes=$(grep -c '^issue ' "${FIX}/writes.log" || true)
[ "$writes" = 2 ] || { echo "FAIL: expected edit + comment only, got $writes writes"; cat "${FIX}/writes.log"; exit 1; }
grep -q -- "issue edit 1" "${FIX}/writes.log" || { echo "FAIL: issue #1 was not requeued"; exit 1; }
grep -q -- "issue comment 1" "${FIX}/writes.log" || { echo "FAIL: issue #1 reclaim comment missing"; exit 1; }
! grep -Eq "issue (edit|comment) [234]" "${FIX}/writes.log" || { echo "FAIL: more than one issue acted on"; exit 1; }
echo "PASS: reclaimer acts on one eligible issue per tick"
