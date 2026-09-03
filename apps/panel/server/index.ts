import { readFileSync } from "node:fs";
import path from "node:path";

import { serve } from "@hono/node-server";
import { Hono } from "hono";

import { DEV_TOOLS, discoverTailnet, evaluateTools } from "./devtools.js";
import { jobNameFor, jobManifest, viewJob } from "./jobs.js";
import { loadConfig, api } from "./k8s.js";
import type { K8sObject, JobTemplateSpec } from "./k8s.js";

const root = process.env.PANEL_ROOT ?? process.cwd();
const app = new Hono();
const k8s = api(loadConfig());

const FACTORY_NS = "sandbox";
const FACTORY_CRONJOB = "factory-orchestrator";
// Factory-eligible repos: allowlist (labeling an issue factory/queued here makes
// the orchestrator pick it up). Extend via FACTORY_EXTRA_REPOS="a/b,c/d" env.
const FACTORY_REPOS = new Set([
  "gwkline/homelab",
  "gwkline/launchpad",
  "gwkline/plantry",
  "gwkline/personal-site",
  "gwkline/kline-services-bot",
  "gwkline/discord-bot",
  "gwkline/pr-czar",
  ...(process.env.FACTORY_EXTRA_REPOS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean),
]);
const FACTORY_PROFILES = new Set(["code-pr", "security"]);
const DEFAULT_FACTORY_REPO = process.env.FACTORY_REPO ?? "gwkline/launchpad";
const DEFAULT_FACTORY_PROFILE = process.env.FACTORY_PROFILE ?? "code-pr";

// ── GitHub API response shapes (structural subset actually dereferenced) ──
interface GhIssue {
  html_url: string;
  labels: { name: string }[] | null;
  number: number;
  pull_request?: unknown;
  state: string;
  title: string;
}
interface GhPull {
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  html_url: string;
  labels?: { name: string }[] | null;
  mergeable?: boolean;
  mergeable_state?: string;
  merged_at?: string | null;
  number: number;
  state: string;
  title: string;
}
interface GhCheckRuns {
  check_runs?: { conclusion?: string | null; status?: string }[] | null;
}
interface GhReview {
  state: string;
}
interface GhReviewResult {
  id?: number;
  state?: string;
}
interface GhMergeResult {
  merged?: boolean;
  sha?: string;
}

const ghToken = (): string | null => {
  const direct = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  if (direct) {
    return direct.trim();
  }
  for (const p of [
    "/secrets/token",
    "/secrets/github-token",
    "/var/run/secrets/github-token",
  ]) {
    try {
      const v = readFileSync(p, "utf-8").trim();
      if (v) {
        return v;
      }
    } catch {
      // path not mounted — try the next one
    }
  }
  return null;
};

const GH_API_BASE = (
  process.env.GH_API_BASE ?? "https://api.github.com"
).replace(/\/$/u, "");

const ghFetch = async (
  route: string,
  init: RequestInit = {}
): Promise<unknown> => {
  const token = ghToken();
  if (!token) {
    throw Object.assign(
      new Error("GH_TOKEN not configured (mount github-token secret)"),
      { status: 500 }
    );
  }
  const res = await fetch(`${GH_API_BASE}${route}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON response body — fall through to the status handling below
  }
  if (!res.ok) {
    const msg =
      (json as { message?: string } | undefined)?.message ??
      `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(msg), { body: json, status: res.status });
  }
  return json;
};

// `error: unknown` accessors — thrown errors carry .message and often .status.
const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errStatus = (error: unknown): number | null => {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error as { status?: unknown };
    if (typeof status === "number") {
      return status;
    }
  }
  return null;
};

// Map an upstream error to the response status: statuses in `passThrough`
// surface verbatim (they mean something specific to this route), all else 502.
// The union is a subset of Hono's ContentfulStatusCode.
type RespondCode = 400 | 404 | 405 | 409 | 422 | 502;
const respondStatus = (error: unknown, passThrough: number[]): RespondCode => {
  const status = errStatus(error);
  if (status !== null && passThrough.includes(status)) {
    return status as RespondCode;
  }
  return 502;
};

