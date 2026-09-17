#!/bin/bash
# Offline contract test for the factory stalled-PR sweeper (#242).
#
# A stateful `gh` shim (GH_STATE) makes the idempotency claim real: the
# second sweep reads back exactly what the first sweep wrote, so re-running
# must NOT re-ping, re-file, or duplicate comments. The shim also FAILS the
# test if the sweeper ever tries to close/merge/edit a PR (human merge gate).
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
FIX="$(mktemp -d)"
SHIM="${FIX}/bin"
STATE="${FIX}/state"
FIXD="${FIX}/fixture"
mkdir -p "${SHIM}" "${STATE}" "${FIXD}"
trap 'rm -rf "${FIX}"' EXIT

# Fixed "now": 2026-09-17T12:00:00Z (sweep is date-independent via SWEEP_NOW).
SWEEP_NOW="$(python3 -c 'import datetime;print(int(datetime.datetime.fromisoformat("2026-09-17T12:00:00+00:00").timestamp()))')"

cat > "${SHIM}/gh" << 'SHIMEOF'
#!/bin/bash
# Stateful gh stub for the sweeper test. GETs serve state (seeded once from
# the fixture dir); writes mutate state and append to writes.log.
set -eu
case "${GH_TOKEN:-}" in "") echo "gh: Bad credentials (HTTP 401)" >&2; exit 1;; esac
case "$*" in
  *"pr merge"*|*"pr close"*|*"pr edit"*|*"pr ready"*|*"issue edit"*|*"-X DELETE"*|*"pulls/"*"/merge"*)
    echo "FAIL: sweeper attempted a forbidden write: gh $*" >&2
    exit 99 ;;
esac
S="${GH_STATE:?GH_STATE required}"
F="${GH_FIXTURE_DIR:?GH_FIXTURE_DIR required}"

if [ ! -e "${S}/.seeded" ]; then
  cp "${F}"/*.json "${S}/" 2>/dev/null || true
  : > "${S}/writes.log"
  : > "${S}/issues-created.jsonl"
  printf '1000\n' > "${S}/next-cid"
  printf '500\n' > "${S}/next-issue"
  touch "${S}/.seeded"
fi

log() { printf '%s\n' "$*" >> "${S}/writes.log"; }

mode="GET"; url=""; jqq=""; fields=()
while [ $# -gt 0 ]; do
  case "$1" in
    -X) mode="$2"; shift 2 ;;
    -f|-F) fields+=("$2"); shift 2 ;;
    --jq) jqq="$2"; shift 2 ;;
    --slurp|--paginate) shift ;;
    -H) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done

get_field() {
  local f
  for f in ${fields[@]+"${fields[@]}"}; do
    case "$f" in
      "$1="*) printf '%s' "${f#*=}"; return 0 ;;
    esac
  done
  return 1
}

jsonl_add() { # $1=file, $2..$n = key=value pairs (values JSON-encoded by caller)
  python3 - "$@" << 'PY'
import json, sys
path = sys.argv[1]
rows = []
try:
    rows = [json.loads(l) for l in open(path) if l.strip()]
except FileNotFoundError:
    pass
rows.append(json.loads(sys.argv[2]))
with open(path, "w") as fh:
    for r in rows:
        fh.write(json.dumps(r) + "\n")
PY
}

if [ "$mode" = "POST" ]; then
  case "$url" in
    */comments)
      n="$(printf '%s' "$url" | sed -n 's|.*/issues/\([0-9]*\)/comments.*|\1|p')"
      body="$(get_field body || true)"
      cid="$(cat "${S}/next-cid")"
      printf '%s\n' $((cid + 1)) > "${S}/next-cid"
      python3 - "${S}/comments-${n}.json" "$cid" "$body" << 'PY'
import json, sys
path, cid, body = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try:
    data = json.load(open(path))
except FileNotFoundError:
    data = []
