#!/bin/sh
# Offline behavior tests for the factory Linear input adapter (#87).
# Shimmed curl (Linear GraphQL) + gh (GitHub ledger): no network, no cluster.
# Covers the acceptance matrix: eligibility (status/label/project), identity
# mapping, idempotent repolls/edits/cancellation, rate-limit retry, transient
# fail-closed, pagination, cursor persistence, untrusted-text safety, and
# duplicate-free run/PR write-back.
set -eu
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../../.."

FIX="$(mktemp -d)"
SHIM="$FIX/bin"
mkdir -p "$SHIM"
trap 'rm -rf "$FIX"' EXIT

# ---------------------------------------------------------------- shims -----
cat > "$SHIM/curl" <<'EOF'
#!/bin/sh
# Linear GraphQL shim: routes by query text, simulates 429/5xx transients,
# paginates a fixture node list, and persists commentCreate mutations so
# dedupe can be observed across runs.
set -eu
LINSHIM_DIR="${LINSHIM_DIR:?}"
out=""
body=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --data-binary) body=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || { echo "curl shim: no -o" >&2; exit 9; }

transient() {  # <remaining-file> <http-code>
  if [ -f "$1" ]; then
    n=$(cat "$1")
    if [ "$n" -gt 0 ]; then
      printf '%s' $((n - 1)) > "$1"
      printf '{"errors":[{"message":"slow down","extensions":{"code":"RATELIMITED"}}]}' > "$out"
      printf '%s' "$2"
      return 0
    fi
  fi
  return 1
}

if transient "$LINSHIM_DIR/500-remaining" 500; then exit 0; fi
if transient "$LINSHIM_DIR/429-remaining" 429; then exit 0; fi

query=$(printf '%s' "$body" | jq -r '.query')

case "$query" in
  *"issues(first"*)
    gte=$(printf '%s' "$body" | jq -r '.variables.filter.updatedAt.gte // ""')
    project=$(printf '%s' "$body" | jq -r '.variables.filter.project.name.eq // ""')
    after=$(printf '%s' "$body" | jq -r '.variables.after // ""')
    first=$(printf '%s' "$body" | jq -r '.variables.first // 50')
    case "$after" in
      offset:*) off=${after#offset:} ;;
      *) off=0 ;;
    esac
    jq -c --argjson o "$off" --argjson f "$first" --arg g "$gte" --arg p "$project" '
      [ .[]
        | select(.updatedAt >= $g)
        | select($p == "" or .project.name == $p) ] as $all
      | { data: { issues: {
            nodes: ($all[$o:$o + $f]),
            pageInfo: {
              hasNextPage: (($o + $f) < ($all | length)),
              endCursor: ("offset:" + (($o + $f) | tostring)) } } } }' \
      "$LINSHIM_DIR/linear-issues.json" > "$out" \
      || { echo "curl shim: issues paging failed" >&2; exit 9; }
    printf 'issues after=%s gte=%s first=%s\n' "$after" "$gte" "$first" \
      >> "$LINSHIM_DIR/linear-calls.log"
    printf '200'
    ;;
  *"issue(id"*)
    id=$(printf '%s' "$body" | jq -r '.variables.id')
    uuid=$(jq -r --arg id "$id" '.[$id] // ""' "$LINSHIM_DIR/issue-ids.json")
    jq -cn --arg uuid "$uuid" --slurpfile cs "$LINSHIM_DIR/linear-comments.json" \
      '{data:{issue:{id:$uuid, comments:{nodes:$cs[0]}}}}' > "$out"
    printf 'issue %s\n' "$id" >> "$LINSHIM_DIR/linear-calls.log"
    printf '200'
    ;;
  *"commentCreate"*)
    issueid=$(printf '%s' "$body" | jq -r '.variables.input.issueId')
    newbody=$(printf '%s' "$body" | jq -r '.variables.input.body')
    jq --arg b "$newbody" '. + [{body: $b}]' "$LINSHIM_DIR/linear-comments.json" \
      > "$LINSHIM_DIR/linear-comments.json.tmp"
    mv "$LINSHIM_DIR/linear-comments.json.tmp" "$LINSHIM_DIR/linear-comments.json"
    printf 'commentCreate %s\n' "$issueid" >> "$LINSHIM_DIR/linear-writes.log"
    printf '{"data":{"commentCreate":{"success":true}}}' > "$out"
    printf '200'
    ;;
  *)
    echo "curl shim: unrouted query: $query" >&2
    exit 9
    ;;
