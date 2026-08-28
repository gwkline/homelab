#!/usr/bin/env bash
# Cluster smoke suite: negative + positive egress connectivity checks (#93).
#
# Creates a one-shot Job in `sandbox` (with the same dind sidecar as real
# loop pods) that:
#   1. clones gwkline/homelab            -> "ordinary clone works" (positive)
#   2. runs examples/egress-smoke.mjs    -> pod-level matrix (DNS/GitHub/
#                                           registries/model API open;
#                                           k8s API, kubelet, metadata,
#                                           tailnet, panel, LAN closed)
#   3. pulls node:24-slim and runs the same matrix INSIDE a dind
#      inner container                  -> docker0 traffic is tested, not
#                                           assumed to inherit pod policy
#
# Usage:
#   ./scripts/egress-smoke.sh                 # run, stream verdict, exit non-zero on failure
#   EGRESS_SMOKE_INNER_IMAGE=node:24-slim ./scripts/egress-smoke.sh
#   EGRESS_SMOKE_LAN_TARGET=192.168.0.23 ./scripts/egress-smoke.sh
#
# Requirements: kubectl context with sandbox access; deploy/policies/base
# applied. Expects secret `github-token` if gwkline/homelab is private.
set -euo pipefail

NAME="egress-smoke"
NS="sandbox"
INNER_IMAGE="${EGRESS_SMOKE_INNER_IMAGE:-node:24-slim}"
LAN_TARGET="${EGRESS_SMOKE_LAN_TARGET:-192.168.1.1}"

command -v kubectl >/dev/null || { echo "kubectl not found" >&2; exit 2; }

kubectl delete job "$NAME" -n "$NS" --ignore-not-found >/dev/null

MANIFEST=$(cat <<EOF
# Smoke-only Job: mirrors the loop-example pod shape (loop + privileged dind
# sidecar, pod-scoped socket). Label app: egress-smoke has no factory profile
# label, so the sandbox egress allowlist applies to it — that is the policy
# under test. dind gets the data volume mounted so dockerd can bind-mount the
# cloned repo into inner containers.
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
  activeDeadlineSeconds: 900
  template:
    metadata:
      labels:
        app: egress-smoke
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      terminationGracePeriodSeconds: 60
      securityContext:
        seccompProfile:
          type: RuntimeDefault
      initContainers:
        - name: docker-ready
          image: docker:27-cli
          command:
            - sh
            - -c
            - |
              i=0
              while [ "\$i" -lt 30 ]; do
                docker info >/dev/null 2>&1 && break
                i=\$((i+1)); sleep 2
              done
              docker info >/dev/null 2>&1 || { echo "dind not ready after 60s" >&2; exit 1; }
              chmod 666 /var/run/docker.sock
          volumeMounts:
            - name: sock
              mountPath: /var/run
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
            - name: HOME
              value: /tmp
            - name: DOCKER_HOST
              value: unix:///var/run/docker.sock
            - name: EGRESS_SMOKE_LAN_TARGET
              value: "${LAN_TARGET}"
            - name: EGRESS_SMOKE_INNER_IMAGE
              value: "${INNER_IMAGE}"
            - name: LOOP_COMMAND
              value: |
                test -f /data/repos/homelab/examples/egress-smoke.mjs \
                  || { echo "SMOKE FAIL: repo clone failed (positive egress test)" >&2; exit 1; }
                node /data/repos/homelab/examples/egress-smoke.mjs --phase pod \
                  || { echo "SMOKE FAIL: pod-level egress matrix" >&2; exit 1; }
                echo "[smoke] pulling \${EGRESS_SMOKE_INNER_IMAGE} via dind (registry egress test)"
                docker pull "\${EGRESS_SMOKE_INNER_IMAGE}" \
                  || { echo "SMOKE FAIL: dind image pull" >&2; exit 1; }
                docker run --rm --network bridge \
                  -v /data/repos:/repos:ro \
                  -e EGRESS_SMOKE_LAN_TARGET="\${EGRESS_SMOKE_LAN_TARGET}" \
                  "\${EGRESS_SMOKE_INNER_IMAGE}" \
                  node /repos/homelab/examples/egress-smoke.mjs --phase dind \
                  || { echo "SMOKE FAIL: dind inner-container egress matrix" >&2; exit 1; }
                echo "[smoke] egress smoke: all phases passed"
          volumeMounts:
            - name: data
              mountPath: /data
            - name: github-token
              mountPath: /secrets
              readOnly: true
            - name: sock
              mountPath: /var/run
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: "1",  memory: 1Gi }
        - name: dind
          image: docker:27-dind
          command: ["dockerd", "--host=unix:///var/run/docker.sock"]
          securityContext:
            privileged: true # same grant as every sandbox loop pod
          env:
            - name: DOCKER_TLS_CERTDIR
              value: ""
          volumeMounts:
            - name: sock
              mountPath: /var/run
            - name: dind-storage
              mountPath: /var/lib/docker
            - name: data # lets dockerd bind-mount the repo into inner containers
              mountPath: /data
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { memory: 2Gi }
      volumes:
        - name: sock
          emptyDir: {}
        - name: dind-storage
          emptyDir:
            sizeLimit: 5Gi
        - name: data
          emptyDir:
            sizeLimit: 1Gi
        - name: github-token
          secret:
            secretName: github-token
            optional: true
EOF
)

echo "==> applying smoke job ${NAME} to ${NS}"
printf '%s\n' "$MANIFEST" | kubectl apply -f -

echo "==> waiting for job (up to 15m)..."
if kubectl wait --for=condition=complete "job/${NAME}" -n "$NS" --timeout=900s >/dev/null 2>&1; then
  STATUS=pass
else
  STATUS=fail
fi

echo "==> logs (job/${NAME})"
kubectl logs "job/${NAME}" -n "$NS" -c loop --tail=-1 || true

if [[ "$STATUS" == "pass" ]]; then
  echo "==> PASS: egress smoke matched expectations (pod + dind inner container)"
else
  echo "==> FAIL: job did not complete successfully — see logs above" >&2
  kubectl describe job "$NAME" -n "$NS" | tail -n 20 >&2 || true
  exit 1
fi