data.append({"id": cid, "body": body})
json.dump(data, open(path, "w"))
PY
      log "POST comment pr=${n} id=${cid}"
      printf '{"id": %s}\n' "$cid"
      ;;
    */requested_reviewers)
      n="$(printf '%s' "$url" | sed -n 's|.*/pulls/\([0-9]*\)/.*|\1|p')"
      rev="$(get_field 'reviewers[]' || true)"
      printf '{"users": [{"login": "%s"}]}\n' "$rev" > "${S}/rr-${n}.json"
      log "POST review-request pr=${n} reviewer=${rev}"
      printf '{"users": [{"login": "%s"}]}\n' "$rev"
      ;;
    */labels)
      log "POST label $(get_field name || true)"
      printf '{}\n'
      ;;
    */issues)
      n="$(cat "${S}/next-issue")"
      printf '%s\n' $((n + 1)) > "${S}/next-issue"
      title="$(get_field title || true)"
      body="$(get_field body || true)"
      labels=""
      for f in ${fields[@]+"${fields[@]}"}; do
        case "$f" in
          'labels[]='*) labels="${labels},${f#labels[]=}" ;;
        esac
      done
      labels="${labels#,}"
      title_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$title")"
      body_json="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$body")"
      labels_json="$(python3 -c 'import json,sys; print(json.dumps([l for l in sys.argv[1].split(",") if l]))' "$labels")"
      jsonl_add "${S}/issues-created.jsonl" \
        "{\"number\": ${n}, \"title\": ${title_json}, \"body\": ${body_json}, \"labels\": ${labels_json}}"
      log "POST issue n=${n} labels=${labels}"
      printf '{"number": %s}\n' "$n"
      ;;
    *)
      log "POST ${url} (unhandled)"
      printf '{}\n'
      ;;
  esac
  exit 0
fi

if [ "$mode" = "PATCH" ]; then
  case "$url" in
    */issues/comments/*)
      cid="$(printf '%s' "$url" | sed -n 's|.*/issues/comments/\([0-9]*\).*|\1|p')"
      body="$(get_field body || true)"
      python3 - "${S}" "$cid" "$body" << 'PY'
import json, sys, glob
state, cid, body = sys.argv[1], int(sys.argv[2]), sys.argv[3]
for path in glob.glob(state + "/comments-*.json"):
    try:
        data = json.load(open(path))
    except FileNotFoundError:
        continue
    for c in data:
        if c.get("id") == cid:
            c["body"] = body
    json.dump(data, open(path, "w"))
PY
      log "PATCH comment id=${cid}"
      printf '{"id": %s}\n' "$cid"
      ;;
    *)
      log "PATCH ${url} (unhandled)"
      printf '{}\n'
      ;;
  esac
  exit 0
fi

# GET (wrapped so --jq can be applied like the real gh does)
serve_get() {
  case "$url" in
    "repos/"*"pulls?state=open"*)
      python3 -c 'import json,sys; print(json.dumps([json.load(open(sys.argv[1]))]))' "${F}/prs.json" ;;
    "search/issues"*)
      q="$(get_field q || true)"
      marker="$(printf '%s' "$q" | grep -o 'factory:sweep:filed:[0-9]*' | head -n1 || true)"
      count=0
      if [ -n "$marker" ]; then
        count="$(grep -c -F "\"body\": \"<!-- ${marker}" "${S}/issues-created.jsonl" 2>/dev/null || true)"
      fi
      printf '{"total_count": %s}\n' "${count:-0}" ;;
    */check-runs)
      sha="$(printf '%s' "$url" | sed -n 's|.*/commits/\([^/]*\)/check-runs.*|\1|p')"
      cat "${S}/checks-${sha}.json" ;;
    */requested_reviewers)
      n="$(printf '%s' "$url" | sed -n 's|.*/pulls/\([0-9]*\)/.*|\1|p')"
      if [ -f "${S}/rr-${n}.json" ]; then cat "${S}/rr-${n}.json"; else printf '{"users": []}\n'; fi ;;
    */reviews)
      n="$(printf '%s' "$url" | sed -n 's|.*/pulls/\([0-9]*\)/reviews.*|\1|p')"
      if [ -f "${S}/reviews-${n}.json" ]; then cat "${S}/reviews-${n}.json"; else printf '[]\n'; fi ;;
    */compare/*)
      base="${url#*compare/}"; base="${base%%..*}"
      jq --arg b "$base" -c '.[$b] // {"ahead_by": 0}' "${S}/compare.json" ;;
    */comments*)
      n="$(printf '%s' "$url" | sed -n 's|.*/issues/\([0-9]*\)/comments.*|\1|p')"
      if [ -f "${S}/comments-${n}.json" ]; then cat "${S}/comments-${n}.json"; else printf '[]\n'; fi ;;
    "repos/"*"issues/"*)
      n="$(printf '%s' "$url" | sed -n 's|.*/issues/\([0-9]*\)$|\1|p')"
      if [ -f "${S}/issue-${n}.json" ]; then cat "${S}/issue-${n}.json"; else printf '{}\n'; fi ;;
    *)
      log "GET ${url} (unhandled)"
      printf '{}\n' ;;
  esac
}

