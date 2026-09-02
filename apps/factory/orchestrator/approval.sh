# Durable approval gates for sensitive factory transitions (#83, ADR-002 ledger).
# Sourced by run.sh. State lives on the GitHub issue: label
# factory/pending-approval + one <!-- factory:approval:<issue>:<action> -->
# comment holding the JSON record, so gates survive pod/tick restarts.
#
# OWNERSHIP (no double gates): executor policy (profile netpol/SA/resources)
# owns runtime capability; THIS gate owns the issue -> draft-PR transition;
# the reviewer/panel merge gates own the merge transition. The gate never
# re-checks CI, and the merge gates never re-check this approval.
#
# Keep approval_policy in sync with deploy/factory/base/profile-*.yaml.

APPROVAL_LABEL="factory/pending-approval"
APPROVAL_TTL_HOURS="${FACTORY_APPROVAL_TTL_HOURS:-48}"

approval_policy() {  # <profile> <operation> -> "required <hours>" | "none"
  case "$1:$2" in
    security:publish) echo "none" ;;
    reviewer:*) echo "none" ;;
    *:publish) echo "required ${APPROVAL_TTL_HOURS}" ;;
    *) echo "none" ;;
  esac
}

approval_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

approval_digest() { sha256sum "$1" 2>/dev/null | cut -d " " -f1; }

approval_epoch() {  # <iso-ts> -> epoch seconds (0 when unparsable)
  APPROVAL_EPOCH_TS="$1" python3 -c '
import datetime, os
ts = (os.environ.get("APPROVAL_EPOCH_TS") or "").strip()
for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
    try:
        t = datetime.datetime.strptime(ts, fmt).replace(tzinfo=datetime.timezone.utc)
        print(int(t.timestamp()))
        break
    except Exception:
        continue
else:
    print(0)
'
}

approval_add_hours() {  # <iso-ts> <hours> -> iso-ts
  APPROVAL_BASE_TS="$1" APPROVAL_ADD_HOURS="$2" python3 -c '
import datetime, os
base = (os.environ.get("APPROVAL_BASE_TS") or "").strip()
try:
    t = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except Exception:
    raise SystemExit(0)
print((t + datetime.timedelta(hours=int(os.environ["APPROVAL_ADD_HOURS"]))).strftime("%Y-%m-%dT%H:%M:%SZ"))
'
}

approval_find() {  # <repo> <issue> <action> <record_out> <id_out>; rc1 = gh failure
  _af_repo=$1
  _af_issue=$2
  _af_action=$3
  _af_tmp=$(mktemp) || return 1
  if ! gh api "repos/${_af_repo}/issues/${_af_issue}/comments?per_page=100" >"${_af_tmp}" 2>/dev/null; then
    rm -f "${_af_tmp}"
    return 1
  fi
  APPROVAL_FIND_FILE="${_af_tmp}" \
    APPROVAL_FIND_REC="$4" \
    APPROVAL_FIND_ID="$5" \
    APPROVAL_FIND_MARKER="factory:approval:${_af_issue}:${_af_action}" \
    python3 - <<'PYEOF'
import json, os
rec, cid = "", ""
try:
    comments = json.load(open(os.environ["APPROVAL_FIND_FILE"]))
except Exception:
    comments = []
for c in comments if isinstance(comments, list) else []:
    body = c.get("body") or ""
    if os.environ["APPROVAL_FIND_MARKER"] not in body:
        continue
    cid = str(c.get("id") or "")
    idx = body.rfind("```json")
    if idx < 0:
        continue
    end = body.find("```", idx + 7)
    if end < 0:
        continue
    rec = body[idx + 7:end].strip()
open(os.environ["APPROVAL_FIND_REC"], "w").write(rec)
open(os.environ["APPROVAL_FIND_ID"], "w").write(cid)
PYEOF
  rm -f "${_af_tmp}"
}

approval_get() {  # <record_file> <dotted.path> -> value ("" when missing)
  APPROVAL_GET_FILE="$1" APPROVAL_GET_PATH="$2" python3 -c '
import json, os
try:
    cur = json.load(open(os.environ["APPROVAL_GET_FILE"]))
    for part in os.environ["APPROVAL_GET_PATH"].split("."):
        cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is None:
            break
    print("" if cur is None else cur)
except Exception:
    print("")
'
}