esac
EOF

cat > "$SHIM/gh" <<'EOF'
#!/bin/sh
# GitHub ledger shim: serves the mirrored-issue fixture, records every write.
set -eu
GHSHIM_DIR="${GHSHIM_DIR:?}"
args=$*
log() { printf '=== %s ===\n' "$args" >> "$GHSHIM_DIR/gh-writes.log"; }
case "$args" in
  *"auth status"*) exit 0 ;;
  *"issue list"*) cat "$GHSHIM_DIR/ledger.json" ;;
  *"label create"*) log ;;
  *"issue create"*)
    log
    printf 'https://github.com/gwkline/homelab/issues/9\n'
    ;;
  *"issue close"*) log ;;
  *"issue edit"*) log ;;
  *"issues/"*"comments"*)
    num=$(printf '%s' "$args" | sed -n 's|.*/issues/\([0-9]*\)/comments.*|\1|p')
    cat "$GHSHIM_DIR/gh-comments-$num.json" 2>/dev/null || printf '[]'
    ;;
  *) printf '{}\n' ;;
esac
EOF
chmod +x "$SHIM/curl" "$SHIM/gh"

# --------------------------------------------------------------- fixtures ---
FIXT="$FIX/fx"
mkdir -p "$FIXT"
export LINSHIM_DIR="$FIXT"
export GHSHIM_DIR="$FIXT"
: > "$FIXT/gh-writes.log"
: > "$FIXT/linear-writes.log"
: > "$FIXT/linear-calls.log"
printf '[]\n' > "$FIXT/linear-issues.json"
printf '[]\n' > "$FIXT/linear-comments.json"
printf '{}\n' > "$FIXT/issue-ids.json"
printf '[]\n' > "$FIXT/ledger.json"

export PATH="$SHIM:$PATH"
export GH_BIN="$SHIM/gh"
export GH_AUTH_SKIP=1
export GH_TOKEN=test
export LINEAR_TOKEN_FILE="$FIX/token"
printf 'lin-secret\n' > "$FIX/token"
export LINEAR_REPO_MAP='ENG=gwkline/homelab'
export LINEAR_ELIGIBLE_STATUSES='Todo,In Progress'
export LINEAR_CANCELLED_STATUSES='Done,Canceled'
export LINEAR_CURSOR_FILE="$FIX/cursor"
export LINEAR_RETRY_SLEEP=0
export LINEAR_WRITE_SLEEP=0
export LINEAR_MAX_ATTEMPTS=3

SCRIPT=apps/factory/collector/run-linear-collector.sh
run() { sh "$SCRIPT" > "$FIXT/out.log" 2>&1; }
count_gh() { grep -c "$1" "$GHSHIM_DIR/gh-writes.log" 2>/dev/null || true; }
count_lin() { grep -c "$1" "$LINSHIM_DIR/linear-writes.log" 2>/dev/null || true; }
fails() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# Fixture timestamps relative to now so the 24h lookback window always covers
# them. Order matters: the cursor advances through these as scenarios run.
T1=$(date -u -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ)
T2=$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%SZ)
T3=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
T4=$(date -u -d '90 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
T5=$(date -u -d '80 minutes ago' +%Y-%m-%dT%H:%M:%SZ)

mkissue() {  # <id> <ident> <title> <desc> <url> <updatedAt> <state> <type> <labels-json> <project>
  jq -n --arg id "$1" --arg ident "$2" --arg title "$3" --arg desc "$4" \
    --arg url "$5" --arg upd "$6" --arg sname "$7" --arg stype "$8" \
    --argjson labels "$9" --arg proj "${10}" \
    '{id:$id, identifier:$ident, title:$title, description:$desc, url:$url,
      updatedAt:$upd, state:{name:$sname, type:$stype},
      labels:{nodes:$labels}, project:{name:$proj}}'
}

