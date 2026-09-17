#!/bin/sh
# Medic dispatch (#239): spawn ONE medic Job for a ci-red factory PR.
# Env: MEDIC_PR, MEDIC_BRANCH, MEDIC_HEAD, MEDIC_ATTEMPT, LINKED_ISSUE
# Reuses the code-pr worker stack (pinned image digest from the profile CM);
# the brief hard-pins the agent to the PR branch with push-there-only rules.
set -u

REPO="${FACTORY_REPO:-gwkline/homelab}"
: "${MEDIC_PR:?}" "${MEDIC_BRANCH:?}" "${MEDIC_HEAD:?}" "${MEDIC_ATTEMPT:?}"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Same pinned image as the code-pr profile — single source of truth.
WORKER_IMAGE=$(kubectl get configmap factory-profile-code-pr -n sandbox \
  -o jsonpath='{.data.profile\.json}' 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['image'])") || WORKER_IMAGE=""
case "${WORKER_IMAGE}" in
  ghcr.io/*@sha256:*) ;;
  *) echo "[medic] FATAL: cannot resolve worker image" >&2; exit 1 ;;
esac

# Failing-check context for the brief (names + first lines of summaries).
CHECKS=$(gh pr checks "${MEDIC_PR}" -R "${REPO}" 2>/dev/null | awk -F'\t' '$2=="fail"{print $1}' | head -5)
PR_TITLE=$(gh pr view "${MEDIC_PR}" -R "${REPO}" --json title --jq .title 2>/dev/null || echo "PR #${MEDIC_PR}")

python3 - "${MEDIC_PR}" "${MEDIC_BRANCH}" "${MEDIC_HEAD}" "${MEDIC_ATTEMPT}" "${PR_TITLE}" "${CHECKS}" << 'PYEOF' > /tmp/medic-brief.json
import json, sys
pr, branch, head, attempt, title, checks = *sys.argv[1:5], sys.argv[5], sys.argv[6]
checks = [c for c in checks.splitlines() if c.strip()]
brief = {
  "repo": "gwkline/homelab",
  "task": f"""You are the FACTORY MEDIC. CI is failing on PR #{pr} ({title!r}).

STRICT RULES:
- Work ONLY on branch {branch} (head {head[:7]}). Do NOT create branches or PRs.
- Do NOT push to main. Do NOT force-push.
- Push fix commit(s) to {branch} only, then stop.
- Fix the failing checks, nothing else. Smallest correct change.

Failing checks: {', '.join(checks) or 'see CI'}.
Verification: the checks that are failing must pass; do not weaken tests or CI to pass.""",
  "profile": "medic",
  "medic": {"pr": int(pr), "branch": branch, "head_sha": head, "attempt": int(attempt), "failing_checks": checks},
}
json.dump(brief, sys.stdout, indent=1)
PYEOF
BRIEF_B64=$(base64 -w0 /tmp/medic-brief.json)

JOB_NAME="factory-medic-pr${MEDIC_PR}-$(date +%s)"
kubectl apply -f - << EOF2
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: sandbox
  labels:
    factory.gwkline.io/role: medic
    factory.gwkline.io/pr: "${MEDIC_PR}"
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 1200
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        factory.gwkline.io/role: medic
    spec:
      restartPolicy: Never
      serviceAccountName: factory-worker
      automountServiceAccountToken: false
      containers:
        - name: medic
          image: ${WORKER_IMAGE}
          imagePullPolicy: Always
          env:
            - { name: FACTORY_REPO,       value: "${REPO}" }
            - { name: FACTORY_PROFILE,    value: "medic" }
            - { name: MEDIC_PR,           value: "${MEDIC_PR}" }
            - { name: MEDIC_BRANCH,       value: "${MEDIC_BRANCH}" }
            - name: GH_TOKEN
              valueFrom:
                secretKeyRef: { name: github-token, key: token }
            - name: OPENCODE_AUTH_B64
              valueFrom:
                secretKeyRef: { name: factory-opencode-auth, key: auth-b64 }
            - name: FACTORY_BRIEF_B64
              value: '${BRIEF_B64}'
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits:   { cpu: "2",   memory: 4Gi }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
EOF2
echo "[medic] job ${JOB_NAME} created for PR #${MEDIC_PR}"

# Attempt marker on the linked issue (idempotency ledger for the sweep).
if [ -n "${LINKED_ISSUE:-}" ]; then
  gh issue comment "${LINKED_ISSUE}" -R "${REPO}" \
    --body "🚑 medic:attempt:${MEDIC_ATTEMPT} for PR #${MEDIC_PR} at head ${MEDIC_HEAD:0:7} (job \`${JOB_NAME}\`)" >/dev/null 2>&1 || true
fi
