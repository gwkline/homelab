import type { K8sObject } from "./k8s.js";

export interface JobView {
  name: string;
  status: "running" | "complete" | "failed" | "pending";
  issue: string | null;
  age: string;
  repo: string | null;
  kind: string;
  created: string | null;
  // Machine-sortable creation epoch (ms). Never NaN: see viewJob.
  createdMs: number;
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

const jobIssue = (name: string): string | null =>
  name.match(/^factory-issue-(?<num>\d+)/u)?.groups?.num ?? null;

const jobRepo = (j: K8sObject, issue: string | null): string | null =>
  issue === null
    ? null
    : (j.metadata?.labels?.["factory.gwkline.io/repo"] ?? null);

export const viewJob = (j: K8sObject): JobView => {
  const conds = j.status?.conditions ?? [];
  const name = j.metadata?.name ?? "";
  const status = jobStatus(conds, j.status?.active ?? 0);
  const issue = jobIssue(name);
  const createdRaw = j.metadata?.creationTimestamp ?? null;
  const parsedMs =
    createdRaw === null ? Number.NaN : new Date(createdRaw).getTime();
  // Invalid timestamps collapse to the epoch so sorting never sees NaN.
  const createdMs = Number.isFinite(parsedMs) ? parsedMs : 0;
  const seconds = Math.max(0, (Date.now() - createdMs) / 1000);
  return {
    age: formatAge(seconds),
    created: createdRaw,
    createdMs,
    issue,
    kind: jobKind(name, j.metadata?.labels),
    name,
    repo: jobRepo(j, issue),
    status,
  };
};