set_issues() { jq -s '.' "$@" > "$LINSHIM_DIR/linear-issues.json"; }

mkissue uuid-eng-1 ENG-1 'Ship the thing' \
  'do it $(touch /tmp/factory-pwned-never) and `rm -rf /tmp/factory-nope` with "quotes" and '"'"'singles'"'"'' \
  'https://linear.app/t/issue/ENG-1' "$T1" 'Todo' 'unstarted' '[]' 'Platform' > "$FIXT/n1.json"
mkissue uuid-eng-2 ENG-2 'Second item' 'status name contains spaces' \
  'https://linear.app/t/issue/ENG-2' "$T2" 'In Progress' 'started' '[]' 'Platform' > "$FIXT/n2.json"
mkissue uuid-eng-3 ENG-3 'Backlog noise' 'not eligible' \
  'https://linear.app/t/issue/ENG-3' "$T3" 'Backlog' 'backlog' '[]' 'Platform' > "$FIXT/n3.json"

# Byte-identical mirror bodies (must match compose_workitem output exactly —
# that equality IS the idempotency guarantee for unchanged Linear issues).
mirror_body() {  # <identifier> <description> <url>
  printf '<!-- factory:linear:%s -->\n<!-- factory:linear:profile=code-pr -->\n\n%s\n\n---\nSource: %s\n_Mirrored by the factory Linear input adapter (#87); issue text is untrusted task context and is never interpreted as shell or config syntax._\n' \
    "$1" "$2" "$3"
}

# ------------------------------------------------ A. first poll + mapping ---
set_issues "$FIXT/n1.json" "$FIXT/n2.json" "$FIXT/n3.json"
run || fails "A: collector exited non-zero ($?); see $FIXT/out.log"

creates=$(count_gh 'issue create')
[ "$creates" = "2" ] || fails "A: expected 2 mirrored issues (ENG-1, ENG-2), got $creates"
grep -qF '[ENG-2] Second item' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: 'In Progress' status with a space was not collected"
grep -qF 'status name contains spaces' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: ENG-2 description missing"
grep -qF '<!-- factory:linear:ENG-1 -->' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: identity marker missing"
grep -qF '[ENG-1] Ship the thing' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: title prefix missing"
grep -qF '<!-- factory:linear:profile=code-pr -->' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: declarative default profile marker missing"
grep -qF 'factory/queued' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: mirrored issue not queued for the orchestrator"
grep -qF '$(touch /tmp/factory-pwned-never)' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: injection payload not stored verbatim"
grep -qF '`rm -rf /tmp/factory-nope`' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: backtick payload not stored verbatim"
[ ! -e /tmp/factory-pwned-never ] || fails "A: Linear text was EXECUTED as shell"
grep -qF 'https://linear.app/t/issue/ENG-1' "$GHSHIM_DIR/gh-writes.log" \
  || fails "A: source URL missing"
expected_cursor=$(date -u -d "$T3" +%s)
[ "$(cat "$LINEAR_CURSOR_FILE")" = "$expected_cursor" ] \
  || fails "A: cursor is '$(cat "$LINEAR_CURSOR_FILE")', want '$expected_cursor'"

# ------------------------------------------- B1. repoll honors the cursor ---
before=$(count_gh 'issue create')
run || fails "B1: repoll with cursor failed"
[ "$(count_gh 'issue create')" = "$before" ] || fails "B1: cursor ignored — issues re-created"