approval_merge() {  # <record_file> <fragment_json> <out_file> (deep merge)
  APPROVAL_MERGE_FILE="$1" APPROVAL_MERGE_FRAGMENT="$2" APPROVAL_MERGE_OUT="$3" python3 - <<'PYEOF'
import json, os

def deep(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict):
            deep(a[k], v)
        else:
            a[k] = v
    return a

record = json.load(open(os.environ["APPROVAL_MERGE_FILE"]))
json.dump(deep(record, json.loads(os.environ["APPROVAL_MERGE_FRAGMENT"])),
          open(os.environ["APPROVAL_MERGE_OUT"], "w"), indent=2, sort_keys=True)
PYEOF
}

approval_comment_body() {  # <record_file> -> markdown on stdout
  APPROVAL_BODY_FILE="$1" python3 - <<'PYEOF'
import json, os
record = json.load(open(os.environ["APPROVAL_BODY_FILE"]))
decision = record.get("decision") or {}
artifact = record.get("artifact") or {}
lines = [
    "<!-- factory:approval:%s:%s -->" % (record.get("issue"), record.get("action")),
    "",
    "## 🛂 Factory approval — %s" % record.get("action", "publish"),
    "",
    "| | |",
    "|---|---|",
    "| Status | %s |" % record.get("status", "pending"),
    "| Repo | %s |" % record.get("repo", ""),
    "| Issue | #%s |" % record.get("issue", ""),
    "| Profile | %s |" % record.get("profile", ""),
    "| Branch | %s |" % record.get("branch", ""),
    "| Base | %s |" % record.get("base", "main"),
    "| Artifact digest | `%s` |" % record.get("digest", ""),
    "| Patch digest | `%s` |" % artifact.get("sha256", ""),
    "| Requested | %s |" % record.get("requested_at", ""),
    "| Expires | %s |" % record.get("expires_at", ""),
    "| Actor | %s |" % (decision.get("actor") or "—"),
    "| Decided | %s |" % (decision.get("at") or "—"),
]
if record.get("executed_at"):
    lines.append("| Executed | %s |" % record["executed_at"])
if record.get("pr_url"):
    lines.append("| PR | %s |" % record["pr_url"])
lines += [
    "",
    "> **What this gates:** opening the draft PR for this run (the staged branch itself is not the gated write). Approve/deny/cancel via the panel.",
    "",
]
rationale = (decision.get("rationale") or "").strip()
if rationale:
    lines += ["> %s" % line for line in rationale.splitlines() or [""]]
    lines.append("")
note = (decision.get("note") or "").strip()
if note:
    lines += ["> _%s_" % note, ""]
lines += ["```json", json.dumps(record, indent=2, sort_keys=True), "```", ""]
print("\n".join(lines))
PYEOF
}

