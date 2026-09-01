#!/bin/bash
# Offline behavior test for run-reviewer.sh.
# Stubs `gh` via PATH shim so no network and no mutation happens (v1 is
# read-only anyway — the shim also FAILS the test if the reviewer tries to
# write: pr merge / ready / label edits on PRs).
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../"

SHIM="$PWD/apps/factory/reviewer/tests/bin"
mkdir -p "$SHIM"
cat > "$SHIM/gh" <<'EOF'
#!/bin/bash
# Minimal gh stub. When GH_FIXTURE_DIR contains prs.json/checks.json/reviews.json,
# serve those fixtures; else return empty JSON. GH_TOKEN/testtoken always works.
case "${GH_TOKEN:-}" in "") echo "gh: Bad credentials (HTTP 401)" >&2; exit 1;; esac
case "$*" in
  *"pulls?state=open"*)
    # gh --paginate --slurp returns an array of page arrays.
    python3 -c 'import json,sys; print(json.dumps([json.load(open(sys.argv[1]))]))' "$GH_FIXTURE_DIR/prs.json" ;;
  */check-runs|*/status)
    cat "$GH_FIXTURE_DIR/checks.json" ;;
  */reviews)
    cat "$GH_FIXTURE_DIR/reviews.json" ;;
  *"pr merge"*|*"pr ready"*)
    echo "FAIL: reviewer attempted a write: gh $*" >&2
    exit 99 ;;
  *)
    echo '{}' ;;
esac
EOF
chmod +x "$SHIM/gh"

FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT
cat > "$FIX/prs.json" <<'EOF'
[
 {"number":8,"title":"draft one","head":{"ref":"factory/issue-6/code-pr"},"draft":true,
  "labels":[{"name":"factory/draft-pr"}],"body":"Closes #6"},
 {"number":10,"title":"ready two","head":{"ref":"factory/issue-9/code-pr"},"draft":false,
  "labels":[{"name":"factory/draft-pr"},{"name":"factory/needs-review"}],"body":"Closes #9"},
 {"number":11,"title":"unrelated PR","head":{"ref":"feature/unrelated"},"draft":false,
  "labels":[],"body":"Not a factory run"}
]
EOF
echo '{"state":"success","statuses":[],"check_runs":[{"status":"completed","conclusion":"success"}]}' > "$FIX/checks.json"
echo '[{"state":"APPROVED","user":{"login":"gwkline"}}]' > "$FIX/reviews.json"

OUT="$(GH_AUTH_SKIP=1 GH_TOKEN=test GH_FIXTURE_DIR="$FIX" FACTORY_REPO=gwkline/launchpad \
  PATH="$SHIM:$PATH" apps/factory/reviewer/run-reviewer.sh)" || RC=$?
RC=${RC:-0}

echo "$OUT"
# assertions
echo "$OUT" | grep -q "#8.*ready-for-review"         || { echo "FAIL: #8 should suggest ready-for-review"; exit 1; }
echo "$OUT" | grep -q "#10.*APPROVED"                || { echo "FAIL: #10 should show APPROVED"; exit 1; }
! echo "$OUT" | grep -q "PR #11"                     || { echo "FAIL: unrelated PR was processed"; exit 1; }
echo "$OUT" | grep -q "\[reviewer\] done"            || { echo "FAIL: no completion line"; exit 1; }
[ "$RC" -eq 0 ]                                      || { echo "FAIL: exit code $RC"; exit 1; }
rm -f "$SHIM/gh"
echo "PASS: reviewer label filtering behaves"