// Flatten one Node API object into the panel's cluster-card row.
const nodeSummary = (n: K8sObject, podsByNode: Record<string, number>) => {
  type NodeMeta = NonNullable<K8sObject["metadata"]>;
  type NodeStatus = NonNullable<K8sObject["status"]>;
  type NodeInfo = NonNullable<NodeStatus["nodeInfo"]>;
  type NodeCapacity = NonNullable<NodeStatus["capacity"]>;
  const meta: NodeMeta = n.metadata ?? {};
  const status: NodeStatus = n.status ?? {};
  const info: NodeInfo = status.nodeInfo ?? {};
  const capacity: NodeCapacity = status.capacity ?? {};
  const name = meta.name ?? "";
  const internal =
    (status.addresses ?? []).find((a) => a.type === "InternalIP")?.address ??
    null;
  const ready = (status.conditions ?? []).some(
    (x) => x.type === "Ready" && x.status === "True"
  );
  return {
    age: meta.creationTimestamp ?? null,
    arch: info.architecture ?? null,
    capacity: { cpu: capacity.cpu ?? null, memory: capacity.memory ?? null },
    internalIP: internal,
    name,
    os: info.osImage ?? null,
    pods: podsByNode[name] ?? 0,
    roles: Object.keys(meta.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.split("/")[1] ?? ""),
    status: ready ? "Ready" : "NotReady",
    version: info.kubeletVersion ?? null,
  };
};

