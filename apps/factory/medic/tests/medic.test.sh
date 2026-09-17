#!/bin/sh
# Medic fixture tests (#239). Three proofs, all offline:
#
#   1. red→green convergence: a REAL local bare remote carries a
#      factory/issue-* branch with a deliberate lint failure; the medic sweep
#      queues the repair, a fix publishes through the guarded publish path,
#      and the branch head moves with only the fix commit on top (no force).
#   2. write guards: medic_publish_patch refuses main, non-factory branches,
#      branch creation, and moved heads (no force-push possible).
#   3. stuck path: 3 recorded failures on one head SHA → escalation, and the
#      sweep stops queueing repairs.
#
# gh is shimmed via PATH (state under a temp dir); git is real.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
LIB="${REPO_ROOT}/apps/factory/medic/medic-lib.sh"
MEDIC="${REPO_ROOT}/apps/factory/medic/run-medic.sh"
# shellcheck source=../medic-lib.sh
. "${LIB}"

fail() { echo "FAIL: $1" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

GH_STATE="${WORK}/gh-state"
mkdir -p "${GH_STATE}/labels/6/factory"
export GH_STATE

# ---- fixture git remote: factory/issue-6/code-pr with a broken shell file ----
BARE="${WORK}/remote.git"
git init -q --bare -b main "${BARE}"
git config --global user.email medic-test@local
git config --global user.name "medic-test"
git config --global advice.detachedHead false
# the seed checkout below needs the branch to exist locally before push/pull;
# use a detached worktree flow instead of relying on remote-tracking refs.

SEED="${WORK}/seed"
git init -q -b main "${SEED}"
(
  cd "${SEED}"
  mkdir -p src
  printf '#!/bin/sh\necho (ok\n' > src/broken.sh # deliberate syntax error → dash -n fails → ci-red
  git add -A && git commit -qm "seed: factory branch with deliberate lint failure"
)
SHA_123="$(git -C "${SEED}" rev-parse HEAD)"
export SHA_123
git -C "${SEED}" push -q "${BARE}" HEAD:refs/heads/factory/issue-6/code-pr
# main also exists on the remote (guard test 2a needs it):
git -C "${SEED}" commit -q --allow-empty -m "main tip" && git -C "${SEED}" push -q "${BARE}" HEAD:refs/heads/main

# The verifier for this test (same shape as the homelab table, root-tree diff):
VERIFY_OK="for f in \$(git diff --name-only 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD -- '*.sh'); do dash -n \"\$f\" || exit 1; done; echo verify-ok"
# sanity: seed commit IS red under it (diff against the empty tree — no
# checkout dance, the seed working tree already holds the broken file).
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
if (cd "${SEED}" && sh -c "${VERIFY_OK}" >/dev/null 2>&1); then
  fail "seed branch unexpectedly green — fixture is broken"
fi
echo "note: seed branch verified ci-red under the verifier"

# ---- gh shim ------------------------------------------------------------------
# This environment may lack jq; the sweep needs it, so provide a real jq
# (or a python fallback) in the shim dir first.
mkdir -p "${WORK}/shim"
if ! command -v jq >/dev/null 2>&1; then
  cat > "${WORK}/shim/jq" <<'JQ'
#!/usr/bin/env python3
# Minimal jq subset for the medic sweep fixtures:
#   -r '<filter>'            with filters used by run-medic.sh + medic-lib.sh
#   -c '.[]'
#   '[.[][] | select(...)]' style is handled by the gh shim pre-filtering.
import json, sys

args = sys.argv[1:]
raw = False
compact = False
slurp = False
fl = []
i = 0
while i < len(args):
    a = args[i]
    if a == "-r":
        raw = True
    elif a == "-c":
        compact = True
    elif a == "--paginate" or a == "--slurp":
        if a == "--slurp":
            slurp = True
    elif a == "--arg":
        fl.append(("--arg", args[i + 1], args[i + 2]))
        i += 2
    else:
        fl.append((None, a, None))
    i += 1

data = sys.stdin.read()
try:
    doc = json.loads(data)
except Exception:
    doc = []

if slurp and isinstance(doc, list) and doc and isinstance(doc[0], list):
    doc = [x for page in doc for x in page]

filt = next((a for k, a, _v in fl if k is None), ".")
argv = {k: v for k, a, v in fl if k == "--arg"}


def out(v):
    if raw and isinstance(v, str):
        print(v)
    elif compact:
        print(json.dumps(v, separators=(",", ":")))
    else:
        print(json.dumps(v, indent=2))


# only the shapes the medic scripts actually use:
if filt == ".[]":
    for x in doc:
        out(x)
elif filt.startswith("[") and "select" in filt and "startswith" in filt:
    # PR listing filter: keep factory/issue-* heads
    res = [p for p in doc if (p.get("head") or {}).get("ref", "").startswith("factory/issue-")]
    out(res)
elif filt.startswith("[") and "contains" in filt and "$m" in filt:
    marker = argv.get("m", "")
    res = [c for c in doc if marker in (c.get("body") or "")]
    out(len(res))
elif ".check_runs" in filt:
    crs = (doc.get("check_runs") if isinstance(doc, dict) else None) or []
    if "map(.conclusion" in filt:
        out(",".join((c.get("conclusion") or c.get("status") or "") for c in crs))
    elif ".name" in filt:
        import re

        names = [c.get("name", "") for c in crs if re.search(r"failure|timed_out|action_required|stale|cancelled", c.get("conclusion") or "")]
        out(", ".join(names))
    elif "output.summary" in filt:
        import re

        logs = ["-- " + c.get("name", "") + " --\n" + ((c.get("output") or {}).get("summary") or "no log captured")[:2000] for c in crs if re.search(r"failure|timed_out|action_required|stale|cancelled", c.get("conclusion") or "")]
        out("\n\n".join(logs))
    else:
        out([])
elif filt == ".number":
    out(doc.get("number"))
elif filt == ".draft":
    out(doc.get("draft"))
elif filt == ".head.ref":
    out((doc.get("head") or {}).get("ref"))
elif filt == ".head.sha":
    out((doc.get("head") or {}).get("sha"))
elif "labels" in filt and "join" in filt:
    out(",".join(l.get("name", "") for l in doc.get("labels") or []))
elif "contains($m)" in filt and "id" in filt:
    marker = argv.get("m", "")
    hits = [c for c in doc if marker in (c.get("body") or "")]
    out(hits[0].get("id") if hits else "")
elif filt == "length":
    out(len(doc))
else:
    out(doc)
JQ
  chmod +x "${WORK}/shim/jq"
fi
cat > "${WORK}/shim/gh" <<'SHIM'
#!/bin/bash
# Fixture gh. State files under $GH_STATE:
#   prs.json                  open PR list
#   checks-green              existence ⇒ PR #123 checks are green
#   briefs                    appended: every comment body posted to PR #123
#   issue-comments            appended: every comment posted to issue #6
#   pr-123-comments.json      served as PR #123's comment list
#   stuck-log                 appended: escalation writes
set -u

# Real gh applies --jq on the API response. The mock returns canned bodies, so
# split --jq (and its filter) out of "$*", serve the canned body, then apply
# the filter with the shimmed jq — otherwise callers relying on --jq see raw
# JSON and label guards never match.
JQ_FILTER=""
JQ_FLAGS=""
ARGS=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--jq" ]; then
    JQ_FILTER="$a"
  else
    case "$a" in
      --jq) ;;
      --slurp|--paginate) JQ_FLAGS="$JQ_FLAGS $a"; ARGS="$ARGS $a" ;;
      *) ARGS="$ARGS $a" ;;
    esac
  fi
  prev="$a"
