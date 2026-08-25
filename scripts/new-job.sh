#!/usr/bin/env bash
# Launch a one-off loop job in `sandbox` without hand-writing YAML.
#
# Usage:
#   ./new-job.sh [--print] <name> '<command>'
#
# Examples:
#   ./new-job.sh smoke-test 'node /data/repos/homelab/examples/loop-hello.mjs'
#   ./new-job.sh pr-check 'git -C /data/repos/launchpad log --oneline -5'
#
# --print writes the manifest to stdout instead of applying.
#
# No dind sidecar: ad-hoc jobs get Chromium and node but not nested Docker.
# Follow logs with:
#   kubectl logs job/<name> -n sandbox -f
set -euo pipefail

PRINT=0
if [[ "${1:-}" == "--print" ]]; then PRINT=1; shift; fi

NAME="${1:?usage: $0 [--print] <name> '<command>'}"
shift
COMMAND="${*:?usage: $0 [--print] <name> '<command>'}"

MANIFEST=$(cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${NAME}
  namespace: sandbox
  labels:
    app.kubernetes.io/part-of: homelab
    app: loop-agent
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        app: loop-agent
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      terminationGracePeriodSeconds: 120
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: loop
          image: ghcr.io/gwkline/homelab/loop-agent
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
              value: |
                https://github.com/gwkline/homelab.git
            - name: LOOP_COMMAND
              value: |
                ${COMMAND}
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

if [[ "$PRINT" == 1 ]]; then
  printf '%s\n' "$MANIFEST"
else
  printf '%s\n' "$MANIFEST" | kubectl apply -f -
  echo "==> job '${NAME}' created. logs: kubectl logs job/${NAME} -n sandbox -f"
fi
