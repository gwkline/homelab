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
#   5. Publish: apply patch → push branch → approval gate → draft PR
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

REPO="${FACTORY_REPO:?FACTORY_REPO required (owner/name)}"
# Repo allowlist (mirrors the panel's /api/factory/run allowlist).
WHITELIST="${FACTORY_REPOS:-gwkline/homelab,gwkline/launchpad,gwkline/plantry,gwkline/personal-site,gwkline/kline-services-bot,gwkline/discord-bot,gwkline/pr-czar}"
case ",${WHITELIST}," in
  *",${REPO},"*) ;;
  *) echo "[orch] repo ${REPO} not whitelisted for factory runs" >&2; exit 78 ;;
esac
LABEL_QUEUED="factory/queued"
LABEL_WIP="factory/in-progress"
LABEL_DONE="factory/draft-pr"
LABEL_FAILED="factory/failed"
PROFILE="${FACTORY_PROFILE:-${PROFILE:-code-pr}}"
# Workflow identity recorded on the run (marker comment + worker brief):
# profile@version pins which orchestrator behavior stack produced the Run.
WORKFLOW_VERSION="${FACTORY_WORKFLOW_VERSION:-v1}"
# An in-progress issue with no draft PR older than this is reclaimed to queued.
STALE_HOURS="${FACTORY_STALE_HOURS:-2}"

# Hard timeouts: a hung connection must fail the step, not burn the tick's
# activeDeadline.
gh() { timeout 60 /usr/local/bin/gh "$@"; }
kubectl() { timeout 120 /usr/local/bin/kubectl "$@"; }
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

# Durable approval gates: policy table, record I/O, publish gate, resume.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "${SCRIPT_DIR}/approval.sh"
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

# DNS/netpol warm-up can fail the first auth probe; retry briefly.
AUTH_OK=0
for _a in 1 2 3 4 5 6; do
  if timeout 10 gh auth status >/dev/null 2>&1; then AUTH_OK=1; break; fi
  sleep 3
done
[ "${AUTH_OK}" = "1" ] || { echo "[orch] no gh auth" >&2; exit 1; }

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
  MARK_TS=$(gh api "repos/${REPO}/issues/${LNUM}/comments?per_page=100" --jq '[.[] | select(.body | contains("<!-- factory:run:"))] | last | .body // ""' 2>/dev/null \
    | sed -n 's/.*factory:run:[0-9]*:\([0-9T:Z-]*\).*/\1/p' || true)
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

# ---- 0b. resolve durable approval gates -----------------------------------
# Issues on factory/pending-approval carry their approval record on the issue,
# so any tick resolves a decision a human made in the panel.
approval_resume "${REPO}" || true

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

# ---- 2. resolve profile stack (image/SA/resources) ------------------------
case "${PROFILE}" in
  security)
    PROFILE_CM="factory-profile-security"
    WORKER_SA="factory-security"
    WORKER_CPU="500m"; WORKER_MEM="4Gi"
    ;;
  code-pr|*)
    PROFILE_CM="factory-profile-code-pr"
    WORKER_SA="factory-worker"
    WORKER_CPU="500m"; WORKER_MEM="12Gi"
    ;;
esac

# Worker image comes from the profile ConfigMap; WORKER_IMAGE_OVERRIDE wins
# (tests, manual dispatches). An unresolvable image parks the issue.
if [ -n "${WORKER_IMAGE_OVERRIDE:-}" ]; then
  WORKER_IMAGE="${WORKER_IMAGE_OVERRIDE}"
else
  WORKER_IMAGE=$(kubectl get configmap "${PROFILE_CM}" -n sandbox -o jsonpath='{.data.profile\.json}' 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['image'])") || WORKER_IMAGE=""