# --------------------------------- B2. repoll without cursor (ledger dedupe) ---
jq -n \
  --arg b1 "$(mirror_body ENG-1 \
    'do it $(touch /tmp/factory-pwned-never) and `rm -rf /tmp/factory-nope` with "quotes" and '"'"'singles'"'"'' \
    'https://linear.app/t/issue/ENG-1')" \
  --arg b2 "$(mirror_body ENG-2 'status name contains spaces' 'https://linear.app/t/issue/ENG-2')" \
  '[
    {number:101, title:"[ENG-1] Ship the thing", body:$b1, state:"OPEN",
     url:"https://github.com/gwkline/homelab/issues/101"},
    {number:102, title:"[ENG-2] Second item", body:$b2, state:"OPEN",
     url:"https://github.com/gwkline/homelab/issues/102"}
  ]' > "$FIXT/ledger.json"
before_creates=$(count_gh 'issue create')
before_edits=$(count_gh 'issue edit')
LINEAR_CURSOR_FILE= sh "$SCRIPT" > "$FIXT/out.log" 2>&1
[ "$(count_gh 'issue create')" = "$before_creates" ] || fails "B2: repoll created duplicate mirrors"
[ "$(count_gh 'issue edit')" = "$before_edits" ] || fails "B2: repoll edited unchanged mirrors"

# ----------------------------------------------------- C. Linear edit sync ---
mkissue uuid-eng-2 ENG-2 'Second item (renamed upstream)' 'status name contains spaces' \
  'https://linear.app/t/issue/ENG-2' "$T4" 'In Progress' 'started' '[]' 'Platform' > "$FIXT/n2.json"
set_issues "$FIXT/n1.json" "$FIXT/n2.json" "$FIXT/n3.json"
before_creates=$(count_gh 'issue create')
before_edits=$(count_gh 'issue edit')
run || fails "C: edit repoll failed"
[ "$(count_gh 'issue create')" = "$before_creates" ] || fails "C: edit repoll created duplicates"
edits=$(( $(count_gh 'issue edit') - before_edits ))
[ "$edits" = "1" ] || fails "C: expected exactly 1 edit, got $edits"
grep -qF '[ENG-2] Second item (renamed upstream)' "$GHSHIM_DIR/gh-writes.log" \
  || fails "C: edited title not applied"
if grep -q 'issue edit 101' "$GHSHIM_DIR/gh-writes.log"; then
  fails "C: unchanged ENG-1 was edited"
fi

# --------------------------------------------------- D. upstream cancellation ---
mkissue uuid-eng-2 ENG-2 'Second item (renamed upstream)' 'status name contains spaces' \
  'https://linear.app/t/issue/ENG-2' "$T5" 'Done' 'completed' '[]' 'Platform' > "$FIXT/n2.json"
set_issues "$FIXT/n1.json" "$FIXT/n2.json" "$FIXT/n3.json"
before_closes=$(count_gh 'issue close')
run || fails "D: cancellation repoll failed"
closes=$(( $(count_gh 'issue close') - before_closes ))
[ "$closes" = "1" ] || fails "D: expected exactly 1 close, got $closes"
grep -q 'issue close 102' "$GHSHIM_DIR/gh-writes.log" || fails "D: wrong issue closed"
grep -q 'issue edit 102.*remove-label' "$GHSHIM_DIR/gh-writes.log" \
  || fails "D: queued label not dropped before close"
# Idempotent: mirror already closed → no second close.
jq 'map(if .number == 102 then .state = "CLOSED" else . end)' \
  "$FIXT/ledger.json" > "$FIXT/ledger.tmp"
mv "$FIXT/ledger.tmp" "$FIXT/ledger.json"
before_closes=$(count_gh 'issue close')
run || fails "D2: post-cancel repoll failed"
[ "$(count_gh 'issue close')" = "$before_closes" ] || fails "D2: already-canceled mirror closed again"

# ------------------------------------------------------- E. rate-limit retry ---
printf '1\n' > "$LINSHIM_DIR/429-remaining"
calls_before=$(grep -c 'issues after=' "$LINSHIM_DIR/linear-calls.log" || true)
run || fails "E: rate-limited tick did not recover"
calls_after=$(grep -c 'issues after=' "$LINSHIM_DIR/linear-calls.log" || true)
[ "$calls_after" -gt "$((calls_before + 1))" ] || fails "E: no retry after HTTP 429"
grep -q 'backing off' "$FIXT/out.log" || fails "E: backoff not logged"

