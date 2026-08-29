import { createHash } from "node:crypto";

import type { K8sObject } from "./k8s.js";

const IMAGE =
  process.env.PANEL_LOOP_IMAGE ?? "ghcr.io/gwkline/homelab/loop-agent:latest";
const MAX_NAME = 63;

// DNS-1123 safe, deterministic per (command, second). Collisions mean the
// same launch twice in the same second; k8s rejects and the UI surfaces it.
export const jobNameFor = (command: string, now = Date.now()): string => {
  const slug = command
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 32);
  const hash = createHash("sha256")
    .update(`${command}:${now}`)
    .digest("hex")
    .slice(0, 6);
  return `panel-${slug || "run"}-${hash}`
    .slice(0, MAX_NAME)
    .replace(/-+$/u, "");
};

export const jobManifest = (opts: {
  name: string;
  command: string;
  repo?: string | undefined;
  issue?: string | undefined;
}) => {
  const repo = opts.repo ?? "gwkline/homelab";
  const env: { name: string; value: string }[] = [
    { name: "GITHUB_TOKEN_FILE", value: "/secrets/token" },
    { name: "GITHUB_WRITER_TOKEN_FILE", value: "/secrets-writer/token" },
    { name: "HOME", value: "/tmp" },
    { name: "LOOP_COMMAND", value: opts.command },
  ];
  if (opts.issue !== undefined) {
    env.push(
      { name: "WATCHER_ISSUE", value: String(opts.issue) },
      { name: "WATCHER_REPO", value: repo }
    );
  }
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      labels: {
        app: "loop-agent",
        "app.kubernetes.io/managed-by": "panel",
        "app.kubernetes.io/part-of": "homelab",
      },
      name: opts.name,
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
              env,
              image: IMAGE,
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
          terminationGracePeriodSeconds: 120,
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
      ttlSecondsAfterFinished: 604_800,
    },
  };
};

export interface JobView {
  name: string;
  status: "running" | "complete" | "failed" | "pending";
  issue: string | null;
  age: string;
  repo: string | null;
  kind: string;
  created: string | null;
}

interface JobCondition {
  type?: string;
  status?: string;
}

const jobStatus = (
  conds: JobCondition[],
  active: number
): JobView["status"] => {
  if (conds.some((c) => c.type === "Complete" && c.status === "True")) {
    return "complete";
  }
  if (conds.some((c) => c.type === "Failed" && c.status === "True")) {
    return "failed";
  }
  if (active > 0) {
    return "running";
  }
  return "pending";
};

const jobKind = (
  name: string,
  labels: Record<string, string> | undefined
): string => {
  if (name.startsWith("factory-")) {
    return `factory/${labels?.["factory.gwkline.io/profile"] ?? "worker"}`;
  }
  if (name.startsWith("panel-")) {
    return "loop-agent";
  }
  return "other";
};

const formatAge = (seconds: number): string => {
  if (seconds < 90) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 5400) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 172_800) {
    return `${Math.round(seconds / 3600)}h`;
  }
  return `${Math.round(seconds / 86_400)}d`;
};

// WATCHER_* env of the job's first container, or [] when absent.
const firstContainerEnv = (j: K8sObject): { name: string; value: string }[] =>
  j.spec?.template?.spec?.containers?.[0]?.env ?? [];

const jobIssue = (j: K8sObject, name: string): string | null => {
  const env = firstContainerEnv(j);
  const fromEnv = env.find((e) => e.name === "WATCHER_ISSUE")?.value ?? null;
  const fromName =
    name.match(/^factory-issue-(?<num>\d+)/u)?.groups?.num ?? null;
  return fromEnv ?? fromName;
};

const jobRepo = (j: K8sObject, issue: string | null): string | null => {
  const env = firstContainerEnv(j);
  const fromEnv = env.find((e) => e.name === "WATCHER_REPO")?.value ?? null;
  const fromLabels =
    issue === null
      ? null
      : (j.metadata?.labels?.["factory.gwkline.io/repo"] ?? null);
  return fromEnv ?? fromLabels;
};

export const viewJob = (j: K8sObject): JobView => {
  const conds = j.status?.conditions ?? [];
  const name = j.metadata?.name ?? "";
  const status = jobStatus(conds, j.status?.active ?? 0);
  const issue = jobIssue(j, name);
  const createdRaw = j.metadata?.creationTimestamp ?? null;
  const created = new Date(createdRaw ?? Date.now());
  const seconds = Math.max(0, (Date.now() - created.getTime()) / 1000);
  return {
    age: formatAge(seconds),
    created: createdRaw,
    issue,
    kind: jobKind(name, j.metadata?.labels),
    name,
    repo: jobRepo(j, issue),
    status,
  };
};
