#!/bin/sh
# Factory orchestrator (#78, ADR-002 GitHub-as-ledger).
# Runs as a single-instance CronJob (concurrency: Forbid).
#
# One tick:
#   1. Find issues labeled factory/queued in configured repos
#   2. Swap label to factory/in-progress + post run marker comment
#   3. Spawn a worker Job from profile-code-pr
#   4. Watch it to completion; collect /out artifacts
#   5. Hand patch to publisher logic (same script, phase 2: publish)
#   6. Update labels + status comment through the whole lifecycle
set -eu

REPO="${FACTORY_REPO:?FACTORY_REPO required (owner/name)}"
# Operator whitelist: FACTORY_REPOS env (comma-separated) or built-in defaults.
# Panel /api/factory/run keeps the canonical allowlist; this guards the CronJob.
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
# harness-agnostic: code-pr uses opencode/LLM, security uses local scanners (no OPENCODE_AUTH_B64 needed)
WORKDIR="${HOME}/runs"

gh auth status >/dev/null 2>&1 || { echo "[orch] no gh auth" >&2; exit 1; }

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---- 1. find queued issues -------------------------------------------------
# Panel manual trigger can pin a single issue via FACTORY_ISSUE env (avoids GH label propagation race).
if [ -n "${FACTORY_ISSUE:-}" ]; then
  NUM_Q="${FACTORY_ISSUE}"
  # Verify the issue is still open and has the queued label (or was just labeled by panel)
  if gh api "repos/${REPO}/issues/${NUM_Q}" --jq '.labels[].name' 2>/dev/null | grep -qx "${LABEL_QUEUED}"; then
    TITLE=$(gh api "repos/${REPO}/issues/${NUM_Q}" --jq '.title' 2>/dev/null || echo "issue #${NUM_Q}")
    QUEUED="${NUM_Q}	${TITLE}"
    echo "[orch] pinned FACTORY_ISSUE=${NUM_Q}: ${TITLE}" >&2
  else
    echo "[orch] FACTORY_ISSUE=${NUM_Q} has no ${LABEL_QUEUED} label — falling back to queue poll" >&2
    QUEUED=$(gh api "repos/${REPO}/issues?labels=${LABEL_QUEUED}&state=open&per_page=5" \
      --jq '.[] | "\(.number)\t\(.title)"')
    [ -n "${QUEUED}" ] || { echo "[orch] $(timestamp) nothing queued"; exit 0; }
  fi
else
  QUEUED=$(gh api "repos/${REPO}/issues?labels=${LABEL_QUEUED}&state=open&per_page=5" \
    --jq '.[] | "\(.number)\t\(.title)"')
  [ -n "${QUEUED}" ] || { echo "[orch] $(timestamp) nothing queued"; exit 0; }
fi