fi
case "${WORKER_IMAGE:-}" in
  ghcr.io/*) ;;
  *)
    echo "[orch] FATAL: cannot resolve worker image from configmap ${PROFILE_CM} (RBAC? profile not applied?)" >&2
    update_status "failed" "Orchestrator could not resolve the worker image from configmap \`${PROFILE_CM}\` — check RBAC and that the profile is applied."
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
    exit 1
    ;;
esac

# ---- 3. swap labels + post marker comment --------------------------------
gh issue edit "${NUM}" -R "${REPO}" \
    --remove-label "${LABEL_QUEUED}" --add-label "${LABEL_WIP}" >/dev/null
COMMENT_URL=$(gh issue comment "${NUM}" -R "${REPO}" --body "$(factory_marker_body running "_Worker dispatched — this comment updates live._")")
echo "[orch] marker comment: ${COMMENT_URL}"

MARKER_ID=${COMMENT_URL##*issuecomment-}

# ---- 3. spawn the worker Job ---------------------------------------------
JOB_NAME="factory-issue-${NUM}-$(date +%s)"
gh issue view "${NUM}" -R "${REPO}" --json number,title,body,url > /tmp/issue.json

# Per-repo verify command: the worker's stop condition. Pipe-free on purpose:
# dash reports a pipeline's last exit status, so `cmd | tail` always passes.
# Keep in sync with apps/factory/medic/run-medic.sh.
VERIFY_CMD=""
case "${REPO}" in
  *launchpad*)    VERIFY_CMD="cargo check --workspace --all-targets" ;;
  *plantry*|*personal-site*|*pr-czar*|*kline-services-bot*|*discord-bot*) VERIFY_CMD="npm run build" ;;
  # Syntax-check every changed .sh (shellcheck when present, else dash -n).
  *homelab*)      VERIFY_CMD="for f in \$(git diff --name-only HEAD -- '*.sh'); do shellcheck -s sh \"\$f\" 2>/dev/null || dash -n \"\$f\" || exit 1; done; echo verify-ok" ;;
esac

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

# Single-shot creation via generated manifest (kubectl create job has no
# --env/--labels flags; a here-doc manifest needs no patch verbs).
kubectl apply -f - << EOF2
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: sandbox
  labels:
    factory.gwkline.io/issue: "${NUM}"
    factory.gwkline.io/profile: ${PROFILE}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 3600
  # 24h: worker Jobs GCd automatically; live ledger is GitHub labels, not Jobs.
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        factory.gwkline.io/profile: ${PROFILE}
    spec:
      restartPolicy: Never
      serviceAccountName: ${WORKER_SA}
      automountServiceAccountToken: false
      containers:
        - name: worker
          image: ${WORKER_IMAGE}
          imagePullPolicy: Always
          env:
            - { name: FACTORY_REPO,  value: "${REPO}" }
            - { name: FACTORY_ISSUE, value: "${NUM}" }
            - { name: FACTORY_PROFILE, value: "${PROFILE}" }
            # The worker builds its clone URL from GH_TOKEN, so the token never
            # appears in the Job spec (ADR D6).
            - name: GH_TOKEN
              valueFrom:
                secretKeyRef: { name: github-token, key: token }
            - { name: WORKER_CMD,    value: "${WORKER_CMD:-claude --dangerously-skip-permissions}" }
            - name: OPENCODE_AUTH_B64
              value: '${OPENCODE_AUTH_B64:-}'   # shell substitutes; single-quote keeps yaml safe
            - name: FACTORY_BRIEF_B64
              value: '${BRIEF_B64}'            # shell substitutes
            - { name: FACTORY_SECURITY_MODE, value: "per-issue" }
          resources:
            requests: { cpu: ${WORKER_CPU}, memory: 512Mi }
            limits:   { cpu: "2",   memory: ${WORKER_MEM} }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
EOF2
echo "[orch] job ${JOB_NAME} created"

update_status "running" "_Job \`${JOB_NAME}\` running._

<details><summary>knowledge context</summary>

${KNOWLEDGE_BLOCK}

</details>"

# ---- 4. wait for completion -----------------------------------------------
# Poll instead of `kubectl wait`, whose exit status dash + set -e can swallow.
# 340 x 10s = the 3600s worker budget minus image pull/startup.
WAIT_OK=0
for _i in $(seq 1 340); do
  PHASE=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "")
  if [ "${PHASE}" = "True" ]; then WAIT_OK=1; break; fi
  FAILED=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || echo "")
  if [ "${FAILED}" = "True" ]; then break; fi
  sleep 10
done
if [ "${WAIT_OK}" != "1" ]; then
  LOGTAIL=$(kubectl logs "job/${JOB_NAME}" -n sandbox --tail=40 2>/dev/null | redact || true)
  # Bounded auto-retry: one extra attempt for transient failures (flaky
  # provider, netpol blip). 2 run markers max, then park in failed for a human.
  ATTEMPTS=$(gh api "repos/${REPO}/issues/${NUM}/comments?per_page=100" --jq '[.[] | select(.body | contains("<!-- factory:run:"))] | length' 2>/dev/null || echo 2)
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
kubectl logs -n sandbox "${POD}" > "${POD_LOGS}" 2>/dev/null || true
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
AUTH_CLONE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
gitt clone -q "${AUTH_CLONE}" .
echo "[orch] publish: cloned ${REPO} @ $(git rev-parse --short HEAD)"
git config user.name "factory-bot"; git config user.email "factory@homelab.local"
git checkout -qb "${BRANCH}"
if gitt apply --whitespace=nowarn "/tmp/patch-${NUM}.diff" 2>/tmp/apply-err; then
  echo "[orch] publish: patch applied ($(git diff --cached --stat | tail -1))"
  git add -A && git commit -qm "factory: resolve #${NUM}

Produced by homelab software factory (${PROFILE} profile).${WORKER_MODEL:+
Model: ${WORKER_MODEL}}
Refs #${NUM}"
  # Push the branch before the gate: the approval binds to its head SHA, and
  # opening the PR is the gated transition.
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
  echo "[orch] publish: branch pushed"
  HEAD_SHA=$(git rev-parse HEAD)
  echo "[orch] publish: approval gate..."
  GATE=$(approval_gate_publish "${REPO}" "${NUM}" "${PROFILE}" "${BRANCH}" "main" "/tmp/patch-${NUM}.diff" "${HEAD_SHA}") || true
  echo "[orch] publish: gate verdict: ${GATE}"
  case "${GATE}" in
    proceed)
      echo "[orch] publish: opening draft PR..."
      PR_URL=$(approval_open_pr "${REPO}" "${NUM}" "${PROFILE}" "${BRANCH}" "main")
      approval_mark_executed "${REPO}" "${NUM}" publish "${PR_URL}" || true
      update_status "published" "Draft PR: ${PR_URL}

${REPORT_BLOCK}

_Comment edited by factory; CI will run on the draft branch._"
      gh issue edit "${NUM}" -R "${REPO}" \
          --remove-label "${LABEL_WIP}" --add-label "${LABEL_DONE}" >/dev/null
      gh issue comment "${NUM}" -R "${REPO}" --body "🏭 Draft PR ready: ${PR_URL}" >/dev/null
      echo "[orch] published ${PR_URL}"
      ;;
    awaiting)
      update_status "awaiting approval" "_Publish paused — a durable approval request was recorded on this issue (digest \`${HEAD_SHA}\`). Approve or deny in the panel; the next tick resumes automatically._"
      gh issue edit "${NUM}" -R "${REPO}" \
          --remove-label "${LABEL_WIP}" --add-label "${APPROVAL_LABEL}" >/dev/null
      echo "[orch] issue #${NUM}: publish gated — awaiting approval (digest ${HEAD_SHA})"
      ;;
    *)
      update_status "failed" "Publish ${GATE} — see the approval record comment on this issue."
      gh issue edit "${NUM}" -R "${REPO}" \
          --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
      echo "[orch] issue #${NUM}: publish ${GATE} — parked in ${LABEL_FAILED}"
      ;;
  esac
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