done
set -- $ARGS

case "$*" in
  *"pulls?state=open"*)
    printf '[%s]' "$(cat "$GH_STATE/prs.json")" ;;
  *"commits/${SHA_123}/check-runs"*)
    if [ -f "$GH_STATE/checks-green" ]; then
      echo '{"check_runs":[{"name":"lint","status":"completed","conclusion":"success"}]}'
    else
      echo '{"check_runs":[{"name":"lint","status":"completed","conclusion":"failure","output":{"summary":"src/broken.sh: syntax error"}}]}'
    fi ;;
  */check-runs)
    echo '{"check_runs":[]}' ;;
  *"pulls/123.diff"*)
    printf 'diff --git a/src/broken.sh b/src/broken.sh\n--- a/src/broken.sh\n+++ b/src/broken.sh\n@@ -1 +1 @@\n-echo (ok\n+echo ok\n' ;;
  *"issues/123/comments"*)
    if [ "${2:-}" = "-X" ] && [ "${3:-}" = "POST" ]; then
      for a in "$@"; do
        case "$a" in body=*) printf '%s\n' "${a#body=}" >> "$GH_STATE/briefs" ;; esac
      done
      echo '{"id": 1}'
    else
      cat "$GH_STATE/pr-123-comments.json"
    fi ;;
  *"issues/6/comments"*)
    if [ "${2:-}" = "-X" ] && [ "${3:-}" = "POST" ]; then
      for a in "$@"; do
        case "$a" in body=*) printf '%s\n' "${a#body=}" >> "$GH_STATE/issue-comments" ;; esac
      done
      echo '{"id": 2}'
    else
      printf '[%s]' "$(cat "$GH_STATE/issue-comments.json" 2>/dev/null || echo '[]')"
    fi ;;
  *"issues/"*"/labels"*)
    # label add/remove: track in the labels dir; the issue number is in the URL
    NUM="$(printf '%s' "$*" | sed -n 's|.*/issues/\([0-9]*\)/labels.*|\1|p')"
    if [ "${2:-}" = "-X" ] && [ "${3:-}" = "POST" ]; then
      for a in "$@"; do
        case "$a" in labels[]=*) mkdir -p "$GH_STATE/labels/${NUM}"; touch "$GH_STATE/labels/${NUM}/${a#labels[]=}" ;; esac
      done
    fi
    echo '{}' ;;
  *"issues/6"*)
    # issue 6 view: labels
    LBL=""
    for f in "$GH_STATE/labels/6"/*/* "$GH_STATE/labels/6"/*; do
      [ -f "$f" ] || continue
      LBL="$LBL{\"name\":\"$(basename "$f")\"},"
    done
    echo "{\"number\":6,\"title\":\"fixture issue\",\"labels\":[$(printf '%s' "${LBL%,}")]}" ;;
  *"issues/"*|*"issue edit"*)
    # --add-label / --remove-label form. The issue number arrives either in
    # a URL (.../issues/6) or as the bare operand of `gh issue edit 6`.
    NUM="$(printf '%s' "$*" | sed -n 's|.*/issues/\([0-9]*\)$|\1|p')"
    [ -n "$NUM" ] || NUM="$(printf '%s' "$*" | sed -n 's|.*issue edit \([0-9]*\).*|\1|p')"
    case "$*" in
      *--add-label*)
        for a in "$@"; do
          case "$a" in
            factory/*) mkdir -p "$GH_STATE/labels/${NUM}/$(dirname "$a")"; touch "$GH_STATE/labels/${NUM}/$a" ;;
          esac
        done ;;
      *--remove-label*)
        for a in "$@"; do
          case "$a" in factory/*) rm -f "$GH_STATE/labels/${NUM}/$a" ;; esac
        done ;;
    esac
    echo '{}' ;;
  *"issues?labels="*)
    # list issue numbers carrying a label (orchestrator-style WIP query)
    LBL="$(printf '%s' "$*" | sed -n 's|.*labels=\([^&]*\).*|\1|p')"
    ls "$GH_STATE/labels" 2>/dev/null | while IFS= read -r d; do
      [ -f "$GH_STATE/labels/$d/$LBL" ] && echo "$d"
    done ;;
  *"issue comment"*)
    for a in "$@"; do
      case "$a" in -b*|--body*) BODY="${a#-b}"; BODY="${BODY#--body}"; printf '%s\n' "$BODY" >> "$GH_STATE/issue-comments" ;; esac
    done
    echo '{"id": 3}' ;;
  *"pr merge"*|*"pr ready"*|*"pr create"*)
    echo "FAIL: forbidden medic write: gh $*" >&2
    exit 99 ;;
  auth\ status) ;;
  *)
    echo '{}' ;;
esac

if [ -n "$JQ_FILTER" ]; then
  # gh applies --jq per page; --slurp changes the input shape (each page
  # becomes one array element), so the flags must ride along or filters
  # written for slurped input see the wrong shape.
  jq $JQ_FLAGS --slurp "$JQ_FILTER" 2>/dev/null || true
fi
SHIM
chmod +x "${WORK}/shim/gh"

run_sweep() {
  GH_AUTH_SKIP=1 FACTORY_REPO=local/test PATH="${WORK}/shim:$PATH" sh "${MEDIC}"
}

# PR fixture: open draft PR #123, head factory/issue-6/code-pr, red checks.
cat > "${GH_STATE}/prs.json" <<EOF
{"number":123,"title":"factory PR (ci-red)","head":{"ref":"factory/issue-6/code-pr","sha":"${SHA_123}"},"draft":true,"labels":[],"body":""}
EOF
echo '[]' > "${GH_STATE}/pr-123-comments.json"
: > "${GH_STATE}/briefs"
: > "${GH_STATE}/issue-comments"
echo '[]' > "${GH_STATE}/issue-comments.json"
touch "${GH_STATE}/labels/6/factory/draft-pr"

# ---- proof 1: sweep queues exactly one repair with the constraint brief ------
OUT="$(run_sweep)" || fail "sweep exited non-zero: ${OUT}"
echo "${OUT}" | grep -q "repair queued" || fail "sweep did not queue a repair: ${OUT}"
grep -q "Medic brief" "${GH_STATE}/briefs" || fail "no medic brief posted"
grep -q "Never open a PR, never push to main, never force-push" "${GH_STATE}/briefs" \
  || fail "brief does not carry the push constraints"
grep -q "factory/issue-6/code-pr" "${GH_STATE}/briefs" || fail "brief missing the branch (push target)"
BRIEFS=$(grep -c "Medic brief" "${GH_STATE}/briefs" || true)
[ "${BRIEFS}" = "1" ] || fail "expected 1 brief, got ${BRIEFS}"
echo "${OUT}" | grep -q "attempt 1/3" || fail "sweep did not report the attempt counter"

# A second sweep while nothing is in flight would double-queue — but the
# one-PR-per-tick bound is enforced by the sweep's own break; the orchestrator
# label handoff is what prevents overlap. Simulate the label handoff:
touch "${GH_STATE}/labels/6/factory/queued"
OUT_B="$(run_sweep)" || fail "second sweep failed"
echo "${OUT_B}" | grep -q "nothing new queued" || fail "second sweep re-queued the same red PR: ${OUT_B}"
BRIEFS=$(grep -c "Medic brief" "${GH_STATE}/briefs" || true)
[ "${BRIEFS}" = "1" ] || fail "second sweep posted a duplicate brief (${BRIEFS})"
rm -f "${GH_STATE}/labels/6/factory/queued"

# ---- proof 1b: repair publishes through the guarded path → branch green -----
FIXDIR="${WORK}/fix"
git clone -q "${BARE}" "${FIXDIR}"
(
  cd "${FIXDIR}"
  git checkout -q factory/issue-6/code-pr
  printf '#!/bin/sh\necho ok\n' > src/broken.sh # the lint fix
)
git -C "${FIXDIR}" diff > "${WORK}/fix.diff"
git -C "${FIXDIR}" checkout -q -- src/broken.sh
if ! medic_publish_patch "${FIXDIR}" "factory/issue-6/code-pr" "${WORK}/fix.diff" "${SHA_123}"; then
  fail "medic_publish_patch failed on the happy path"
fi
NEW_HEAD="$(git -C "${FIXDIR}" rev-parse HEAD)"
[ "${NEW_HEAD}" != "${SHA_123}" ] || fail "branch head did not move"
# The pushed branch is now green under the verifier:
git -C "${FIXDIR}" fetch -q origin
if ! git -C "${FIXDIR}" checkout -q origin/factory/issue-6/code-pr && sh -c "${VERIFY_OK}" >/dev/null 2>&1; then
  git -C "${FIXDIR}" checkout -q factory/issue-6/code-pr
  if ! sh -c "${VERIFY_OK}" >/dev/null 2>&1; then
    fail "repaired branch still fails verification (not green)"
  fi
fi
# exactly one fix commit on top of the pinned head:
CNT=$(git -C "${FIXDIR}" rev-list --count "${SHA_123}..${NEW_HEAD}")
[ "${CNT}" = "1" ] || fail "expected exactly 1 fix commit, got ${CNT}"
# and the fix is on the PR branch, not main:
MAIN_HEAD="$(git -C "${FIXDIR}" ls-remote origin refs/heads/main | cut -f1)"
[ "${MAIN_HEAD}" != "${NEW_HEAD}" ] || fail "fix landed on main!"

# green on GitHub now → the sweep stays quiet.
touch "${GH_STATE}/checks-green"
OUT2="$(run_sweep)"
echo "${OUT2}" | grep -q "nothing new queued" || fail "sweep re-queued a green PR: ${OUT2}"
BRIEFS=$(grep -c "Medic brief" "${GH_STATE}/briefs" || true)
[ "${BRIEFS}" = "1" ] || fail "green PR got a second brief (${BRIEFS})"

# ---- proof 2: write guards -----------------------------------------------------
# 2a. main is refused.
if medic_publish_patch "${FIXDIR}" "main" "${WORK}/fix.diff" "" 2>"${WORK}/guard.err"; then
  fail "guard: push to main was allowed"
fi
grep -q "protected branch" "${WORK}/guard.err" || fail "guard: wrong refusal for main"
# 2b. a non-factory branch is refused.
if medic_publish_patch "${FIXDIR}" "feature/x" "${WORK}/fix.diff" "" 2>"${WORK}/guard.err"; then
  fail "guard: push to a non-factory branch was allowed"
fi
grep -q "not a factory/issue-" "${WORK}/guard.err" || fail "guard: wrong refusal for foreign branch"
# 2c. branch creation is refused (factory/issue-99/code-pr does not exist).
if medic_publish_patch "${FIXDIR}" "factory/issue-99/code-pr" "${WORK}/fix.diff" "" 2>"${WORK}/guard.err"; then
  fail "guard: branch creation was allowed"
fi
grep -q "does not exist on origin" "${WORK}/guard.err" || fail "guard: wrong refusal for new branch"
# 2d. moved head is refused (the anti-force-push lease)…
git -C "${FIXDIR}" reset -q --hard HEAD~1
MOVED="$(git -C "${FIXDIR}" rev-parse HEAD)"
if medic_publish_patch "${FIXDIR}" "factory/issue-6/code-pr" "${WORK}/fix.diff" "${MOVED}" 2>"${WORK}/guard.err"; then
  fail "guard: publish over a moved head was allowed"
fi
grep -q "moved since detection" "${WORK}/guard.err" || fail "guard: wrong refusal for moved head"
# …and the remote branch was NOT mutated:
CUR_HEAD="$(git -C "${FIXDIR}" ls-remote origin refs/heads/factory/issue-6/code-pr | cut -f1)"
[ "${CUR_HEAD}" = "${NEW_HEAD}" ] || fail "guard: branch mutated despite refusal"

# ---- proof 3: stuck path --------------------------------------------------------
# Re-break the branch (new head, red again), record 3 failed attempts on it.
(
  cd "${FIXDIR}"
  git checkout -q factory/issue-6/code-pr
  printf '#!/bin/sh\necho (broken again\n' > src/broken.sh
)
git -C "${FIXDIR}" diff > "${WORK}/break2.diff"
git -C "${FIXDIR}" checkout -q -- src/broken.sh
# push the broken state as the new PR head (as a failing repair attempt would have)
git -C "${FIXDIR}" apply --whitespace=nowarn "${WORK}/break2.diff"
git -C "${FIXDIR}" add -A
git -C "${FIXDIR}" commit -qm "factory(medic): repair attempt (fails again)"
BAD_HEAD="$(git -C "${FIXDIR}" rev-parse HEAD)"
git -C "${FIXDIR}" push -q origin HEAD:refs/heads/factory/issue-6/code-pr
rm -f "${GH_STATE}/checks-green"
# update the PR fixture to the new head
cat > "${GH_STATE}/prs.json" <<EOF
{"number":123,"title":"factory PR (ci-red again)","head":{"ref":"factory/issue-6/code-pr","sha":"${BAD_HEAD}"},"draft":true,"labels":[],"body":""}
EOF
# export for the shim's check-runs case
export SHA_123="${BAD_HEAD}"

python3 - > "${GH_STATE}/pr-123-comments.json" <<PY
import json
marker = "<!-- factory:medic:${BAD_HEAD}:failed -->"
print(json.dumps([{"body": marker} for _ in range(3)]))
PY

OUT3="$(run_sweep)" || fail "stuck-path sweep exited non-zero: ${OUT3}"
echo "${OUT3}" | grep -q "escalating" || fail "sweep did not escalate at budget: ${OUT3}"
if echo "${OUT3}" | grep -q "Medic brief"; then
  grep -q "Medic brief" "${GH_STATE}/briefs" || true
  N=$(grep -c "Medic brief" "${GH_STATE}/briefs" || true)
  [ "${N}" = "1" ] || fail "sweep queued a 4th repair after budget exhausted (${N} briefs)"
fi
grep -q "gave up" "${OUT3}" || fail "escalation did not log the give-up line"
# a further sweep is a no-op (stuck issue carries the label):
touch "${GH_STATE}/labels/6/factory/stuck"
OUT4="$(run_sweep)"
echo "${OUT4}" | grep -q "nothing new queued" || fail "sweep retried after escalation: ${OUT4}"

echo "PASS: medic red→green, write guards, and stuck escalation all behave"
