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
//
// The Job is built as a JavaScript object and handed to kubectl as JSON on
// stdin (kubectl accepts JSON documents, so no YAML is ever assembled).
// DISPATCH_COMMAND is arbitrary shell — quotes, colons, `${...}`, newlines —
// and must reach the pod env byte-for-byte; string-templated YAML block
// scalars cannot guarantee that (issue #21).

import { execFileSync } from "node:child_process";

// DNS-1123 name derived from the issue number; deterministic per (prefix,
// issue), so re-running the watcher never dispatches a duplicate Job.
export const jobName = (prefix, issueNumber) => {
  const name = `${prefix}-issue-${issueNumber}`;
  if (!/^[a-z0-9](?<mid>[-a-z0-9]*[a-z0-9])?$/u.test(name)) {
    throw new Error(`invalid job name derived: ${name}`);
  }
  return name;
};

// Job manifest as data. Field values (command, repo, issue) are plain
// strings in the object tree — no manifest syntax is ever interpolated.
export const jobManifest = ({ command, issueNumber, name, repo }) => ({
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    labels: {
      app: "loop-agent",
      "app.kubernetes.io/part-of": "homelab",
    },
    name,
    namespace: "sandbox",
  },
  spec: {
    backoffLimit: 1,
    template: {
      metadata: { labels: { app: "loop-agent" } },
      spec: {
        automountServiceAccountToken: false,
        containers: [
          {
            env: [
              { name: "GITHUB_TOKEN_FILE", value: "/secrets/token" },
              {
                name: "GITHUB_WRITER_TOKEN_FILE",
                value: "/secrets-writer/token",
              },
              { name: "HOME", value: "/tmp" },
              { name: "LOOP_COMMAND", value: command },
              { name: "WATCHER_ISSUE", value: String(issueNumber) },
              { name: "WATCHER_REPO", value: repo },
            ],
            image:
              "ghcr.io/gwkline/homelab/loop-agent@sha256:e941bae94d9a59ea1c3034c3529ba633b3074ef0be5480b580a415c0e1fdfa70",
            name: "loop",
            resources: {
              limits: { memory: "4Gi" },
              requests: { cpu: "500m", memory: "1Gi" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              runAsNonRoot: true,
              runAsUser: 1000,
            },
            volumeMounts: [
              { mountPath: "/data", name: "data" },
              { mountPath: "/secrets", name: "github-token", readOnly: true },
              {
                mountPath: "/secrets-writer",
                name: "github-token-writer",
                readOnly: true,
              },
            ],
          },
        ],
        restartPolicy: "Never",
        securityContext: { seccompProfile: { type: "RuntimeDefault" } },
        volumes: [
          { emptyDir: { sizeLimit: "5Gi" }, name: "data" },
          {
            name: "github-token",
            secret: { optional: true, secretName: "github-token" },
          },
          {
            name: "github-token-writer",
            secret: { optional: true, secretName: "github-token-writer" },
          },
        ],
      },
    },
    ttlSecondsAfterFinished: 604800,
  },
});

const main = () => {
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
    execFileSync(cmd, args, { encoding: "utf-8", ...opts });

  const ghJson = (path) => JSON.parse(sh("gh", ["api", path]));

  let issues;
  try {
    issues = ghJson(
      `repos/${REPO}/issues?labels=${encodeURIComponent(LABEL)}&state=open&per_page=30`
    );
  } catch (error) {
    console.error(`[watcher] GitHub query failed: ${error.message}`);
    process.exit(1);
  }

  let dispatched = 0;
  for (const issue of issues) {
    if (issue.pull_request) {
      continue;
    }
    const name = jobName(PREFIX, issue.number);

    try {
      sh("kubectl", ["get", "job", name, "-n", "sandbox"]);
      console.log(`[watcher] skip ${name} (already dispatched)`);
      continue;
    } catch {
      // not found -> dispatch below
    }

    if (DRY_RUN) {
      console.log(
        `[watcher] would dispatch ${name} for #${issue.number}: ${issue.title}`
      );
      continue;
    }

    try {
      sh("kubectl", ["apply", "-n", "sandbox", "-f", "-"], {
        input: JSON.stringify(
          jobManifest({
            command: COMMAND,
            issueNumber: issue.number,
            name,
            repo: REPO,
          })
        ),
      });
      console.log(`[watcher] dispatched ${name} for #${issue.number}`);
      dispatched += 1;
    } catch (error) {
      console.error(`[watcher] failed to dispatch ${name}: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(`[watcher] done. open=${issues.length} dispatched=${dispatched}`);
};

if (import.meta.main) {
  main();
}
