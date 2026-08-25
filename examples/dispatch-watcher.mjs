// Polls a GitHub repo for labeled issues and dispatches one sandbox Job per
// issue. Idempotent by construction: Job names derive deterministically from
// issue numbers, so re-running never duplicates work.
//
// Required env:
//   WATCHER_REPO      owner/name to watch            e.g. gwkline/homelab
//   DISPATCH_COMMAND  shell command each dispatched job runs
// Optional env:
//   WATCHER_LABEL     label gate (default: run-agent). Only collaborators can
//                     label issues, so this is also the authorization gate.
//   DISPATCH_PREFIX   Job name prefix       (default: dispatched)
//   DRY_RUN           set to print actions instead of executing them
//
// Runs inside the cluster with ServiceAccount `dispatcher`, which may create
// Jobs in `sandbox` and nothing else (see deploy/dispatcher/base/rbac.yaml).

import { execFileSync } from "node:child_process";

const REPO = process.env.WATCHER_REPO;
const LABEL = process.env.WATCHER_LABEL || "run-agent";
const PREFIX = process.env.DISPATCH_PREFIX || "dispatched";
const COMMAND = process.env.DISPATCH_COMMAND;
const DRY_RUN = Boolean(process.env.DRY_RUN);

if (!REPO || !COMMAND) {
  console.error("WATCHER_REPO and DISPATCH_COMMAND are required");
  process.exit(2);
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts });

const ghJson = (path) => JSON.parse(sh("gh", ["api", path]));

function jobName(issueNumber) {
  const name = `${PREFIX}-issue-${issueNumber}`;
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw new Error(`invalid job name derived: ${name}`);
  }
  return name;
}

function jobManifest(name, issueNumber) {
  return `
apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: sandbox
  labels:
    app: loop-agent
    app.kubernetes.io/part-of: homelab
spec:
  backoffLimit: 1
  ttlSecondsAfterFinished: 604800
  template:
    metadata:
      labels:
        app: loop-agent
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
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
            - name: GITHUB_WRITER_TOKEN_FILE
              value: /secrets-writer/token
            - name: HOME
              value: /tmp
            - name: LOOP_COMMAND
              value: |
                ${COMMAND}
            - name: WATCHER_ISSUE
              value: "${issueNumber}"
            - name: WATCHER_REPO
              value: "${REPO}"
          volumeMounts:
            - name: data
              mountPath: /data
            - name: github-token
              mountPath: /secrets
              readOnly: true
            - name: github-token-writer
              mountPath: /secrets-writer
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
        - name: github-token-writer
          secret:
            secretName: github-token-writer
            optional: true
`;
}

let issues;
try {
  issues = ghJson(
    `repos/${REPO}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=30`,
  );
} catch (err) {
  console.error(`[watcher] GitHub query failed: ${err.message}`);
  process.exit(1);
}

let dispatched = 0;
for (const issue of issues) {
  if (issue.pull_request) continue;
  const name = jobName(issue.number);

  try {
    sh("kubectl", ["get", "job", name, "-n", "sandbox"]);
    console.log(`[watcher] skip ${name} (already dispatched)`);
    continue;
  } catch {
    // not found -> dispatch below
  }

  if (DRY_RUN) {
    console.log(`[watcher] would dispatch ${name} for #${issue.number}: ${issue.title}`);
    continue;
  }

  try {
    sh("kubectl", ["apply", "-n", "sandbox", "-f", "-"], {
      input: jobManifest(name, issue.number),
    });
    console.log(`[watcher] dispatched ${name} for #${issue.number}`);
    dispatched += 1;
  } catch (err) {
    console.error(`[watcher] failed to dispatch ${name}: ${err.message}`);
    process.exit(1);
  }
}

console.log(`[watcher] done. open=${issues.length} dispatched=${dispatched}`);