approval_put() {  # <repo> <issue> <action> <record_file>; uses/sets APPROVAL_COMMENT_ID
  _ap_repo=$1
  _ap_issue=$2
  _ap_body=$(mktemp) || return 1
  approval_comment_body "$4" >"${_ap_body}"
  if [ -n "${APPROVAL_COMMENT_ID}" ]; then
    gh api -X PATCH "repos/${_ap_repo}/issues/comments/${APPROVAL_COMMENT_ID}" \
      -F body="$(cat "${_ap_body}")" >/dev/null
  else
    _ap_url=$(gh api -X POST "repos/${_ap_repo}/issues/${_ap_issue}/comments" \
      -F body="$(cat "${_ap_body}")" --jq .html_url)
    APPROVAL_COMMENT_ID=${_ap_url##*issuecomment-}
  fi
  rm -f "${_ap_body}"
}

approval_build_request() {  # <repo> <issue> <profile> <action> <branch> <base> <head_sha> <patch_file> <out_file>
  _br_pd=$(approval_digest "$8")
  _br_bytes=$(wc -c <"$8" | tr -d " ")
  _br_now=$(approval_now)
  APPROVAL_BUILD_OUT="$9" \
    APPROVAL_BUILD_REPO="$1" APPROVAL_BUILD_ISSUE="$2" APPROVAL_BUILD_PROFILE="$3" \
    APPROVAL_BUILD_ACTION="$4" APPROVAL_BUILD_BRANCH="$5" APPROVAL_BUILD_BASE="$6" \
    APPROVAL_BUILD_HEAD="$7" APPROVAL_BUILD_PATCH="${_br_pd}" APPROVAL_BUILD_BYTES="${_br_bytes:-0}" \
    APPROVAL_BUILD_NOW="${_br_now}" \
    APPROVAL_BUILD_EXP="$(approval_add_hours "${_br_now}" "${APPROVAL_TTL_HOURS}")" \
    python3 -c '
import json, os
record = {
    "action": os.environ["APPROVAL_BUILD_ACTION"],
    "repo": os.environ["APPROVAL_BUILD_REPO"],
    "issue": int(os.environ["APPROVAL_BUILD_ISSUE"]),
    "profile": os.environ["APPROVAL_BUILD_PROFILE"],
    "branch": os.environ["APPROVAL_BUILD_BRANCH"],
    "base": os.environ["APPROVAL_BUILD_BASE"],
    "digest": os.environ["APPROVAL_BUILD_HEAD"],
    "artifact": {"kind": "patch", "sha256": os.environ["APPROVAL_BUILD_PATCH"], "bytes": int(os.environ["APPROVAL_BUILD_BYTES"])},
    "requested_at": os.environ["APPROVAL_BUILD_NOW"],
    "expires_at": os.environ["APPROVAL_BUILD_EXP"],
    "status": "pending",
    "decision": None,
}
json.dump(record, open(os.environ["APPROVAL_BUILD_OUT"], "w"), indent=2, sort_keys=True)
'
}

approval_open_pr() {  # <repo> <issue> <profile> <branch> <base> -> PR URL
  _op_repo=$1
  _op_issue=$2
  _op_title=$(gh api "repos/${_op_repo}/issues/${_op_issue}" --jq .title 2>/dev/null || echo "factory: issue #${_op_issue}")
  _op_rec=$(mktemp)
  _op_id=$(mktemp)
  _op_approval_line=""
  if approval_find "${_op_repo}" "${_op_issue}" "publish" "${_op_rec}" "${_op_id}" && [ -s "${_op_rec}" ]; then
    if [ "$(approval_get "${_op_rec}" "status")" = "approved" ]; then
      _op_approval_line="> **Publish approval:** $(approval_get "${_op_rec}" "decision.actor") at $(approval_get "${_op_rec}" "decision.at") — digest $(approval_get "${_op_rec}" "digest").
"
    fi
  fi
  rm -f "${_op_rec}" "${_op_id}"
  gh pr create -R "${_op_repo}" --draft \
    --head "$4" --base "$5" \
    --title "${_op_title}" \
    --body "$(cat <<EOF
## Factory Run — ${3}

Closes #${_op_issue}

> ⚠️ **Automated draft PR** produced by the homelab software factory.
> Requires CI green + human review before promotion. Do not auto-merge.

${_op_approval_line}
**Verification:** see status comment on the linked issue.
EOF
)"
}

approval_mark_executed() {  # <repo> <issue> <action> <pr_url>
  _me_rec=$(mktemp)
  _me_id=$(mktemp)
  if ! approval_find "$1" "$2" "$3" "${_me_rec}" "${_me_id}"; then
    rm -f "${_me_rec}" "${_me_id}"
    return 1
  fi
  APPROVAL_COMMENT_ID=$(cat "${_me_id}")
  rm -f "${_me_id}"
  if [ ! -s "${_me_rec}" ]; then
    rm -f "${_me_rec}"
    return 1
  fi
  approval_merge "${_me_rec}" "{\"executed_at\":\"$(approval_now)\",\"pr_url\":\"$4\"}" "${_me_rec}.m"
  mv "${_me_rec}.m" "${_me_rec}"
  approval_put "$1" "$2" "$3" "${_me_rec}"
  rm -f "${_me_rec}"
}

approval_park() {  # <repo> <issue> <reason>
  gh issue edit "$2" -R "$1" --remove-label "${APPROVAL_LABEL}" --add-label "factory/failed" >/dev/null 2>&1 || true
  gh issue comment "$2" -R "$1" --body "🛂 Publish not executed — $3." >/dev/null 2>&1 || true
  echo "[orch] issue #$2 parked in factory/failed: $3"
}

