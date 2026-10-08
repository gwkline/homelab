#!/bin/bash
# Offline test for run-reviewer.sh with a PATH-shimmed gh. Read-only mode must
# not write (merge / ready fail the test); auto-merge mode must refuse PRs that
# change merge-gate paths, or whose file list it cannot read.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../../" || exit 1

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
  *"/files?"*)
    n="$(printf '%s' "$*" | sed 's|.*/pulls/\([0-9]*\)/files.*|\1|')"
    cat "$GH_FIXTURE_DIR/files-$n.json" 2>/dev/null || { echo "gh: HTTP 502" >&2; exit 1; } ;;
  *"pr merge"*|*"pr ready"*)
    if [ -n "${GH_ALLOW_WRITES:-}" ]; then
      echo "$*" >> "$GH_FIXTURE_DIR/writes.log"
      exit 0
    fi
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
  "labels":[{"name":"factory/draft-pr"}],"body":"Not a factory run"}
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
echo "PASS: reviewer label filtering behaves"

# Auto-merge: green, ready PRs. #20 changes docs only; #21 edits the CI
# workflow; #22's file list cannot be read.
cat > "$FIX/prs.json" <<'EOF'
[
 {"number":20,"head":{"ref":"factory/issue-30/code-pr"},"draft":false,"labels":[]},
 {"number":21,"head":{"ref":"factory/issue-31/code-pr"},"draft":false,"labels":[]},
 {"number":22,"head":{"ref":"factory/issue-32/code-pr"},"draft":false,"labels":[]}
]
EOF
echo '[{"filename":"docs/notes.md"}]' > "$FIX/files-20.json"
echo '[{"filename":"docs/notes.md"},{"filename":".github/workflows/ci.yaml"}]' > "$FIX/files-21.json"
echo '[]' > "$FIX/reviews.json"
: > "$FIX/writes.log"
RC=0
OUT="$(GH_AUTH_SKIP=1 GH_TOKEN=test GH_FIXTURE_DIR="$FIX" GH_ALLOW_WRITES=1 \
  FACTORY_REPO=gwkline/homelab FACTORY_REVIEWER_AUTO_MERGE=true \
  PATH="$SHIM:$PATH" apps/factory/reviewer/run-reviewer.sh)" || RC=$?
echo "$OUT"
[ "$RC" -eq 0 ] || { echo "FAIL: auto-merge run exit code $RC"; exit 1; }
grep -qx "pr merge 20 -R gwkline/homelab --squash --delete-branch" "$FIX/writes.log" \
  || { echo "FAIL: #20 (docs only) was not merged"; cat "$FIX/writes.log"; exit 1; }
! grep -q "pr merge 21" "$FIX/writes.log" || { echo "FAIL: #21 (edits CI) was merged"; exit 1; }
! grep -q "pr merge 22" "$FIX/writes.log" || { echo "FAIL: #22 (unreadable files) was merged"; exit 1; }
echo "$OUT" | grep -qF "PR #21: changes merge-gate paths (.github/workflows/ci.yaml) — not merging" \
  || { echo "FAIL: no reason logged for #21"; exit 1; }
echo "$OUT" | grep -q "PR #22: cannot list its changed files — not merging" \
  || { echo "FAIL: no reason logged for #22"; exit 1; }
rm -f "$SHIM/gh"
echo "PASS: auto-merge skips PRs that change merge-gate paths, and fails closed"