out="$(serve_get)"
if [ -n "$jqq" ]; then
  printf '%s' "$out" | jq -r "$jqq" 2>/dev/null || printf '%s' "$out"
else
  printf '%s\n' "$out"
fi
SHIMEOF
chmod +x "${SHIM}/gh"

# ── Fixtures ────────────────────────────────────────────────────────────────
# PR 21: green, 28d old, awaiting human, base drifted 60 commits → ping + drift
# PR 22: ci-red 4h ago, base drifted 3 → fresh red → leave for medic, no writes
# PR 23: ci-red 3.5d ago, medic retries exhausted (4/4), base drifted 75,
#        linked issue #30 not stuck → file exactly one factory/queued fix issue
cat > "${FIXD}/prs.json" << 'EOF'
[
 {"number":21,"title":"green old","head":{"ref":"factory/issue-20/code-pr","sha":"head21"},
  "base":{"ref":"main","sha":"base21"},"draft":false,"created_at":"2026-08-20T00:00:00Z"},
 {"number":22,"title":"red fresh","head":{"ref":"factory/issue-25/code-pr","sha":"head22"},
  "base":{"ref":"main","sha":"base22"},"draft":false,"created_at":"2026-09-16T00:00:00Z"},
 {"number":23,"title":"red stale","head":{"ref":"factory/issue-30/code-pr","sha":"head23"},
  "base":{"ref":"main","sha":"base23"},"draft":false,"created_at":"2026-09-10T00:00:00Z"}
]
EOF
echo '{"total_count":1,"check_runs":[{"status":"completed","conclusion":"success"}]}' > "${FIXD}/checks-head21.json"
cat > "${FIXD}/checks-head22.json" << 'EOF'
{"total_count":1,"check_runs":[{"name":"lint","status":"completed","conclusion":"failure","completed_at":"2026-09-17T08:00:00Z"}]}
EOF
cat > "${FIXD}/checks-head23.json" << 'EOF'
{"total_count":2,"check_runs":[
 {"name":"lint","status":"completed","conclusion":"failure","completed_at":"2026-09-14T00:00:00Z"},
 {"name":"build","status":"completed","conclusion":"timed_out","completed_at":"2026-09-14T01:00:00Z"}]}
EOF
echo '[]' > "${FIXD}/reviews-21.json"
echo '[]' > "${FIXD}/reviews-22.json"
echo '[]' > "${FIXD}/reviews-23.json"
cat > "${FIXD}/comments-23.json" << 'EOF'
[{"id":1,"body":"<!-- factory:medic:retry:1 --> re-ran checks"},
 {"id":2,"body":"<!-- factory:medic:retry:2 --> re-ran checks"},
 {"id":3,"body":"<!-- factory:medic:retry:3 --> re-ran checks"},
 {"id":4,"body":"<!-- factory:medic:retry:4 --> re-ran checks, giving up"}]
EOF
echo '[]' > "${FIXD}/comments-21.json"
echo '[]' > "${FIXD}/comments-22.json"
cat > "${FIXD}/issue-30.json" << 'EOF'
{"number":30,"title":"original work","labels":[{"name":"factory/draft-pr"}]}
EOF
cat > "${FIXD}/compare.json" << 'EOF'
{"base21": {"ahead_by": 60}, "base22": {"ahead_by": 3}, "base23": {"ahead_by": 75}}
EOF

run_sweep() {
  GH_AUTH_SKIP=1 GH_TOKEN=test GH_BIN="${SHIM}/gh" \
    GH_STATE="${STATE}" GH_FIXTURE_DIR="${FIXD}" \
    FACTORY_REPOS=gwkline/launchpad FACTORY_SWEEP_DRY_RUN=false \
    SWEEP_NOW="${SWEEP_NOW}" \
    sh "${ROOT}/apps/factory/reviewer/run-sweeper.sh"
}

