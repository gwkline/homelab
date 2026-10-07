#!/bin/sh
# Factory orchestrator (ADR-003: GitHub is the ledger).
# Runs as a single-instance CronJob (concurrency: Forbid).
#
# One tick:
#   0. Reclaim stranded factory/in-progress issues (stale, no draft PR)
#   1. Find ONE queued issue (oldest first)
#   2. Swap label to factory/in-progress + post run marker comment
#   3. Spawn a worker Job from the profile
#   4. Watch it to completion; extract /out artifacts from pod logs
#   5. Publish: apply patch → push branch → draft PR
#   6. Converge labels on every exit path (success, failure, crash)
#
# Stop conditions (why every path terminates):
#   - gh/kubectl/git are all timeout-wrapped: a hung connection fails the
#     step, never wedges the tick against activeDeadlineSeconds.
#   - EXIT trap: dying mid-run converges the issue label to factory/failed
#     so no issue is ever stranded in factory/in-progress.
#   - Worker failure auto-retries once (2 run markers max), then parks the
#     issue in factory/failed for a human.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Shared gh wrapper, labels, markers, check and verify rules.
FACTORY_LIB_DIR="${FACTORY_LIB_DIR:-/usr/local/lib/factory}"
[ -f "${FACTORY_LIB_DIR}/factory.sh" ] || FACTORY_LIB_DIR="${SCRIPT_DIR}/../lib"
# shellcheck source=apps/factory/lib/factory.sh
. "${FACTORY_LIB_DIR}/factory.sh"

REPO="${FACTORY_REPO:?FACTORY_REPO required (owner/name)}"
# Repo allowlist (mirrors the panel's /api/factory/run allowlist).
WHITELIST="${FACTORY_REPOS:-gwkline/homelab,gwkline/launchpad,gwkline/plantry,gwkline/personal-site,gwkline/kline-services-bot,gwkline/discord-bot,gwkline/pr-czar}"
case ",${WHITELIST}," in
  *",${REPO},"*) ;;
  *) echo "[orch] repo ${REPO} not whitelisted for factory runs" >&2; exit 78 ;;
esac
PROFILE="${FACTORY_PROFILE:-${PROFILE:-code-pr}}"
# Workflow identity recorded on the run (marker comment + worker brief):
# profile@version pins which orchestrator behavior stack produced the Run.
WORKFLOW_VERSION="${FACTORY_WORKFLOW_VERSION:-v1}"
# An in-progress issue with no draft PR older than this is reclaimed to queued.
STALE_HOURS="${FACTORY_STALE_HOURS:-2}"

# Hard timeouts: a hung connection must fail the step, not burn the tick's
# activeDeadline (gh's is in factory.sh).
kubectl() { timeout 120 "${KUBECTL_BIN:-/usr/local/bin/kubectl}" "$@"; }
gitt() { timeout 300 /usr/bin/git "$@"; }
timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# Redact the GitHub token from worker output destined for comments: an agent
# could have printed its env.
redact() {
  if [ -n "${GH_TOKEN:-}" ]; then
    sed "s#${GH_TOKEN}#***#g"
  else
    cat
  fi
}

# Run marker comment template (one comment per Run, edited in place).
. "${SCRIPT_DIR}/marker.sh"

# Update the run marker comment; a no-op until the marker exists. Must be
# defined above its first caller (dash resolves functions at call time).
MARKER_ID=""
update_status() {  # $1=status, $2=extra detail markdown
  if [ -n "${MARKER_ID}" ]; then
    gh api -X PATCH "repos/${REPO}/issues/comments/${MARKER_ID}" \
      -F body="$(factory_marker_body "${1}" "${2:-}" "$(timestamp)")" >/dev/null
  fi
}

# Hand the issue to a human: failed plus stuck, because the reclaimer would
# only retry a run that must fail the same way. $1 = the label it leaves.
park_for_human() {
  gh label create "${LABEL_STUCK}" -R "${REPO}" --color ededed \
    --description "factory: needs human review" >/dev/null 2>&1 || true
  gh issue edit "${NUM}" -R "${REPO}" --remove-label "$1" \
    --add-label "${LABEL_FAILED}" --add-label "${LABEL_STUCK}" >/dev/null
}

