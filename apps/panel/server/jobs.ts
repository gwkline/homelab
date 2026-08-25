import { createHash } from "node:crypto";

const IMAGE = process.env.PANEL_LOOP_IMAGE ?? "ghcr.io/gwkline/homelab/loop-agent:latest";
const MAX_NAME = 63;

// DNS-1123 safe, deterministic per (command, second). Collisions mean the
// same launch twice in the same second; k8s rejects and the UI surfaces it.
export function jobNameFor(command: string, now = Date.now()): string {
  const slug = command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha256")
    .update(`${command}:${now}`)
    .digest("hex")
    .slice(0, 6);
  const name = `panel-${slug || "run"}-${hash}`.slice(0, MAX_NAME).replace(/-+$/, "");
  return name;
}

export function jobManifest(opts: {
  name: string;
  command: string;
  repo?: string;
  issue?: string;
}) {
  const repo = opts.repo ?? "gwkline/homelab";
  const env: Array<{ name: string; value: string }> = [
    { name: "GITHUB_TOKEN_FILE", value: "/secrets/token" },
    { name: "GITHUB_WRITER_TOKEN_FILE", value: "/secrets-writer/token" },
    { name: "HOME", value: "/tmp" },
    { name: "LOOP_COMMAND", value: opts.command },
  ];
  if (opts.issue !== undefined) {
    env.push({ name: "WATCHER_ISSUE", value: String(opts.issue) });
    env.push({ name: "WATCHER_REPO", value: repo });
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: opts.name, namespace: "sandbox", labels: { app: "loop-agent", "app.kubernetes.io/part-of": "homelab", "app.kubernetes.io/managed-by": "panel" } },
    spec: {
      backoffLimit: 1,
      ttlSecondsAfterFinished: 604800,
      template: {
        metadata: { labels: { app: "loop-agent" } },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 120,
          securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          containers: [
            {
              name: "loop",
              image: IMAGE,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              env,
              volumeMounts: [
                { name: "data", mountPath: "/data" },
                { name: "github-token", mountPath: "/secrets", readOnly: true },
                { name: "github-token-writer", mountPath: "/secrets-writer", readOnly: true },
              ],
              resources: {
                requests: { cpu: "500m", memory: "1Gi" },
                limits: { memory: "4Gi" },
              },
            },
          ],
          volumes: [
            { name: "data", emptyDir: { sizeLimit: "5Gi" } },
            { name: "github-token", secret: { secretName: "github-token", optional: true } },
            { name: "github-token-writer", secret: { secretName: "github-token-writer", optional: true } },
          ],
        },
      },
    },
  };
}

export interface JobView {
  name: string;
  status: "running" | "complete" | "failed" | "pending";
  issue: string | null;
  age: string;
}

export function viewJob(j: any): JobView {
  const conds: any[] = j.status?.conditions ?? [];
  const complete = conds.some((c) => c.type === "Complete" && c.status === "True");
  const failed = conds.some((c) => c.type === "Failed" && c.status === "True");
  const status = complete ? "complete" : failed ? "failed" : j.status?.active ? "running" : "pending";
  const issue = /^dispatched-issue-\d+$|^panel-.*$/.test(j.metadata.name)
    ? (j.spec?.template?.spec?.containers?.[0]?.env ?? []).find((e: any) => e.name === "WATCHER_ISSUE")?.value ?? null
    : null;
  const created = new Date(j.metadata.creationTimestamp ?? Date.now());
  const seconds = Math.max(0, (Date.now() - created.getTime()) / 1000);
  const age =
    seconds < 90 ? `${Math.round(seconds)}s`
    : seconds < 5400 ? `${Math.round(seconds / 60)}m`
    : seconds < 172800 ? `${Math.round(seconds / 3600)}h`
    : `${Math.round(seconds / 86400)}d`;
  return { name: j.metadata.name, status, issue, age };
}
