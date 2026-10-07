#!/usr/bin/env bash
# Proves the sandbox egress policy from a real sandbox pod: clones this repo
# (positive), then runs examples/egress-smoke.mjs — DNS/GitHub/registries/
# model API open; Kubernetes API, kubelet, metadata, tailnet, panel and LAN
# closed.
#
# Usage: ./scripts/egress-smoke.sh   (EGRESS_SMOKE_LAN_TARGET=<ip> to override)
set -euo pipefail

NAME="egress-smoke"
NS="sandbox"
LAN_TARGET="${EGRESS_SMOKE_LAN_TARGET:-192.168.1.1}"

kubectl delete job "$NAME" -n "$NS" --ignore-not-found >/dev/null

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${NAME}
  namespace: ${NS}
  labels:
    app.kubernetes.io/part-of: homelab
    app: egress-smoke
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  activeDeadlineSeconds: 600
  template:
    metadata:
      labels:
        app: egress-smoke
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: loop
          image: ghcr.io/gwkline/homelab/loop-agent:latest
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
              value: https://github.com/gwkline/homelab.git
            - name: HOME
              value: /tmp
            - name: EGRESS_SMOKE_LAN_TARGET
              value: "${LAN_TARGET}"
            - name: LOOP_COMMAND
              value: |
                test -f /data/repos/homelab/examples/egress-smoke.mjs \
                  || { echo "SMOKE FAIL: repo clone failed" >&2; exit 1; }
                node /data/repos/homelab/examples/egress-smoke.mjs
          volumeMounts:
            - name: data
              mountPath: /data
            - name: github-token
              mountPath: /secrets
              readOnly: true
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { cpu: "1", memory: 1Gi }
      volumes:
        - name: data
          emptyDir:
            sizeLimit: 1Gi
        - name: github-token
          secret:
            secretName: github-token
            optional: true
EOF

status=pass
kubectl wait --for=condition=complete "job/${NAME}" -n "$NS" --timeout=600s >/dev/null 2>&1 || status=fail
kubectl logs "job/${NAME}" -n "$NS" --tail=-1 || true
if [[ "$status" == fail ]]; then
  kubectl describe job "$NAME" -n "$NS" | tail -n 20 >&2 || true
  exit 1
fi