NUM=""
# shellcheck disable=SC2329  # invoked via `trap cleanup EXIT` below
# Crash convergence: if we die while the issue is still in-progress, move it
# to failed. The label is checked live so normal terminal transitions win.
cleanup() {
  RC=$?
  if [ -n "${NUM}" ] && [ "${RC}" -ne 0 ]; then
    if gh api "repos/${REPO}/issues/${NUM}" --jq '.labels[].name' 2>/dev/null | grep -qx "${LABEL_WIP}"; then
      gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null 2>&1 || true
      gh issue comment "${NUM}" -R "${REPO}" --body "⚙️ Orchestrator tick died (exit ${RC}) before finishing this run — labeled factory/failed. Relabel factory/queued to retry." >/dev/null 2>&1 || true
      echo "[orch] crash cleanup: issue #${NUM} → ${LABEL_FAILED}" >&2
    fi
  fi
  # No explicit exit: POSIX preserves the original status after the trap.
}
trap cleanup EXIT

factory_gh_auth || { echo "[orch] no gh auth" >&2; exit 1; }

# ---- 0. reclaim stranded in-progress issues --------------------------------
# A tick that died between the label swap and the Job spawn orphans the
# issue. Reclaim: in-progress + no PR for this issue+profile + run marker
# older than STALE_HOURS → back to queued.
RECLAIMED=0
for LNUM in $(gh api "repos/${REPO}/issues?labels=${LABEL_WIP}&state=open&per_page=20" --jq '.[].number' 2>/dev/null || true); do
  BRANCH="factory/issue-${LNUM}/${PROFILE}"
  # Never touch labels on uncertain state: a failed lookup skips this tick.
  if ! PRS=$(gh pr list -R "${REPO}" --head "${BRANCH}" --state all --json number --jq 'length' 2>/dev/null); then
    echo "[orch] WARN reclaim: PR lookup failed for issue #${LNUM} — skipping this tick" >&2
    continue
  fi
  if [ "${PRS}" != "0" ]; then
    # Run completed but the label was never swapped — just clean up.
    gh issue edit "${LNUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" >/dev/null 2>&1 || true
    continue
  fi
  MARK_TS=$(gh api "repos/${REPO}/issues/${LNUM}/comments?per_page=100" --jq "[.[] | select(.body | contains(\"<!-- ${FACTORY_RUN_MARKER}\"))] | last | .body // \"\"" 2>/dev/null \
    | sed -n "s/.*${FACTORY_RUN_MARKER}[0-9]*:\([0-9T:Z-]*\).*/\1/p" || true)
  AGE_H=$(python3 - "${MARK_TS}" << 'PY'
import sys, datetime
ts = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
try:
    t = datetime.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    print(int((datetime.datetime.now(datetime.timezone.utc) - t).total_seconds() // 3600))
except Exception:
    print(999)  # unparsable/missing marker → treat as ancient
PY
)
  if [ "${AGE_H}" -ge "${STALE_HOURS}" ]; then
    echo "[orch] reclaiming stranded issue #${LNUM} (no PR, marker age ${AGE_H}h)"
    gh issue edit "${LNUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_QUEUED}" >/dev/null
    gh issue comment "${LNUM}" -R "${REPO}" --body "♻️ Reclaimed: run stalled >${STALE_HOURS}h with no draft PR — back in the queue." >/dev/null
    RECLAIMED=$((RECLAIMED + 1))
  fi
done
[ "${RECLAIMED}" = "0" ] || echo "[orch] reclaimed ${RECLAIMED} stranded issue(s)"

# ---- 1. find ONE queued issue ----------------------------------------------
# One issue per tick so each run gets the full tick budget. The panel's
# manual trigger pins an issue via FACTORY_ISSUE (avoids a label-propagation
# race).
NUM_Q=""
if [ -n "${FACTORY_ISSUE:-}" ]; then
  if gh api "repos/${REPO}/issues/${FACTORY_ISSUE}" --jq '.labels[].name' 2>/dev/null | grep -qx "${LABEL_QUEUED}"; then
    NUM_Q="${FACTORY_ISSUE}"
  else
    echo "[orch] FACTORY_ISSUE=${FACTORY_ISSUE} has no ${LABEL_QUEUED} label — falling back to queue poll" >&2
  fi
fi
if [ -z "${NUM_Q}" ]; then
  NUM_Q=$(gh api "repos/${REPO}/issues?labels=${LABEL_QUEUED}&state=open&per_page=5" \
    --jq 'sort_by(.created_at) | .[0].number // ""' 2>/dev/null || echo "")
  [ -n "${NUM_Q}" ] || { echo "[orch] $(timestamp) nothing queued"; exit 0; }
fi
NUM="${NUM_Q}"
TITLE=$(gh api "repos/${REPO}/issues/${NUM}" --jq '.title' 2>/dev/null || echo "issue #${NUM}")
echo "[orch] $(timestamp) picked issue #${NUM}: ${TITLE}"
BRANCH="factory/issue-${NUM}/${PROFILE}"
RUN_TS=$(timestamp)

# ---- idempotency: skip if a PR already exists for this issue+profile ----
EXISTING=$(gh pr list -R "${REPO}" --head "${BRANCH}" --state all --json number --jq 'length')
if [ "${EXISTING}" != "0" ]; then
  echo "[orch] branch ${BRANCH} already has PR — skipping duplicate"
  # A prior publisher may have died before converging labels; repair them so
  # the collector does not requeue the issue forever.
  gh issue edit "${NUM}" -R "${REPO}" \
    --remove-label "${LABEL_QUEUED}" --remove-label "${LABEL_WIP}" \
    --add-label "${LABEL_DONE}" >/dev/null
  exit 0
fi

# ---- 2. resolve the RunProfile ---------------------------------------------
# The profile ConfigMap renders the whole worker Job (worker-job.jq);
# WORKER_IMAGE_OVERRIDE swaps only its image (tests, manual dispatches). An
# unknown profile or an incomplete one parks the issue.
PROFILE_CM="factory-profile-${PROFILE}"
PROFILE_JSON=$(kubectl get configmap "${PROFILE_CM}" -n sandbox -o jsonpath='{.data.profile\.json}' 2>/dev/null) || PROFILE_JSON=""
WORKER_IMAGE=$(printf '%s' "${PROFILE_JSON}" | jq -r --arg name "${PROFILE}" --arg override "${WORKER_IMAGE_OVERRIDE:-}" '
  select(.name == $name
    and (.serviceAccount | type) == "string"
    and (.activeDeadlineSeconds | type) == "number"
    and (.backoffLimit | type) == "number"
    and (.ttlSecondsAfterFinished | type) == "number"
    and (.resources.limits["ephemeral-storage"] | type) == "string"
    and (.workSizeLimit | type) == "string")
  | if $override != "" then $override else .image end' 2>/dev/null) || WORKER_IMAGE=""
case "${WORKER_IMAGE:-}" in
  ghcr.io/*)
    PROFILE_JSON=$(printf '%s' "${PROFILE_JSON}" | jq -c --arg image "${WORKER_IMAGE}" '.image = $image')
    ;;
  *)
    echo "[orch] FATAL: cannot resolve a complete RunProfile from configmap ${PROFILE_CM} (RBAC? profile not applied?)" >&2
    update_status "failed" "Orchestrator could not resolve a complete RunProfile from configmap \`${PROFILE_CM}\` — check RBAC and that the profile is applied."
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
    exit 1
    ;;
esac

# ---- 2b. capabilities ---------------------------------------------------------
# An issue labelled needs:<capability> that its profile lacks (e.g.
# needs:cluster on code-pr, which has no Kubernetes API) cannot succeed: park
# it on the first pick instead of churning through retries.
NEEDS=$(gh api "repos/${REPO}/issues/${NUM}" --jq '[.labels[].name | select(startswith("needs:")) | ltrimstr("needs:")] | join(" ")' 2>/dev/null || echo "")
MISSING=$(printf '%s' "${PROFILE_JSON}" | jq -r --arg needs "${NEEDS}" '($needs | split(" ") | map(select(. != ""))) - (.capabilities // []) | join(", ")')
if [ -n "${MISSING}" ]; then
  park_for_human "${LABEL_QUEUED}"
  gh issue comment "${NUM}" -R "${REPO}" --body "🚫 Not attemptable in profile \`${PROFILE}\`: this issue needs ${MISSING}, which the profile does not provide (it has: $(printf '%s' "${PROFILE_JSON}" | jq -r '(.capabilities // []) | join(", ")')). Parked on \`${LABEL_STUCK}\` instead of retrying: do it by hand, or relabel \`${LABEL_QUEUED}\` once a profile can." >/dev/null
  echo "[orch] issue #${NUM}: needs ${MISSING}, which profile ${PROFILE} lacks — parked"
  exit 0
fi

# ---- 3. swap labels + post marker comment --------------------------------
gh issue edit "${NUM}" -R "${REPO}" \
    --remove-label "${LABEL_QUEUED}" --add-label "${LABEL_WIP}" >/dev/null
COMMENT_URL=$(gh issue comment "${NUM}" -R "${REPO}" --body "$(factory_marker_body running "_Worker dispatched — this comment updates live._")")
echo "[orch] marker comment: ${COMMENT_URL}"

MARKER_ID=${COMMENT_URL##*issuecomment-}

# ---- 3. spawn the worker Job ---------------------------------------------
JOB_NAME="factory-issue-${NUM}-$(date +%s)"
gh issue view "${NUM}" -R "${REPO}" --json number,title,body,url > /tmp/issue.json

VERIFY_CMD="$(verify_for "${REPO}")"

# ---- 3b. knowledge context ------------------------------------------------
# Fail-open: knowledge-context.sh always writes a status record and exits 0,
# so a knowledge outage never fails a run. Retrieved content is untrusted data
# in the brief and cannot override profile instructions.
KNOWLEDGE_FILE="/tmp/knowledge-${NUM}.json"
sh "${SCRIPT_DIR}/knowledge-context.sh" "${REPO}" /tmp/issue.json "${KNOWLEDGE_FILE}" 2>&1 || true
# An explicit "crashed" record beats a silently absent section.
if [ ! -s "${KNOWLEDGE_FILE}" ]; then
  printf '{"status":"unavailable","error":"knowledge context assembly crashed","queries":[],"citations":[]}' > "${KNOWLEDGE_FILE}"
fi

# Compact record for the Run comment: queries, retrieval config, citations
# (no chunk text; full text rides in the brief).
KNOWLEDGE_BLOCK=$(python3 - "${KNOWLEDGE_FILE}" << 'PYEOF'
import json, sys

try:
    k = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    k = {"status": "unavailable"}
status = k.get("status") or "unavailable"
cites = k.get("citations") or []


def ref(c):
    s = c.get("source") or {}
    return s.get("url") or s.get("path") or s.get("source_id") or "unknown"


head = f"knowledge context: **{status}**"
if status == "ok" and cites:
    ns = k.get("namespace") or "?"
    items = "; ".join(f"{c.get('id')} `{ref(c)}`" for c in cites)
    head += (
        f" — {len(cites)} citation(s), {len(k.get('queries') or [])} query/ies, "
        f"namespace `{ns}`: {items}"
    )
    head += (
        "\n\n_Citations are UNTRUSTED reference data in the brief; the worker "
        "report names the ids that influenced the change._"
    )
    rec = {kk: k.get(kk) for kk in ("status", "namespace", "error", "service_run_ids", "retrieval", "queries")}
    rec["citations"] = [
        {
            "id": c.get("id"),
            "chunk_id": c.get("chunk_id"),
            "document_id": c.get("document_id"),
            "title": c.get("title"),
            "score": c.get("score"),
            "retrieved_by": c.get("retrieved_by"),
            "source": c.get("source"),
            "version": c.get("version"),
            "anchors": c.get("anchors"),
        }
        for c in cites
    ]
    head += "\n\n```json\n%s\n```" % json.dumps(rec, indent=2)
elif k.get("error"):
    head += f" — {k['error']}"
print(head)
PYEOF
)

python3 - "${REPO}" "${NUM}" "${VERIFY_CMD}" "issue${NUM}-${RUN_TS}" "${PROFILE}" "${WORKFLOW_VERSION}" "${KNOWLEDGE_FILE}" << 'PYEOF' > /tmp/brief.json
import json, sys
repo, num, verify, run_id, profile, workflow, knowledge_file = sys.argv[1:8]
d = json.load(open("/tmp/issue.json"))
try:
    knowledge = json.load(open(knowledge_file))
except Exception:
    knowledge = {
        "status": "unavailable",
        "error": "knowledge context record unreadable",
        "queries": [],
        "citations": [],
    }
print(json.dumps({
    # run_id maps 1:1 to the run marker (factory:run:<issue>:<ts>).
    "run_id": run_id,
    "repository": repo,
    "issue": d,
    "profile": profile,
    "workflow_version": workflow,
    "constraints": ["draft PR only", "minimal diff"],
    "verify_command": verify,
    # Untrusted, cited reference data; never a source of instructions.
    "knowledge": knowledge
}))
PYEOF
BRIEF_B64=$(base64 -w0 /tmp/brief.json)

jq -n --argjson profile "${PROFILE_JSON}" --arg job "${JOB_NAME}" --arg issue "${NUM}" \
  --arg repo "${REPO}" --arg brief_b64 "${BRIEF_B64}" \
  --arg worker_cmd "${WORKER_CMD:-claude --dangerously-skip-permissions}" \
  -f "${SCRIPT_DIR}/worker-job.jq" > /tmp/worker-job.json
kubectl apply -f /tmp/worker-job.json
echo "[orch] job ${JOB_NAME} created"

update_status "running" "_Job \`${JOB_NAME}\` running._

<details><summary>knowledge context</summary>

${KNOWLEDGE_BLOCK}

</details>"

# ---- 4. wait for completion -----------------------------------------------
# Poll instead of `kubectl wait`, whose exit status dash + set -e can swallow.
# Stop 200s short of the profile's Job deadline (image pull/startup).
WAIT_TICKS=$(( $(printf '%s' "${PROFILE_JSON}" | jq '.activeDeadlineSeconds') / 10 - 20 ))
WAIT_OK=0
for _i in $(seq 1 "${WAIT_TICKS}"); do
  PHASE=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "")
  if [ "${PHASE}" = "True" ]; then WAIT_OK=1; break; fi
  FAILED=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || echo "")
  if [ "${FAILED}" = "True" ]; then break; fi
  sleep 10
done
if [ "${WAIT_OK}" != "1" ]; then
  LOGTAIL=$(kubectl logs "job/${JOB_NAME}" -n sandbox --all-containers --tail=40 2>/dev/null | redact || true)
  # Exit 78 from the clone step or the worker is "cannot attempt": a required
  # input or setting is missing (private skills, the model key, the run brief),
  # so a retry would fail the same way. Park it with the reason instead.
  EXIT_CODES=$(kubectl get pods -n sandbox -l job-name="${JOB_NAME}" -o jsonpath='{.items[0].status.initContainerStatuses[*].state.terminated.exitCode} {.items[0].status.containerStatuses[*].state.terminated.exitCode}' 2>/dev/null || true)
  case " ${EXIT_CODES} " in
    *" 78 "*)
      REASON=$(printf '%s\n' "${LOGTAIL}" | sed -n 's/.*CANNOT ATTEMPT: //p' | tail -n 1)
      update_status "cannot attempt" "**Cannot attempt:** ${REASON:-the worker exited 78; see the log tail}.

Fix that, then remove \`${LABEL_STUCK}\` and \`${LABEL_FAILED}\` and relabel \`${LABEL_QUEUED}\`. Not retried automatically: it would fail the same way.

<details><summary>log tail</summary>

\`\`\`
${LOGTAIL}
\`\`\`
</details>"
      park_for_human "${LABEL_WIP}"
      echo "[orch] issue #${NUM}: cannot attempt (${REASON:-exit 78}) — parked, not retried"
      exit 0
      ;;
  esac
  # Bounded auto-retry: one extra attempt for transient failures (flaky
  # provider, netpol blip). 2 run markers max, then park in failed for a human.
  ATTEMPTS=$(gh api "repos/${REPO}/issues/${NUM}/comments?per_page=100" --jq "[.[] | select(.body | contains(\"<!-- ${FACTORY_RUN_MARKER}\"))] | length" 2>/dev/null || echo 2)
  if [ "${ATTEMPTS}" -lt 2 ]; then
    update_status "retrying" "Job failed (attempt ${ATTEMPTS}) — auto-retry queued.

<details><summary>log tail</summary>

\`\`\`
${LOGTAIL}
\`\`\`
</details>"
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_QUEUED}" >/dev/null
    echo "[orch] issue #${NUM}: worker failed, re-queued for retry (attempt 2 of 2)"
    exit 0
  fi
  update_status "failed" "Job failed after ${ATTEMPTS} attempts.

<details><summary>log tail</summary>

\`\`\`
${LOGTAIL}
\`\`\`
</details>"
  gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
  exit 0
fi

# ---- 5. extract patch from the completed pod -------------------------------
# The worker prints base64 artifacts to its logs (kubectl cp/exec need a
# running pod; Job pods are terminated). Prefer the Succeeded pod.
POD=$(kubectl get pods -n sandbox -l job-name="${JOB_NAME}" --field-selector status.phase=Succeeded -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -z "${POD}" ]; then
  POD=$(kubectl get pods -n sandbox -l job-name="${JOB_NAME}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
fi
if [ -z "${POD}" ]; then
  update_status "failed" "Could not find worker pod for job ${JOB_NAME}."
  gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
  exit 0
fi
# Logs are fetched once: they carry both PATCH_B64 and REPORT_B64 blocks.
POD_LOGS="/tmp/pod-logs-${NUM}.txt"
kubectl logs -n sandbox "${POD}" -c worker > "${POD_LOGS}" 2>/dev/null || true
EXTRACTED=0
if grep -q "PATCH_B64_BEGIN" "${POD_LOGS}"; then
  sed -n '/---PATCH_B64_BEGIN---/,/---PATCH_B64_END---/p' "${POD_LOGS}" \
    | grep -v -- "---PATCH" | tr -d '\n\r ' | base64 -d > "/tmp/patch-${NUM}.diff" 2>/dev/null && EXTRACTED=1
fi
if [ "${EXTRACTED}" != "1" ] || [ ! -s "/tmp/patch-${NUM}.diff" ]; then
  update_status "failed" "Could not retrieve patch artifact (pod: ${POD})."
  echo "[orch] patch artifact missing from worker logs (pod: ${POD})" >&2
  gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
  exit 0
fi

# Structured worker report: embedded in the run comment so the verification
# story survives the pod.
REPORT_JSON=""
if grep -q "REPORT_B64_BEGIN" "${POD_LOGS}"; then
  REPORT_JSON=$(sed -n '/---REPORT_B64_BEGIN---/,/---REPORT_B64_END---/p' "${POD_LOGS}" \
    | grep -v -- "---REPORT" | tr -d '\n\r ' | base64 -d 2>/dev/null | redact || true)
fi
# Worker model id for the run marker and PR body (empty if unreported).
WORKER_MODEL=$(printf '%s' "${REPORT_JSON}" | jq -r '.model // ""' 2>/dev/null || echo "")
export WORKER_MODEL
REPORT_BLOCK=""
if [ -n "${REPORT_JSON}" ]; then
  REPORT_BLOCK=$(printf '<details><summary>worker report</summary>\n\n```json\n%s\n```\n\n</details>' "${REPORT_JSON}")
fi

# ---- 6. publish -------------------------------------------------------------
update_status "publishing" "_Applying patch and opening draft PR..._"

PUBLISH_DIR="/tmp/publish-${NUM}"
rm -rf "${PUBLISH_DIR}"; mkdir -p "${PUBLISH_DIR}"; cd "${PUBLISH_DIR}"
# FACTORY_PUBLISH_REMOTE lets the offline tests publish to a local repository.
AUTH_CLONE="${FACTORY_PUBLISH_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git}"
gitt clone -q "${AUTH_CLONE}" .
echo "[orch] publish: cloned ${REPO} @ $(git rev-parse --short HEAD)"
git config user.name "factory-bot"; git config user.email "factory@homelab.local"
git checkout -qb "${BRANCH}"
if gitt apply --whitespace=nowarn "/tmp/patch-${NUM}.diff" 2>/tmp/apply-err; then
  git add -A
  echo "[orch] publish: patch applied ($(git diff --cached --stat | tail -1))"
  # pull_request CI runs the workflow from the PR head and the reviewer merges
  # on green, so a factory PR must never change what admits or merges it.
  PROTECTED=$(git diff --cached --name-only --no-renames | factory_protected_paths)
  if [ -n "${PROTECTED}" ]; then
    update_status "not published" "This patch changes paths that gate admission or merge, which a factory PR may not touch; a human has to make this change:

\`\`\`
${PROTECTED}
\`\`\`

${REPORT_BLOCK}"
    park_for_human "${LABEL_WIP}"
    echo "[orch] issue #${NUM}: patch touches protected paths, not published: $(printf '%s' "${PROTECTED}" | tr '\n' ' ')"
    exit 0
  fi
  # shellcheck disable=SC3057 # ${WORKER_MODEL:+...} spans a newline; not indexing
  git commit -qm "factory: resolve #${NUM}

Produced by homelab software factory (${PROFILE} profile).${WORKER_MODEL:+
Model: ${WORKER_MODEL}}
Refs #${NUM}"
  echo "[orch] publish: pushing branch ${BRANCH}..."
  # A prior tick may have pushed this factory-owned branch and died; overwrite
  # it. A fresh clone has no tracking ref, so the lease must name the remote
  # SHA explicitly; a lost race fails into the labeled path below.
  REMOTE_SHA=$(gitt ls-remote "${AUTH_CLONE}" "refs/heads/${BRANCH}" 2>/dev/null | cut -f1)
  if [ -n "$REMOTE_SHA" ]; then
    PUSH_LEASE="--force-with-lease=${BRANCH}:${REMOTE_SHA}"
  else
    PUSH_LEASE=""
  fi
  # shellcheck disable=SC2086  # word-splitting is intended: PUSH_LEASE is zero or one flag
  if ! PUSH_ERR=$(gitt push -q ${PUSH_LEASE} "${AUTH_CLONE}" "${BRANCH}" 2>&1); then
    update_status "failed" "Branch push failed:

\`\`\`
$(printf '%s' "$PUSH_ERR" | head -5)
\`\`\`"
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
  else
  echo "[orch] publish: branch pushed; opening draft PR..."
  PR_URL=$(gh pr create -R "${REPO}" --draft --head "${BRANCH}" --base main \
    --title "${TITLE}" --body "## Factory Run — ${PROFILE}

Closes #${NUM}

> ⚠️ **Automated draft PR** produced by the homelab software factory.
> Requires CI green — the factory merges green runs automatically; human review welcome anytime.

**Verification:** see status comment on the linked issue.")
  update_status "published" "Draft PR: ${PR_URL}

${REPORT_BLOCK}

_Comment edited by factory; CI will run on the draft branch._"
  gh issue edit "${NUM}" -R "${REPO}" \
      --remove-label "${LABEL_WIP}" --add-label "${LABEL_DONE}" >/dev/null
  gh issue comment "${NUM}" -R "${REPO}" --body "🏭 Draft PR ready: ${PR_URL}" >/dev/null
  echo "[orch] published ${PR_URL}"
  fi
else
  ERR=$(cat /tmp/apply-err | head -10)
  update_status "failed" "Patch failed to apply to current base:

\`\`\`
${ERR}
\`\`\`"
  gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
fi
exit 0
