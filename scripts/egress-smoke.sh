#!/bin/sh
# Proves the egress policy from real pods in sandbox and work: each Job clones
# this repo (positive), then runs this working tree's examples/egress-smoke.mjs
# (DNS/GitHub/registries/model API open; Kubernetes API, kubelet, metadata,
# tailnet, panel and LAN closed). Fails as soon as either Job fails.
#
# Usage: ./scripts/egress-smoke.sh
#   EGRESS_SMOKE_LAN_TARGET=<ip> EGRESS_SMOKE_LAN_PORT=<port> override the LAN
#   probe, which defaults to the API server on the node's LAN address: a port
#   that is always listening, so only the policy can make it unreachable.
set -eu

cd "$(dirname "$0")/.." || exit 1

NAME=egress-smoke
NAMESPACES="sandbox work"
# Jobs normally finish in under a minute; the deadline bounds a hung probe.
DEADLINE=120

LAN_TARGET="${EGRESS_SMOKE_LAN_TARGET:-$(kubectl get nodes \
  -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')}"
LAN_PORT="${EGRESS_SMOKE_LAN_PORT:-6443}"
[ -n "$LAN_TARGET" ] || {
  echo "FAIL: no node InternalIP; set EGRESS_SMOKE_LAN_TARGET" >&2
  exit 1
}

cleanup() {
  for ns in $NAMESPACES; do
    kubectl delete configmap "$NAME" -n "$ns" --ignore-not-found >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT INT TERM

for ns in $NAMESPACES; do
  kubectl delete job "$NAME" -n "$ns" --ignore-not-found --cascade=foreground --wait=true >/dev/null
  kubectl create configmap "$NAME" -n "$ns" --from-file=egress-smoke.mjs=examples/egress-smoke.mjs \
    --dry-run=client -o yaml | kubectl apply --server-side --field-manager=egress-smoke -f - >/dev/null
  kubectl apply -f - >/dev/null <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${NAME}
  namespace: ${ns}
  labels:
    app.kubernetes.io/part-of: homelab
    app: egress-smoke
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  activeDeadlineSeconds: ${DEADLINE}
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
        - name: smoke
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
              value: https://github.com/gwkline/homelab.git
            - name: HOME
              value: /tmp
            - name: EGRESS_SMOKE_LAN_TARGET
              value: "${LAN_TARGET}"
            - name: EGRESS_SMOKE_LAN_PORT
              value: "${LAN_PORT}"
            - name: JOB_COMMAND
              value: |
                test -d /data/repos/homelab/.git \\
                  || { echo "SMOKE FAIL: repo clone failed" >&2; exit 1; }
                node /smoke/egress-smoke.mjs
          volumeMounts:
            - name: data
              mountPath: /data
            - name: smoke
              mountPath: /smoke
              readOnly: true
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
        - name: smoke
          configMap:
            name: ${NAME}
        - name: github-token
          secret:
            secretName: github-token
            optional: true
EOF
  echo "==> started job/${NAME} in ${ns} (LAN probe ${LAN_TARGET}:${LAN_PORT})"
done

# state <ns>: Complete, Failed, or Running. A pod stuck before it can start
# (image pull, config error) counts as Failed rather than waiting it out.
state() {
  conds=$(kubectl get job "$NAME" -n "$1" \
    -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}' 2>/dev/null) || conds=''
  case " $conds" in
    *" Complete "* | *" SuccessCriteriaMet "*) echo Complete; return ;;
    *" Failed "* | *" FailureTarget "*) echo Failed; return ;;
  esac
  waiting=$(kubectl get pods -n "$1" -l "batch.kubernetes.io/job-name=${NAME}" \
    -o jsonpath='{.items[*].status.containerStatuses[*].state.waiting.reason}' 2>/dev/null) || waiting=''
  case "$waiting" in
    *ErrImagePull* | *ImagePullBackOff* | *CreateContainerConfigError* | *InvalidImageName*) echo Failed ;;
    *) echo Running ;;
  esac
}

failed=''
pending="$NAMESPACES"
start=$(date +%s)
while [ -n "$pending" ]; do
  still=''
  for ns in $pending; do
    case "$(state "$ns")" in
      Complete) echo "==> ${ns}: passed" ;;
      Failed)
        echo "==> ${ns}: FAILED" >&2
        failed="$failed $ns"
        ;;
      *) still="$still $ns" ;;
    esac
  done
  pending=$still
  [ -n "$failed" ] && break
  if [ -n "$pending" ] && [ $(($(date +%s) - start)) -gt $((DEADLINE + 15)) ]; then
    echo "==> timed out waiting for:$pending" >&2
    failed="$failed $pending"
    break
  fi
  [ -z "$pending" ] || sleep 2
done

for ns in $NAMESPACES; do
  echo "----- ${ns} -----"
  kubectl logs "job/${NAME}" -n "$ns" --tail=-1 2>/dev/null || true
done
if [ -n "$failed" ]; then
  for ns in $failed; do
    kubectl describe job "$NAME" -n "$ns" | tail -n 20 >&2 || true
  done
  exit 1
fi
echo "PASS: egress policy holds in: $NAMESPACES"