approval_gate_publish() {  # <repo> <issue> <profile> <branch> <base> <patch_file> <head_sha> -> reason; rc0 = proceed
  _g_repo=$1
  _g_issue=$2
  _g_profile=$3
  _g_branch=$4
  _g_patch=$6
  _g_head=$7
  case "$(approval_policy "${_g_profile}" "publish")" in
    none*)
      echo "proceed"
      return 0
      ;;
  esac
  _g_rec=$(mktemp)
  _g_id=$(mktemp)
  if ! approval_find "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}" "${_g_id}"; then
    rm -f "${_g_rec}" "${_g_id}"
    echo "invalidated"
    return 1
  fi
  APPROVAL_COMMENT_ID=$(cat "${_g_id}")
  rm -f "${_g_id}"
  _g_reason="awaiting"
  if [ ! -s "${_g_rec}" ]; then
    approval_build_request "${_g_repo}" "${_g_issue}" "${_g_profile}" "publish" "${_g_branch}" "$5" "${_g_head}" "${_g_patch}" "${_g_rec}"
    approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
  else
    _g_status=$(approval_get "${_g_rec}" "status")
    case "${_g_status}" in
      pending)
        if [ "$(approval_epoch "$(approval_get "${_g_rec}" "expires_at")")" -lt "$(approval_epoch "$(approval_now)")" ]; then
          approval_merge "${_g_rec}" '{"status":"expired","decision":{"actor":"factory","rationale":"approval request expired (ttl '"${APPROVAL_TTL_HOURS}"'h) without a decision"}}' "${_g_rec}.m"
          mv "${_g_rec}.m" "${_g_rec}"
          approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
          _g_reason="expired"
        elif [ "$(approval_get "${_g_rec}" "digest")" != "${_g_head}" ]; then
          approval_build_request "${_g_repo}" "${_g_issue}" "${_g_profile}" "publish" "${_g_branch}" "$5" "${_g_head}" "${_g_patch}" "${_g_rec}"
          approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
        fi
        ;;
      approved)
        _g_decided=$(approval_get "${_g_rec}" "decision.at")
        _g_limit=$(approval_add_hours "${_g_decided}" "${APPROVAL_TTL_HOURS}")
        if [ -z "${_g_decided}" ] || [ "$(approval_epoch "${_g_limit}")" -lt "$(approval_epoch "$(approval_now)")" ]; then
          approval_merge "${_g_rec}" '{"status":"expired","decision":{"note":"approval expired unexecuted (ttl '"${APPROVAL_TTL_HOURS}"'h)"}}' "${_g_rec}.m"
          mv "${_g_rec}.m" "${_g_rec}"
          approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
          _g_reason="expired"
        elif [ "$(approval_get "${_g_rec}" "digest")" != "${_g_head}" ]; then
          approval_merge "${_g_rec}" '{"status":"invalidated","decision":{"note":"artifact changed after approval"}}' "${_g_rec}.m"
          mv "${_g_rec}.m" "${_g_rec}"
          approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
          _g_reason="invalidated"
        else
          _g_reason="proceed"
        fi
        ;;
      denied | cancelled)
        _g_reason="denied"
        ;;
      expired)
        _g_reason="expired"
        ;;
      invalidated)
        _g_reason="invalidated"
        ;;
      *)
        approval_merge "${_g_rec}" '{"status":"invalidated","decision":{"note":"unknown record status — failing closed"}}' "${_g_rec}.m"
        mv "${_g_rec}.m" "${_g_rec}"
        approval_put "${_g_repo}" "${_g_issue}" "publish" "${_g_rec}"
        _g_reason="invalidated"
        ;;
    esac
  fi
  rm -f "${_g_rec}"
  echo "${_g_reason}"
  if [ "${_g_reason}" = "proceed" ]; then
    return 0
  fi
  return 1
}