echo "${QUEUED}" | while IFS="$(printf '\t')" read -r NUM TITLE; do
  echo "[orch] $(timestamp) picked issue #${NUM}: ${TITLE}"
  BRANCH="factory/issue-${NUM}/${PROFILE}"
  RUN_TS=$(timestamp)

  # ---- idempotency: skip if a PR already exists for this issue+profile ----
  EXISTING=$(gh pr list -R "${REPO}" --head "${BRANCH}" --state all --json number \
             --jq 'length')
  if [ "${EXISTING}" != "0" ]; then
    echo "[orch] branch ${BRANCH} already has PR — skipping duplicate"
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_QUEUED}" >/dev/null
    continue
  fi

  # ---- 2. swap labels + post marker comment ------------------------------
  gh issue edit "${NUM}" -R "${REPO}" \
      --remove-label "${LABEL_QUEUED}" --add-label "${LABEL_WIP}" >/dev/null
  COMMENT_URL=$(gh issue comment "${NUM}" -R "${REPO}" --body "$(cat <<EOF
<!-- factory:run:${NUM}:${RUN_TS} -->
## 🏭 Factory Run

| | |
|---|---|
| Status | running |
| Started | ${RUN_TS} |
| Profile | ${PROFILE} |
| Attempt | 1 |

_Worker dispatched — this comment updates live._
EOF
)")
  echo "[orch] marker comment: ${COMMENT_URL}"

  MARKER_ID=${COMMENT_URL##*issuecomment-}

  update_status() {  # $1=status, $2=extra detail markdown
    gh api -X PATCH "repos/${REPO}/issues/comments/${MARKER_ID}" \
      -F body="$(cat <<EOF
<!-- factory:run:${NUM}:${RUN_TS} -->
## 🏭 Factory Run

| | |
|---|---|
| Status | ${1} |
| Started | ${RUN_TS} |
| Updated | $(timestamp) |
| Profile | ${PROFILE} |
| Attempt | 1 |

${2:-_Worker dispatched._}
EOF
)" >/dev/null
  }

  # ---- 3. spawn the worker Job -------------------------------------------
  JOB_NAME="factory-issue-${NUM}-$(date +%s)"
  # Build the worker brief: single python step, gh output via temp file.
  gh issue view "${NUM}" -R "${REPO}" --json number,title,body,url > /tmp/issue.json
  python3 - "${REPO}" "${NUM}" << 'PYEOF' > /tmp/brief.json
import json, sys
repo, num = sys.argv[1], sys.argv[2]
d = json.load(open("/tmp/issue.json"))
print(json.dumps({
    "run_id": f"issue{num}-{num}",
    "repository": repo,
    "issue": d,
    "constraints": ["draft PR only", "minimal diff"],
    "verify_command": ""
}))
PYEOF
  BRIEF_B64=$(base64 -w0 /tmp/brief.json)

  # Resolve profile-aware image/SA/resources (harness-agnostic).
  case "${PROFILE}" in
    security)
      WORKER_IMAGE="ghcr.io/gwkline/homelab/factory/security:latest"
      WORKER_SA="factory-security"
      WORKER_CPU="500m"; WORKER_MEM="4Gi"
      ;;
    code-pr|*)
      WORKER_IMAGE="ghcr.io/gwkline/homelab/factory/worker:latest"
      WORKER_SA="factory-worker"
      WORKER_CPU="500m"; WORKER_MEM="12Gi"
      ;;
  esac

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
  backoffLimit: 1
  activeDeadlineSeconds: 1800
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
            # Worker-side expansion: heredoc injects $(GH_TOKEN) value here
            # above; orchestrator never touches the secret material.
            - name: GH_TOKEN
              valueFrom:
                secretKeyRef: { name: github-token, key: token }
            - { name: CLONE_URL,     value: "https://x-access-token:$(GH_TOKEN)@github.com/${REPO}.git" }
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

  update_status "running" "_Job \`${JOB_NAME}\` running._"

  # ---- 4. wait for completion ---------------------------------------------
  # Poll instead of `kubectl wait`: dash + set -e silently swallowed its
  # non-zero exit in some conditions, skipping the failure path entirely.
  WAIT_OK=0
  for _i in $(seq 1 90); do
    PHASE=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "")
    if [ "${PHASE}" = "True" ]; then WAIT_OK=1; break; fi
    FAILED=$(kubectl get job "${JOB_NAME}" -n sandbox -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || echo "")
    if [ "${FAILED}" = "True" ]; then break; fi
    sleep 10
  done
  if [ "${WAIT_OK}" != "1" ]; then
    LOGTAIL=$(kubectl logs "job/${JOB_NAME}" -n sandbox --tail=40 2>/dev/null || true)
    update_status "failed" "Job failed or timed out.

<details><summary>log tail</summary>