# ------------------------------------------------- F. hard outage fails closed ---
mkissue uuid-eng-31 ENG-31 'Pending during outage' 'must not be created' \
  'https://linear.app/t/issue/ENG-31' "$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  'Todo' 'unstarted' '[]' 'Platform' > "$FIXT/n31.json"
set_issues "$FIXT/n1.json" "$FIXT/n2.json" "$FIXT/n3.json" "$FIXT/n31.json"
printf '99\n' > "$LINSHIM_DIR/500-remaining"
before_writes=$(wc -l < "$GHSHIM_DIR/gh-writes.log")
if run; then fails "F: hard Linear outage exited 0"; fi
[ "$(wc -l < "$GHSHIM_DIR/gh-writes.log")" = "$before_writes" ] \
  || fails "F: GitHub ledger mutated despite Linear outage"
grep -q 'failed after 3 attempts' "$FIXT/out.log" || fails "F: retry budget not exhausted"
rm -f "$LINSHIM_DIR/500-remaining"

# ------------------------------------------------------------ G. pagination ---
G1=$(date -u -d '50 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
G2=$(date -u -d '40 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
G3=$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
mkissue uuid-g1 ENG-11 'Page one' 'p1' 'u1' "$G1" 'Todo' 'unstarted' '[]' 'Platform' > "$FIXT/g1.json"
mkissue uuid-g2 ENG-12 'Page two' 'p2' 'u2' "$G2" 'Todo' 'unstarted' '[]' 'Platform' > "$FIXT/g2.json"
mkissue uuid-g3 ENG-13 'Page three' 'p3' 'u3' "$G3" 'Todo' 'unstarted' '[]' 'Platform' > "$FIXT/g3.json"
set_issues "$FIXT/g1.json" "$FIXT/g2.json" "$FIXT/g3.json"
printf '[]\n' > "$FIXT/ledger.json"   # empty ledger: all three must be created
before_creates=$(count_gh 'issue create')
LINEAR_PAGE_SIZE=2 sh "$SCRIPT" > "$FIXT/out.log" 2>&1
[ "$(count_gh 'issue create')" = "$((before_creates + 3))" ] || fails "G: pagination lost issues"
grep -q 'after=offset:2' "$LINSHIM_DIR/linear-calls.log" || fails "G: endCursor not followed"

# --------------------------------------------- H. project + label eligibility ---
J1=$(date -u -d '25 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
J2=$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
J3=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
mkissue uuid-j1 ENG-21 'Labeled' 'has required label' 'u4' "$J1" 'Todo' 'unstarted' \
  '[{"name":"factory-input"}]' 'Platform' > "$FIXT/j1.json"
mkissue uuid-j2 ENG-22 'Unlabeled' 'missing required label' 'u5' "$J2" 'Todo' 'unstarted' \
  '[]' 'Platform' > "$FIXT/j2.json"
mkissue uuid-j3 ENG-23 'Other project' 'wrong project' 'u6' "$J3" 'Todo' 'unstarted' \
  '[{"name":"factory-input"}]' 'Other' > "$FIXT/j3.json"
set_issues "$FIXT/j1.json" "$FIXT/j2.json" "$FIXT/j3.json"
printf '[]\n' > "$FIXT/ledger.json"
before_creates=$(count_gh 'issue create')
LINEAR_PROJECT=Platform LINEAR_REQUIRED_LABELS='factory-input' sh "$SCRIPT" \
  > "$FIXT/out.log" 2>&1
[ "$(count_gh 'issue create')" = "$((before_creates + 1))" ] \
  || fails "H: label/project filter not applied"
grep -qF 'ENG-21' "$GHSHIM_DIR/gh-writes.log" || fails "H: eligible issue skipped"
if grep -qF 'ENG-22' "$GHSHIM_DIR/gh-writes.log"; then fails "H: unlabeled issue queued"; fi
if grep -qF 'ENG-23' "$GHSHIM_DIR/gh-writes.log"; then fails "H: other-project issue queued"; fi

# ------------------------------------- restore ledger state for write-back ---
set_issues "$FIXT/n1.json" "$FIXT/n2.json" "$FIXT/n3.json"
jq -n \
  --arg b1 "$(mirror_body ENG-1 \
    'do it $(touch /tmp/factory-pwned-never) and `rm -rf /tmp/factory-nope` with "quotes" and '"'"'singles'"'"'' \
    'https://linear.app/t/issue/ENG-1')" \
  --arg b2 "$(mirror_body ENG-2 'status name contains spaces' 'https://linear.app/t/issue/ENG-2')" \
  '[
    {number:101, title:"[ENG-1] Ship the thing", body:$b1, state:"OPEN",
     url:"https://github.com/gwkline/homelab/issues/101"},
    {number:102, title:"[ENG-2] Second item", body:$b2, state:"CLOSED",
     url:"https://github.com/gwkline/homelab/issues/102"}
  ]' > "$FIXT/ledger.json"
printf '{"ENG-1":"uuid-eng-1","ENG-2":"uuid-eng-2"}\n' > "$FIXT/issue-ids.json"
cat > "$FIXT/gh-comments-101.json" <<'EOF'
[
  {"body":"<!-- factory:run:101:2026-09-14T03:00:00Z -->\n\n## 🏭 Factory Run\n\n| | |\n|---|---|\n| Status | published |\n| Started | 2026-09-14T03:00:00Z |\n","html_url":"https://github.com/gwkline/homelab/issues/101#issuecomment-1"},
  {"body":"🏭 Draft PR ready: https://github.com/gwkline/homelab/pull/55","html_url":"https://github.com/gwkline/homelab/issues/101#issuecomment-2"},
  {"body":"♻️ Reclaimed: run stalled — not a run marker","html_url":"https://github.com/gwkline/homelab/issues/101#issuecomment-3"}
]
EOF
printf '[]\n' > "$FIXT/gh-comments-102.json"

# ---------------------------------------------------------- I. write-back ---
run || fails "I: write-back tick failed"
[ "$(count_lin 'commentCreate')" = "2" ] \
  || fails "I: expected 2 mirrored comments (run + PR), got $(count_lin 'commentCreate')"
grep -qF 'factory:linear:sync:101:2026-09-14T03:00:00Z' "$FIXT/linear-comments.json" \
  || fails "I: run comment sync marker missing"
grep -qF 'https://github.com/gwkline/homelab/pull/55' "$FIXT/linear-comments.json" \
  || fails "I: PR link not written back to Linear"
grep -qF 'published' "$FIXT/linear-comments.json" || fails "I: run status not mirrored"
if grep -qF 'Reclaimed' "$FIXT/linear-comments.json"; then
  fails "I: non-run comment mirrored"
fi

# Idempotent write-back: second tick must not duplicate Linear comments.
before_lin=$(count_lin 'commentCreate')
run || fails "I2: write-back dedupe tick failed"
[ "$(count_lin 'commentCreate')" = "$before_lin" ] || fails "I2: duplicate Linear comments written"

# ------------------------------------------------- K. credential fail-closed ---
if LINEAR_TOKEN_FILE="$FIX/missing-token" sh "$SCRIPT" > "$FIXT/out.log" 2>&1; then
  fails "K: missing Linear token exited 0"
fi
if LINEAR_TOKEN= LINEAR_TOKEN_FILE= sh "$SCRIPT" > "$FIXT/out.log" 2>&1; then
  fails "K: no Linear credentials exited 0"
fi
if LINEAR_REPO_MAP='bad-entry' sh "$SCRIPT" > "$FIXT/out.log" 2>&1; then
  fails "K: malformed repo map exited 0"
fi

# ------------------------------------------------------------------ report ---
echo "PASS: Linear input adapter — eligibility, idempotency (repoll/edit/cancel),"
echo "      rate-limit retry, fail-closed outage, pagination, cursor persistence,"
echo "      injection safety, and duplicate-free run/PR write-back"