OUT1="$(run_sweep)"

fail() { echo "FAIL: $1" >&2; exit 1; }

# ── Run 1 assertions ────────────────────────────────────────────────────────
printf '%s\n' "$OUT1" | grep -q "leaving for medic (#239)" \
  || fail "fresh red PR #22 was not left for the medic"
printf '%s\n' "$OUT1" | grep -q "pinged .*#21" || fail "old green PR #21 was not pinged"
printf '%s\n' "$OUT1" | grep -q "filed fix issue .*#23" || fail "stale red PR #23 did not file a fix issue"
printf '%s\n' "$OUT1" | grep -q "posted drift warning .*#21" || fail "drift warning missing for PR #21"
printf '%s\n' "$OUT1" | grep -q "posted drift warning .*#23" || fail "drift warning missing for PR #23"
printf '%s\n' "$OUT1" | grep -q "fresh-red .*#22" || fail "PR #22 not recorded as fresh-red"

issues="${STATE}/issues-created.jsonl"
[ "$(wc -l < "${issues}" | tr -d ' ')" = "1" ] || fail "expected exactly 1 fix issue, got $(wc -l < "${issues}")"
grep -q '"number": 500' "${issues}" || fail "fix issue numbering unexpected"
grep -q 'factory:sweep:filed:23' "${issues}" || fail "fix issue body lacks the idempotency marker"
grep -q 'factory/queued' "${issues}" || fail "fix issue not labeled factory/queued"
grep -q 'medic retries exhausted (4/4)' "${issues}" || fail "fix issue lacks the exhaustion reason"
grep -q '#23' "${issues}" || fail "fix issue does not reference the stalled PR"
grep -q '75 commits' "${issues}" || fail "fix issue lacks base-drift info"
grep -q -- '- lint: failure' "${issues}" || fail "fix issue lacks failing-check summary"
grep -q -- '- build: timed_out' "${issues}" || fail "fix issue lacks second failing check"

# Marker comment on the PR + drift comments, nothing on the fresh red PR.
grep -q "POST comment pr=23" "${STATE}/writes.log" || fail "no marker comment on PR #23"
grep -q "POST comment pr=21" "${STATE}/writes.log" || fail "no drift comment on PR #21"
! grep -q "pr=22" "${STATE}/writes.log" || fail "PR #22 got writes despite being fresh red"
grep -c "POST review-request pr=21" "${STATE}/writes.log" | grep -qx 1 \
  || fail "expected exactly one review-request ping"

# Human merge gate: the shim exits 99 on pr close/merge, so reaching here
# means no forbidden write happened.

# ── Run 2: identical tick must be a no-op (idempotency) ─────────────────────
W1="${STATE}/writes.log"
I1="$(wc -l < "${issues}" | tr -d ' ')"
C23_1="$(grep -c "POST comment pr=23" "${W1}" || true)"
RR1="$(grep -c "POST review-request pr=21" "${W1}" || true)"

OUT2="$(run_sweep)"

printf '%s\n' "$OUT2" | grep -q "#23.*fix issue already filed" || fail "re-sweep did not see the filed marker"
printf '%s\n' "$OUT2" | grep -q "review already requested" || fail "re-sweep did not see the review request"
printf '%s\n' "$OUT2" | grep -q "updated drift warning" || fail "re-sweep should edit the drift comment in place"
[ "$(wc -l < "${issues}" | tr -d ' ')" = "${I1}" ] || fail "re-sweep filed a duplicate fix issue"
[ "$(grep -c "POST review-request pr=21" "${W1}" || true)" = "${RR1}" ] \
  || fail "re-sweep sent a duplicate review ping"
[ "$(grep -c "POST comment pr=23" "${W1}" || true)" = "${C23_1}" ] \
  || fail "re-sweep posted a duplicate comment on PR #23"
[ "$(grep -c "POST issue" "${W1}" || true)" = "1" ] || fail "re-sweep created extra issues"

echo "PASS: sweeper takes distinct correct actions and re-runs are idempotent"