app.get("/api/state", async (c) => {
  try {
    const [jobs, cronjobs] = await Promise.all([
      k8s.listJobs(),
      k8s.listCronJobs(),
    ]);
    const now = Date.now();
    const jobsOut = (jobs.items ?? [])
      .map(viewJob)
      .toSorted((a, b) => b.createdMs - a.createdMs);
    return c.json({
      cronjobs: (cronjobs.items ?? []).map((cj: K8sObject) => ({
        active: cj.status?.active ?? 0,
        lastScheduled: cj.status?.lastScheduleTime ?? null,
        name: cj.metadata?.name ?? "",
        schedule: cj.spec?.schedule ?? "",
        suspended: cj.spec?.suspend === true,
      })),
      jobs: jobsOut,
      now,
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

// Cluster view: nodes, per-namespace pod counts, metrics.
app.get("/api/cluster", async (c) => {
  try {
    const [nodes, pods] = await Promise.all([
      k8s.listNodes(),
      k8s.listPodsAll(),
    ]);
    const podsByNode: Record<string, number> = {};
    const podsByNs: Record<string, number> = {};
    for (const p of pods.items ?? []) {
      const nodeName = p.spec?.nodeName ?? "?";
      const ns = p.metadata?.namespace ?? "?";
      podsByNode[nodeName] = (podsByNode[nodeName] ?? 0) + 1;
      podsByNs[ns] = (podsByNs[ns] ?? 0) + 1;
    }
    const nodesOut = (nodes.items ?? []).map((n: K8sObject) =>
      nodeSummary(n, podsByNode)
    );
    return c.json({
      nodes: nodesOut,
      podCount: pods.items?.length ?? 0,
      podsByNs,
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

// Dev Tools catalog: the panel's front door for self-hosted developer tools.
// Read-only — health is derived from cluster state (Services, pod readiness)
// plus in-cluster endpoint probes through declared Service ports. No
// credential proxying, no framing; cards link out to tailnet hostnames.
app.get("/api/devtools", async (c) => {
  try {
    const tailnet = await discoverTailnet(process.env, k8s);
    const tools = await evaluateTools(DEV_TOOLS, k8s, tailnet);
    return c.json({
      tailnet: { configured: tailnet !== null, name: tailnet },
      tools,
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

// Per-namespace pod listing (agents + tailscale + sandbox are the interesting ones).
app.get("/api/cluster/pods", async (c) => {
  try {
    const pods = await k8s.listPodsAll();
    const out = (pods.items ?? []).map((p: K8sObject) => ({
      name: p.metadata?.name ?? "",
      node: p.spec?.nodeName ?? "",
      ns: p.metadata?.namespace ?? "",
      phase: p.status?.phase ?? "",
      restarts: (p.status?.containerStatuses ?? []).reduce(
        (acc: number, cs) => acc + (cs.restartCount ?? 0),
        0
      ),
      started: p.metadata?.creationTimestamp ?? null,
    }));
    return c.json({ pods: out });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

// Aggregate view: open issues across ALL factory-eligible repos in one response.
app.get("/api/factory/all-issues", async (c) => {
  const repos = [...FACTORY_REPOS];
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const data = (await ghFetch(
        `/repos/${repo}/issues?state=open&per_page=30`
      )) as GhIssue[];
      return {
        issues: data
          .filter((i) => !i.pull_request)
          .map((i) => ({
            labels: (i.labels ?? []).map((l) => l.name),
            number: i.number,
            state: i.state,
            title: i.title,
            url: i.html_url,
          })),
        repo,
      };
    })
  );
  const reposOut = repos.map((repo, i) => {
    const r = results[i];
    if (r?.status === "fulfilled") {
      return r.value;
    }
    return { error: errMessage(r?.reason), issues: [], repo };
  });
  return c.json({ repos: reposOut });
});

app.get("/api/factory/issues", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  try {
    const data = (await ghFetch(
      `/repos/${repo}/issues?state=open&per_page=50`
    )) as GhIssue[];
    const issues = data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        labels: (i.labels ?? []).map((l) => l.name),
        number: i.number,
        state: i.state,
        title: i.title,
        url: i.html_url,
      }));
    return c.json({ issues, repo });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

const FACTORY_PR_HEAD_RE = /^factory\/issue-\d+\//u;

interface CheckVerdict {
  state: string;
  conclusion: string | null;
}

const checksSummary = (checkRuns: GhCheckRuns["check_runs"]): CheckVerdict => {
  // Aggregate check-run conclusions into one green/pending/red verdict.
  if (!checkRuns?.length) {
    return { conclusion: null, state: "none" };
  }
  const conclusions = checkRuns.map(
    (c) => c.conclusion ?? c.status ?? "pending"
  );
  const red = new Set([
    "failure",
    "timed_out",
    "action_required",
    "cancelled",
    "startup_failure",
    "stale",
  ]);
  const pending = new Set(["pending", "queued", "in_progress", "waiting"]);
  if (conclusions.some((x) => red.has(x))) {
    return { conclusion: "failure", state: "failure" };
  }
  if (conclusions.some((x) => pending.has(x))) {
    return { conclusion: null, state: "pending" };
  }
  const allSuccess = conclusions.every(
    (x) => x === "success" || x === "neutral" || x === "skipped"
  );
  if (allSuccess) {
    return { conclusion: "success", state: "success" };
  }
  return { conclusion: String(conclusions[0]), state: "unknown" };
};

app.get("/api/factory/prs", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  try {
    const pulls = (await ghFetch(
      `/repos/${repo}/pulls?state=open&per_page=50`
    )) as GhPull[];
    const factoryPrs = pulls.filter((p) =>
      FACTORY_PR_HEAD_RE.test(p.head?.ref ?? "")
    );
    const prs = await Promise.all(
      factoryPrs.map(async (p) => {
        const num = p.number;
        let checkState: string | null = null;
        let reviewDecision = "PENDING";
        try {
          const cr = (await ghFetch(
            `/repos/${repo}/commits/${p.head?.sha}/check-runs?per_page=100`
          )) as GhCheckRuns;
          checkState = checksSummary(cr.check_runs ?? []).state;
        } catch {
          // check-runs unavailable — report as none
        }
        try {
          const reviews = (await ghFetch(
            `/repos/${repo}/pulls/${num}/reviews?per_page=100`
          )) as GhReview[];
          if ((reviews ?? []).some((r) => r.state === "CHANGES_REQUESTED")) {
            reviewDecision = "CHANGES_REQUESTED";
          } else if ((reviews ?? []).some((r) => r.state === "APPROVED")) {
            reviewDecision = "APPROVED";
          }
        } catch {
          // reviews unavailable — keep PENDING
        }
        const m = /factory\/issue-(?<num>\d+)\//u.exec(p.head?.ref ?? "");
        return {
          checks: checkState ? { state: checkState } : { state: "none" },
          headRef: p.head?.ref ?? "",
          isDraft: p.draft === true,
          labels: (p.labels ?? []).map((l) => l.name),
          linkedIssue: m ? Number(m.groups?.num) : null,
          number: num,
          reviewDecision,
          state: p.state,
          title: p.title,
          url: p.html_url,
        };
      })
    );
    prs.sort((a, b) => a.number - b.number);
    return c.json({ prs, repo });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

// ── Factory output stats (health card) ─────────────────────────────────────
// Bounded enrichment windows: the API cost stays flat no matter how busy the
// repo is (3 list calls + per-PR detail only for the most recent items).
const STATS_DETAIL_CAP = 20;
const STATS_OPEN_CAP = 10;
const STATS_WEEKS = 6;

// PR detail fields used for autonomous output (commits/LOC).
interface GhPullDetail {
  additions?: number;
  commits?: number;
  deletions?: number;
}

// Queue depth tallies from factory/* labels on open issues.
interface FactoryQueue {
  draftPr: number;
  inProgress: number;
  queued: number;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// Monday 00:00 UTC of the week containing `ms` (trend buckets are UTC weeks).
const weekStartMs = (ms: number): number => {
  const d = new Date(ms);
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
    mondayOffset * 86_400_000
  );
};

const weekLabel = (ms: number): string => {
  const d = new Date(ms);
  return `${MONTHS_SHORT[d.getUTCMonth()] ?? "?"} ${d.getUTCDate()}`;
};

// Queue depth from factory/* labels on open issues (GitHub is the ledger).
const queueCountsFor = (issues: GhIssue[]): FactoryQueue => {
  const queue: FactoryQueue = { draftPr: 0, inProgress: 0, queued: 0 };
  for (const i of issues) {
    if (i.pull_request) {
      continue;
    }
    const labels = new Set((i.labels ?? []).map((l) => l.name));
    if (labels.has("factory/draft-pr")) {
      queue.draftPr += 1;
    }
    if (labels.has("factory/in-progress")) {
      queue.inProgress += 1;
    }
    if (labels.has("factory/queued")) {
      queue.queued += 1;
    }
  }
  return queue;
};

// UTC Monday-aligned week buckets covering the last STATS_WEEKS weeks
// (oldest first) plus a counter slot per bucket.
const weekBuckets = (): { counts: number[]; starts: number[] } => {
  const currentWeek = weekStartMs(Date.now());
  const starts = Array.from(
    { length: STATS_WEEKS },
    (_, i) => currentWeek - (STATS_WEEKS - 1 - i) * 7 * 86_400_000
  );
  return { counts: starts.map(() => 0), starts };
};

// Review + CI rates over the open factory PRs (bounded enrichment).
const openPrRates = async (
  repo: string,
  openFactory: GhPull[]
): Promise<{ ciGreen: number; ciTotal: number; reviewApproved: number }> => {
  let ciGreen = 0;
  let ciTotal = 0;
  let reviewApproved = 0;
  await Promise.all(
    openFactory.slice(0, STATS_OPEN_CAP).map(async (p) => {
      try {
        const cr = (await ghFetch(
          `/repos/${repo}/commits/${p.head?.sha}/check-runs?per_page=100`
        )) as GhCheckRuns;
        const { state } = checksSummary(cr.check_runs ?? []);
        if (state !== "none") {
          ciTotal += 1;
          if (state === "success") {
            ciGreen += 1;
          }
        }
      } catch {
        // check-runs unavailable — leave it out of the CI rate
      }
      try {
        const reviews = (await ghFetch(
          `/repos/${repo}/pulls/${p.number}/reviews?per_page=100`
        )) as GhReview[];
        if ((reviews ?? []).some((r) => r.state === "APPROVED")) {
          reviewApproved += 1;
        }
      } catch {
        // reviews unavailable — leave it out of the review rate
      }
    })
  );
  return { ciGreen, ciTotal, reviewApproved };
};

// Autonomous output: commits/LOC summed over the recent merged factory PRs.
const autonomousOutput = async (
  repo: string,
  mergedFactory: GhPull[]
): Promise<{ additions: number; commits: number; deletions: number }> => {
  const details = await Promise.all(
    mergedFactory.slice(0, STATS_DETAIL_CAP).map((p) =>
      ghFetch(`/repos/${repo}/pulls/${p.number}`)
        .then((d) => d as GhPullDetail)
        .catch(() => null)
    )
  );
  const out = { additions: 0, commits: 0, deletions: 0 };
  for (const d of details) {
    out.additions += d?.additions ?? 0;
    out.commits += d?.commits ?? 0;
    out.deletions += d?.deletions ?? 0;
  }
  return out;
};

app.get("/api/factory/stats", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  try {
    const [issues, closedPulls, openPulls] = (await Promise.all([
      ghFetch(`/repos/${repo}/issues?state=open&per_page=100`),
      ghFetch(`/repos/${repo}/pulls?state=closed&per_page=100`),
      ghFetch(`/repos/${repo}/pulls?state=open&per_page=50`),
    ])) as [GhIssue[], GhPull[], GhPull[]];

    const queue = queueCountsFor(issues ?? []);

    const isFactoryPr = (p: GhPull): boolean =>
      FACTORY_PR_HEAD_RE.test(p.head?.ref ?? "");

    // Merge rate + weekly trend come from the closed factory PR window.
    const closedFactory = (closedPulls ?? []).filter(isFactoryPr);
    const mergedFactory = closedFactory.filter(
      (p) => p.merged_at !== null && p.merged_at !== undefined
    );
    const { counts, starts } = weekBuckets();
    for (const p of mergedFactory) {
      const ms = Date.parse(p.merged_at ?? "");
      if (Number.isNaN(ms)) {
        continue;
      }
      const idx = starts.lastIndexOf(weekStartMs(ms));
      if (idx !== -1) {
        counts[idx] = (counts[idx] ?? 0) + 1;
      }
    }

    const openFactory = (openPulls ?? []).filter(isFactoryPr);
    const [rates, autonomous] = await Promise.all([
      openPrRates(repo, openFactory),
      autonomousOutput(repo, mergedFactory),
    ]);

    return c.json({
      autonomous,
      ci: { green: rates.ciGreen, total: rates.ciTotal },
      merge: { merged: mergedFactory.length, total: closedFactory.length },
      queue,
      repo,
      review: { approved: rates.reviewApproved, total: openFactory.length },
      weeklyMerges: starts.map((ms, i) => ({
        label: weekLabel(ms),
        merged: counts[i] ?? 0,
      })),
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, 502);
  }
});

const FACTORY_REVIEW_EVENTS = new Set([
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
]);
const FACTORY_MERGE_STRATEGIES = new Set(["squash", "merge", "rebase"]);

const parseNum = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
};

// Merge preconditions on the PR object itself: factory branch, not draft,
// not blocked. Returns the refusal message, or null when safe to proceed.
const mergeGuardError = (pr: number, meta: GhPull): string | null => {
  const headRef = meta.head?.ref ?? "";
  if (!FACTORY_PR_HEAD_RE.test(headRef)) {
    return `PR #${pr} head '${headRef}' is not a factory branch — refusing to merge`;
  }
  if (meta.draft === true) {
    return `PR #${pr} is still a draft`;
  }
  const blocked =
    (meta.mergeable_state ?? "").includes("blocked") && meta.mergeable !== true;
  if (blocked) {
    return `PR #${pr} is blocked (branch protection or failing checks)`;
  }
  return null;
};

// Green checks + an approving review, else why the PR cannot merge yet.
const mergeGateError = async (
  repo: string,
  pr: number,
  meta: GhPull
): Promise<string | null> => {
  try {
    const cr = (await ghFetch(
      `/repos/${repo}/commits/${meta.head?.sha}/check-runs?per_page=100`
    )) as GhCheckRuns;
    if (checksSummary(cr.check_runs ?? []).state !== "success") {
      return `PR #${pr} checks are not green — refusing to merge`;
    }
    const reviews = (await ghFetch(
      `/repos/${repo}/pulls/${pr}/reviews?per_page=100`
    )) as GhReview[];
    const approved = (reviews ?? []).some((r) => r.state === "APPROVED");
    if (!approved) {
      return `PR #${pr} has no approving review — approve it first`;
    }
    return null;
  } catch (error: unknown) {
    return `guard check failed: ${errMessage(error)}`;
  }
};

// Kick off a factory run: clone the orchestrator CronJob's pod template into an
// ad-hoc Job with FACTORY_ISSUE/FACTORY_PROFILE injected. Returns the job name,
// or the failure message (the queued label is kept either way).
const triggerFactoryJob = async (
  repo: string,
  profile: string,
  issueNum: number
): Promise<string | Error> => {
  try {
    const cj = await k8s.getCronJob(FACTORY_CRONJOB);
    const template = cj.spec?.jobTemplate;
    if (!template) {
      return new Error("CronJob has no jobTemplate");
    }
    const ts = Date.now().toString(36);
    const jobName = `factory-issue-${issueNum}-${ts}`.slice(0, 63);
    // Clone the template so we can inject FACTORY_ISSUE (avoids GH label propagation race)
    const spec = structuredClone(template.spec ?? {}) as JobTemplateSpec;
    const containers = spec.template?.spec?.containers ?? [];
    if (containers[0]) {
      containers[0].env = [
        ...(containers[0].env ?? []),
        { name: "FACTORY_ISSUE", value: String(issueNum) },
        { name: "FACTORY_PROFILE", value: profile },
      ];
    }
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        labels: {
          "factory.gwkline.io/issue": String(issueNum),
          "factory.gwkline.io/profile": profile,
          "factory.gwkline.io/repo": repo,
          "factory.gwkline.io/trigger": "panel",
        },
        name: jobName,
        namespace: FACTORY_NS,
      },
      spec,
    };
    await k8s.createJob(job);
    return jobName;
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(errMessage(error));
  }
};

app.post("/api/factory/review", async (c) => {
  let body: {
    repo?: string;
    pr?: number | string;
    event?: string;
    body?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const pr = parseNum(body.pr);
  if (pr === null) {
    return c.json({ error: "pr must be a positive integer" }, 400);
  }
  const event = String(body.event ?? "").trim();
  if (!FACTORY_REVIEW_EVENTS.has(event)) {
    return c.json(
      {
        error: `event must be one of ${[...FACTORY_REVIEW_EVENTS].join(", ")}`,
      },
      400
    );
  }
  const reviewBody =
    typeof body.body === "string" && body.body.trim()
      ? body.body.trim().slice(0, 4000)
      : undefined;
  try {
    const review = (await ghFetch(`/repos/${repo}/pulls/${pr}/reviews`, {
      body: JSON.stringify(
        reviewBody ? { body: reviewBody, event } : { event }
      ),
      headers: { "content-type": "application/json" },
      method: "POST",
    })) as GhReviewResult;
    return c.json({
      event,
      id: review?.id ?? null,
      pr,
      repo,
      state: review?.state ?? null,
    });
  } catch (error: unknown) {
    return c.json(
      { error: errMessage(error) },
      respondStatus(error, [404, 422])
    );
  }
});

app.post("/api/factory/merge", async (c) => {
  let body: { repo?: string; pr?: number | string; strategy?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const pr = parseNum(body.pr);
  if (pr === null) {
    return c.json({ error: "pr must be a positive integer" }, 400);
  }
  const strategy = FACTORY_MERGE_STRATEGIES.has(body.strategy ?? "")
    ? (body.strategy as string)
    : "squash";

  // Guard: only merge factory-generated PRs with green checks + approval.
  let meta: GhPull;
  try {
    meta = (await ghFetch(`/repos/${repo}/pulls/${pr}`)) as GhPull;
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error, [404]));
  }
  const guardError = mergeGuardError(pr, meta);
  if (guardError !== null) {
    return c.json({ error: guardError }, 409);
  }
  const gateError = await mergeGateError(repo, pr, meta);
  if (gateError !== null) {
    return c.json({ error: gateError }, 502);
  }

  try {
    const res = (await ghFetch(`/repos/${repo}/pulls/${pr}/merge`, {
      body: JSON.stringify({
        commit_title: `feat(factory): ${meta.title} (#${pr})`.slice(0, 200),
        merge_method: strategy,
      }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    })) as GhMergeResult;
    return c.json({
      merged: res?.merged === true,
      pr,
      repo,
      sha: res?.sha ?? null,
      strategy,
    });
  } catch (error: unknown) {
    return c.json(
      { error: errMessage(error) },
      respondStatus(error, [405, 409])
    );
  }
});

app.post("/api/factory/run", async (c) => {
  let body: { issue?: number | string; repo?: string; profile?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const profile = (body.profile ?? DEFAULT_FACTORY_PROFILE).trim();
  if (!FACTORY_PROFILES.has(profile)) {
    return c.json(
      {
        error: `profile not allowed (use ${[...FACTORY_PROFILES].join(", ")})`,
      },
      400
    );
  }
  const issueNum = Number(body.issue);
  if (!Number.isInteger(issueNum) || issueNum < 1 || issueNum > 10_000_000) {
    return c.json({ error: "issue must be a positive integer" }, 400);
  }

  let issue: GhIssue;
  try {
    issue = (await ghFetch(`/repos/${repo}/issues/${issueNum}`)) as GhIssue;
  } catch (error: unknown) {
    if (errStatus(error) === 404) {
      return c.json({ error: `issue #${issueNum} not found in ${repo}` }, 404);
    }
    return c.json({ error: errMessage(error) }, 502);
  }
  if (issue.pull_request) {
    return c.json({ error: `issue #${issueNum} is a pull request` }, 400);
  }
  if (issue.state !== "open") {
    return c.json({ error: `issue #${issueNum} is ${issue.state}` }, 409);
  }
  const labels: ReadonlySet<string> = new Set(
    (issue.labels ?? []).map((l) => l.name)
  );
  const has = (name: string) => labels.has(name);
  if (has("factory/queued")) {
    return c.json({ error: `issue #${issueNum} is already queued` }, 409);
  }
  if (has("factory/in-progress")) {
    return c.json({ error: `issue #${issueNum} is already in-progress` }, 409);
  }
  if (has("factory/draft-pr")) {
    return c.json({ error: `issue #${issueNum} already has a draft PR` }, 409);
  }

  // 1. Label it queued (GitHub is the ledger — orchestrator polls this label)
  try {
    await ghFetch(`/repos/${repo}/issues/${issueNum}/labels`, {
      body: JSON.stringify({ labels: ["factory/queued"] }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error: unknown) {
    return c.json(
      { error: `failed to label issue: ${errMessage(error)}` },
      502
    );
  }

  // 2. Immediately trigger the orchestrator (create Job from CronJob), so the user doesn't wait 6h.
  // The CronJob's Job-from-CronJob run is the same path as the scheduled tick, just ad-hoc.
  const trigger = await triggerFactoryJob(repo, profile, issueNum);
  if (typeof trigger === "string") {
    // Label already applied — surface the k8s error but don't roll back the label (next tick will pick it up anyway).
    return c.json(
      { error: trigger, issue: issueNum, jobName: null, queued: true, repo },
      502
    );
  }
  return c.json(
    { issue: issueNum, jobName: trigger, profile, queued: true, repo },
    201
  );
});

// CronJob suspend/resume + schedule edit from the panel schedules card.
app.patch("/api/cronjobs/:name", async (c) => {
  const name = c.req.param("name");
  let body: { suspended?: boolean; schedule?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const patch: { spec: { suspend?: boolean; schedule?: string } } = {
    spec: {},
  };
  if (body.suspended !== undefined) {
    patch.spec.suspend = body.suspended === true;
  }
  if (body.schedule !== undefined) {
    if (!/^[\d*/,-]+$/u.test(body.schedule)) {
      return c.json({ error: "invalid cron schedule" }, 400);
    }
    patch.spec.schedule = body.schedule;
  }
  if (!Object.keys(patch.spec).length) {
    return c.json({ error: "nothing to patch" }, 400);
  }
  try {
    await k8s.patchCronJob(name, patch);
    return c.json({ name, ok: true });
  } catch (error: unknown) {
    const status = errStatus(error);
    return c.json({ error: errMessage(error) }, status === 404 ? 404 : 502);
  }
});

// Job cleanup: delete completed/failed jobs by name.
app.delete("/api/jobs/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[\w-]+$/u.test(name)) {
    return c.json({ error: "invalid job name" }, 400);
  }
  try {
    await k8s.deleteJob(name);
    return c.json({ name, ok: true });
  } catch (error: unknown) {
    const status = errStatus(error);
    return c.json({ error: errMessage(error) }, status === 404 ? 404 : 502);
  }
});

app.post("/api/jobs", async (c) => {
  let body: { command?: string; issue?: string; repo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const command = body.command?.trim();
  if (!command) {
    return c.json({ error: "command is required" }, 400);
  }
  if (command.length > 2000) {
    return c.json({ error: "command too long" }, 400);
  }
  const issue = body.issue === undefined ? undefined : String(body.issue);
  if (issue !== undefined && !/^\d{1,7}$/u.test(issue)) {
    return c.json({ error: "issue must be a number" }, 400);
  }
  const name = jobNameFor(command);
  try {
    await k8s.createJob(jobManifest({ command, issue, name, repo: body.repo }));
    return c.json({ name }, 201);
  } catch (error: unknown) {
    const status = errStatus(error);
    return c.json({ error: errMessage(error) }, status === 409 ? 409 : 502);
  }
});

const web = path.join(root, "web", "dist");

const contentTypeFor = (rel: string): string => {
  if (rel.endsWith(".js")) {
    return "text/javascript";
  }
  if (rel.endsWith(".css")) {
    return "text/css";
  }
  if (rel.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "text/html";
};

// Hono middleware: API paths pass through untouched; everything else serves
// the built SPA (index.html fallback keeps client-side routes working).
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/")) {
    return await next();
  }
  try {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const file = readFileSync(path.join(web, rel));
    return c.body(file, 200, { "content-type": contentTypeFor(rel) });
  } catch {
    return c.body(readFileSync(path.join(web, "index.html")), 200, {
      "content-type": "text/html",
    });
  }
});
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () =>
  console.log(`[panel] listening on ${port}`)
);