\`\`\`
${LOGTAIL}
\`\`\`
</details>"
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
    continue
  fi

  # ---- 5. extract patch from the completed pod ----------------------------
  # Worker prints base64 artifacts to logs (---PATCH_B64_BEGIN--- ... ---PATCH_B64_END---).
  # kubectl cp / kubectl exec requires Running; Job pods are terminated (Failed/Succeeded).
  # Use kubectl logs on the Succeeded pod; select deterministically, not .items[0].
  POD=$(kubectl get pods -n sandbox -l job-name="${JOB_NAME}" --field-selector status.phase=Succeeded -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -z "${POD}" ]; then
    # Fallback: no Succeeded pod yet — job may still be retrying (backoffLimit 1)
    POD=$(kubectl get pods -n sandbox -l job-name="${JOB_NAME}" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  if [ -z "${POD}" ]; then
    update_status "failed" "Could not find worker pod for job ${JOB_NAME}."
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
    continue
  fi
  # Try log-based extraction; fallback to cp for old image compat during rollout.
  EXTRACTED=0
  if kubectl logs -n sandbox "${POD}" 2>/dev/null | grep -q "PATCH_B64_BEGIN"; then
    kubectl logs -n sandbox "${POD}" 2>/dev/null \
      | sed -n '/---PATCH_B64_BEGIN---/,/---PATCH_B64_END---/p' \
      | grep -v -- "---PATCH" | tr -d '\n\r ' | base64 -d > "/tmp/patch-${NUM}.diff" 2>/dev/null && EXTRACTED=1
  fi
  if [ "${EXTRACTED}" != "1" ]; then
    kubectl cp "sandbox/${POD}:/out/patch.diff" "/tmp/patch-${NUM}.diff" >/dev/null 2>&1 && EXTRACTED=1 || true
  fi
  if [ "${EXTRACTED}" != "1" ] || [ ! -s "/tmp/patch-${NUM}.diff" ]; then
    update_status "failed" "Could not retrieve patch artifact (pod: ${POD})."
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
    continue
  fi

  # ---- 6. publish phase (publisher responsibilities, inline for v1) -------
  update_status "publishing" "_Applying patch and opening draft PR..._"

  PUBLISH_DIR="/tmp/publish-${NUM}"
  rm -rf "${PUBLISH_DIR}"; mkdir -p "${PUBLISH_DIR}"; cd "${PUBLISH_DIR}"
  git clone -q "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" .
  git config user.name "factory-bot"; git config user.email "factory@homelab.local"
  git checkout -qb "${BRANCH}"
  if git apply --whitespace=nowarn "/tmp/patch-${NUM}.diff" 2>/tmp/apply-err; then
    git add -A && git commit -qm "factory: resolve #${NUM}

Produced by homelab software factory (${PROFILE} profile).
Refs #${NUM}" 
    git push -q "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "${BRANCH}"
    PR_URL=$(gh pr create -R "${REPO}" --draft \
      --head "${BRANCH}" --base main \
      --title "$(gh issue view "${NUM}" -R "${REPO}" --json title --jq .title)" \
      --body "$(cat <<EOF
## Factory Run — ${PROFILE}

Closes #${NUM}

> ⚠️ **Automated draft PR** produced by the homelab software factory.
> Requires CI green + human review before promotion. Do not auto-merge.

**Verification:** see status comment on the linked issue.
EOF
)")
    update_status "published" "Draft PR: ${PR_URL}

_Comment edited by factory; CI will run on the draft branch._"
    gh issue edit "${NUM}" -R "${REPO}" \
        --remove-label "${LABEL_WIP}" --add-label "${LABEL_DONE}" >/dev/null
    gh issue comment "${NUM}" -R "${REPO}" --body "🏭 Draft PR ready: ${PR_URL}" >/dev/null
    echo "[orch] published ${PR_URL}"
  else
    ERR=$(cat /tmp/apply-err | head -10)
    update_status "failed" "Patch failed to apply to current base:

\`\`\`
${ERR}
\`\`\`"
    gh issue edit "${NUM}" -R "${REPO}" --remove-label "${LABEL_WIP}" --add-label "${LABEL_FAILED}" >/dev/null
  fi
  cd /
done
