#!/bin/sh
# Launch a one-off Job in `sandbox` without hand-writing YAML. The repo is
# cloned and the command runs inside it, so `npm test` means the repo's tests.
#
# Usage:
#   ./new-job.sh [--print] [--repo <owner/name>] <name> '<command>'
#
# Examples:
#   ./new-job.sh smoke-test 'echo hello'
#   ./new-job.sh --repo gwkline/launchpad pr-check 'git log --oneline -5'
#   ./new-job.sh build 'npm ci
#   npm test'
#
# --print writes the manifest to stdout instead of applying.
# --repo  clones that GitHub repo instead of gwkline/homelab.
#
# Jobs run the ops image (images/ops): sh, git, curl, jq, node and npm. There
# is no compiler, browser or Docker.
# Follow logs with:
#   kubectl logs job/<name> -n sandbox -f
set -eu

usage() {
  echo "usage: $0 [--print] [--repo <owner/name>] <name> '<command>'" >&2
  exit 2
}

PRINT=0
REPO=gwkline/homelab
while [ $# -gt 0 ]; do
  case "$1" in
    --print) PRINT=1; shift ;;
    --repo) [ $# -ge 2 ] || usage; REPO=$2; shift 2 ;;
    --) shift; break ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 2 ] || usage
NAME=$1
shift
COMMAND=$*
case "$REPO" in
  */*) ;;
  *) usage ;;
esac
REPO_DIR="/data/repos/${REPO#*/}"

# The command, prefixed with a cd into the clone, as one YAML double-quoted
# scalar: backslashes, quotes, tabs and newlines escaped, so a command of any
# shape (several lines, quotes, colons) stays one valid value.
yaml_quote() {
  printf '%s' "$1" | awk '
    { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t") }
    { printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
}
JOB_COMMAND=$(yaml_quote "cd ${REPO_DIR} || exit 1
${COMMAND}")

MANIFEST=$(cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${NAME}
  namespace: sandbox
  labels:
    app.kubernetes.io/part-of: homelab
    app: new-job
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app: new-job
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      terminationGracePeriodSeconds: 120
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: job
          image: ghcr.io/gwkline/homelab/ops:latest
          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
          env:
            - name: GITHUB_TOKEN_FILE
              value: /secrets/token
            - name: WORKSPACE_REPOS
              value: https://github.com/${REPO}.git
            - name: JOB_COMMAND
              value: "${JOB_COMMAND}"
            - name: HOME
              value: /tmp
          volumeMounts:
            - name: data
              mountPath: /data
            - name: github-token
              mountPath: /secrets
              readOnly: true
          resources:
            requests:
              cpu: "500m"
              memory: 1Gi
            limits:
              memory: 4Gi
      volumes:
        - name: data
          emptyDir:
            sizeLimit: 5Gi
        - name: github-token
          secret:
            secretName: github-token
            optional: true
EOF
)

if [ "$PRINT" = 1 ]; then
  printf '%s\n' "$MANIFEST"
else
  printf '%s\n' "$MANIFEST" | kubectl apply -f -
  echo "==> job '${NAME}' created. logs: kubectl logs job/${NAME} -n sandbox -f"
fi