approval_resume_one() {  # <repo> <issue>; rc0 = handled, rc1 = retry next tick
  _ro_repo=$1
  _ro_issue=$2
  _ro_rec=$(mktemp)
  _ro_id=$(mktemp)
  if ! approval_find "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_rec}" "${_ro_id}"; then
    rm -f "${_ro_rec}" "${_ro_id}"
    return 1
  fi
  APPROVAL_COMMENT_ID=$(cat "${_ro_id}")
  rm -f "${_ro_id}"
  if [ ! -s "${_ro_rec}" ]; then
    rm -f "${_ro_rec}"
    approval_park "${_ro_repo}" "${_ro_issue}" "pending-approval label without an approval record"
    return 0
  fi
  _ro_status=$(approval_get "${_ro_rec}" "status")
  _ro_branch=$(approval_get "${_ro_rec}" "branch")
  _ro_base=$(approval_get "${_ro_rec}" "base")
  _ro_base=${_ro_base:-main}
  case "${_ro_status}" in
    pending)
      if [ "$(approval_epoch "$(approval_get "${_ro_rec}" "expires_at")")" -lt "$(approval_epoch "$(approval_now)")" ]; then
        approval_merge "${_ro_rec}" '{"status":"expired","decision":{"actor":"factory","rationale":"approval request expired (ttl '"${APPROVAL_TTL_HOURS}"'h) without a decision"}}' "${_ro_rec}.m"
        mv "${_ro_rec}.m" "${_ro_rec}"
        approval_put "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_rec}"
        rm -f "${_ro_rec}"
        approval_park "${_ro_repo}" "${_ro_issue}" "publish request expired before a decision (ttl ${APPROVAL_TTL_HOURS}h)"
      else
        rm -f "${_ro_rec}"
        echo "[orch] issue #${_ro_issue}: publish approval pending — waiting on a human decision"
      fi
      return 0
      ;;
    approved)
      _ro_decided=$(approval_get "${_ro_rec}" "decision.at")
      _ro_limit=$(approval_add_hours "${_ro_decided}" "${APPROVAL_TTL_HOURS}")
      _ro_digest=$(approval_get "${_ro_rec}" "digest")
      if [ -z "${_ro_decided}" ] || [ "$(approval_epoch "${_ro_limit}")" -lt "$(approval_epoch "$(approval_now)")" ]; then
        approval_merge "${_ro_rec}" '{"status":"expired","decision":{"note":"approval expired unexecuted (ttl '"${APPROVAL_TTL_HOURS}"'h)"}}' "${_ro_rec}.m"
        mv "${_ro_rec}.m" "${_ro_rec}"
        approval_put "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_rec}"
        rm -f "${_ro_rec}"
        approval_park "${_ro_repo}" "${_ro_issue}" "approved publish expired unexecuted (ttl ${APPROVAL_TTL_HOURS}h)"
        return 0
      fi
      if [ -z "${_ro_branch}" ]; then
        rm -f "${_ro_rec}"
        approval_park "${_ro_repo}" "${_ro_issue}" "approval record has no branch — failing closed"
        return 0
      fi
      _ro_live=$(gh api "repos/${_ro_repo}/git/refs/heads/${_ro_branch}" --jq '.object.sha' 2>/dev/null || echo "")
      if [ -z "${_ro_live}" ]; then
        approval_merge "${_ro_rec}" '{"status":"invalidated","decision":{"note":"staged branch vanished after approval"}}' "${_ro_rec}.m"
        mv "${_ro_rec}.m" "${_ro_rec}"
        approval_put "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_rec}"
        rm -f "${_ro_rec}"
        approval_park "${_ro_repo}" "${_ro_issue}" "staged branch ${_ro_branch} is gone — approval invalidated"
        return 0
      fi
      if [ "${_ro_live}" != "${_ro_digest}" ]; then
        approval_merge "${_ro_rec}" '{"status":"invalidated","decision":{"note":"artifact changed after approval"}}' "${_ro_rec}.m"
        mv "${_ro_rec}.m" "${_ro_rec}"
        approval_put "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_rec}"
        rm -f "${_ro_rec}"
        approval_park "${_ro_repo}" "${_ro_issue}" "branch moved after approval (${_ro_digest} -> ${_ro_live}) — approval invalidated"
        return 0
      fi
      if ! _ro_pr=$(approval_open_pr "${_ro_repo}" "${_ro_issue}" "$(approval_get "${_ro_rec}" "profile")" "${_ro_branch}" "${_ro_base}"); then
        rm -f "${_ro_rec}"
        return 1
      fi
      rm -f "${_ro_rec}"
      approval_mark_executed "${_ro_repo}" "${_ro_issue}" "publish" "${_ro_pr}" || true
      gh issue edit "${_ro_issue}" -R "${_ro_repo}" --remove-label "${APPROVAL_LABEL}" --add-label "factory/draft-pr" >/dev/null
      gh issue comment "${_ro_issue}" -R "${_ro_repo}" --body "🏭 Draft PR ready (publish approved): ${_ro_pr}" >/dev/null
      echo "[orch] issue #${_ro_issue}: publish approval honored → ${_ro_pr}"
      return 0
      ;;
    denied | cancelled)
      _ro_rat=$(approval_get "${_ro_rec}" "decision.rationale")
      rm -f "${_ro_rec}"
      approval_park "${_ro_repo}" "${_ro_issue}" "publish ${_ro_status}${_ro_rat:+: ${_ro_rat}}"
      return 0
      ;;
    expired | invalidated)
      rm -f "${_ro_rec}"
      approval_park "${_ro_repo}" "${_ro_issue}" "publish ${_ro_status} (recorded earlier)"
      return 0
      ;;
    *)
      rm -f "${_ro_rec}"
      approval_park "${_ro_repo}" "${_ro_issue}" "approval record has unknown status '${_ro_status}' — failing closed"
      return 0
      ;;
  esac
}

approval_resume() {  # <repo>
  _rs_repo=$1
  _rs_nums=$(gh api "repos/${_rs_repo}/issues?labels=${APPROVAL_LABEL}&state=open&per_page=20" --jq '.[].number' 2>/dev/null || true)
  [ -n "${_rs_nums}" ] || return 0
  for _rs_num in ${_rs_nums}; do
    approval_resume_one "${_rs_repo}" "${_rs_num}" ||
      echo "[orch] WARN approval resume failed for issue #${_rs_num} (retries next tick)" >&2
  done
}
