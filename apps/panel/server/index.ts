import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { timeout } from "hono/timeout";

import { requireCaller } from "./auth.js";
import type { AuthEnv } from "./auth.js";
import { validCronSchedule } from "./cron.js";
import { DEV_TOOLS, discoverTailnet, evaluateTools } from "./devtools.js";
import { jobRepo, viewJob } from "./jobs.js";
import { loadConfig, api } from "./k8s.js";
import type { EnvVar, K8sObject, JobTemplateSpec } from "./k8s.js";
import {
  createKnowledgeClient,
  KnowledgeApiError,
  KNOWLEDGE_MODE_SET,
  KNOWLEDGE_QUERY_MAX,
  KNOWLEDGE_TOP_K_MAX,
  loadKnowledgeConfig,
  NAMESPACE_PATTERN,
  SOURCE_ID_PATTERN,
} from "./knowledge.js";
import { log } from "./log.js";
import {
  collectRepoStats,
  historyFromStore,
  loadStatsStore,
  sumSeries,
  sumWeekStats,
  upsertSnapshot,
  weekKeysBack,
  weekStart,
  weekStatsOf,
} from "./stats.js";
import type { RepoStats } from "./stats.js";
import {
  REQUEST_TIMEOUT_MS,
  UPSTREAM_TIMEOUT_MS,
  upstreamError,
} from "./upstream.js";

const root = process.env.PANEL_ROOT ?? process.cwd();
const port = Number(process.env.PORT ?? 3000);
const tailnetPort = process.env.PANEL_TAILNET_PORT
  ? Number(process.env.PANEL_TAILNET_PORT)
  : null;
const app = new Hono<AuthEnv>();
app.use("*", async (c, next) => {
  const started = performance.now();
  try {
    return await next();
  } finally {
    log("info", "request", {
      durationMs: Math.round(performance.now() - started),
      method: c.req.method,
      path: c.req.path,
      // The pattern of the handler that answered (dispatch has moved past
      // this middleware by now).
      route: routePath(c),
      status: c.res.status,
    });
  }
});
app.use(
  "/api/*",
  timeout(
    REQUEST_TIMEOUT_MS,
    new HTTPException(504, {
      message: `request exceeded ${REQUEST_TIMEOUT_MS}ms`,
    })
  )
);
app.onError((thrown, c) => {
  if (thrown instanceof HTTPException) {
    return c.json({ error: thrown.message }, thrown.status);
  }
  log("error", "unhandled error", {
    error: thrown.message,
    method: c.req.method,
    path: c.req.path,
  });
  return c.json({ error: "internal error" }, 500);
});
app.use(
  "/api/*",
  requireCaller({
    authDir: process.env.PANEL_AUTH_DIR ?? "/secrets-panel-auth",
    tailnetPort,
  })
);
const k8s = api(loadConfig());
const knowledgeCfg = loadKnowledgeConfig();
const knowledge = createKnowledgeClient(knowledgeCfg);

const FACTORY_NS = "sandbox";
// Matches the factory CronJobs' ttlSecondsAfterFinished.
const FACTORY_JOB_TTL_SECONDS = 86_400;
// Each factory repo and the orchestrator CronJob that serves it
// (deploy/factory/base/orchestrator-*cronjob.yaml). A run clones that CronJob,
// so a repo without one could never leave factory/queued.
const FACTORY_ORCHESTRATORS: ReadonlyMap<string, string> = new Map([
  ["gwkline/homelab", "factory-orchestrator"],
  ["gwkline/launchpad", "factory-orchestrator-launchpad"],
]);
const FACTORY_REPOS: ReadonlySet<string> = new Set(
  FACTORY_ORCHESTRATORS.keys()
);
const FACTORY_PROFILES = new Set(["code-pr", "security"]);
const DEFAULT_FACTORY_REPO = process.env.FACTORY_REPO ?? "gwkline/launchpad";
const DEFAULT_FACTORY_PROFILE = process.env.FACTORY_PROFILE ?? "code-pr";
// The closed set of admitted RunProfiles; create/retry reject anything else.
const FACTORY_PROFILE_INFO = [
  {
    description:
      "Ephemeral coding worker: labeled issue → tested change → draft PR",
    name: "code-pr",
  },
  {
    description: "Security sweep profile (hardened worker, scoped egress)",
    name: "security",
  },
] as const;
// Run states derived from ledger labels; first match wins when several co-exist.
const FACTORY_RUN_STATES: [string, string][] = [
  ["factory/queued", "queued"],
  ["factory/in-progress", "running"],
  ["factory/pending-approval", "awaiting-approval"],
  ["factory/draft-pr", "published"],
  ["factory/needs-review", "needs-review"],
  ["factory/approved", "approved"],
  ["factory/failed", "failed"],
  ["factory/cancelled", "cancelled"],
];
const FACTORY_RUN_STATE_NAMES = new Set(FACTORY_RUN_STATES.map(([, s]) => s));
const FACTORY_CANCELABLE = new Set(["queued", "running", "awaiting-approval"]);
const FACTORY_RETRYABLE = new Set(["failed", "cancelled"]);
const FACTORY_TERMINAL_DONE = new Set([
  "published",
  "needs-review",
  "approved",
]);
// States whose labels must be stripped when a run is cancelled or retried.
const FACTORY_ACTIVE_LABELS = [
  "factory/queued",
  "factory/in-progress",
  "factory/pending-approval",
];
const FACTORY_FAILED_LABELS = ["factory/failed", "factory/cancelled"];
const runStateFor = (issue: GhIssue): string | null => {
  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  for (const [label, state] of FACTORY_RUN_STATES) {
    if (labels.has(label)) {
      return state;
    }
  }
  return null;
};
// Weeks of trend data derived from GitHub; older weeks come from the snapshot file.
const STATS_WINDOW_WEEKS = 8;
const FACTORY_STATS_PATH =
  process.env.FACTORY_STATS_PATH ??
  path.join(root, "data", "factory-stats.json");

// ── GitHub API response shapes (only the fields we read) ──
interface GhIssue {
  html_url: string;
  labels: { name: string }[] | null;
  number: number;
  pull_request?: unknown;
  state: string;
  title: string;
  updated_at?: string;
}
interface GhComment {
  body: string;
  html_url: string;
}
interface GhPull {
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  html_url: string;
  labels?: { name: string }[] | null;
  mergeable?: boolean;
  mergeable_state?: string;
  merged_at?: string | null;
  node_id?: string;
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
  const call = { method: init.method ?? "GET", path: route };
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${GH_API_BASE}${route}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (error: unknown) {
    throw upstreamError("github", call, error);
  }
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
    throw upstreamError("github", call, new Error(msg), res.status);
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

// Timeouts surface as 504 and statuses in `passThrough` verbatim; every
// other failure becomes 502.
type RespondCode = 400 | 404 | 405 | 409 | 422 | 502 | 504;
const respondStatus = (
  error: unknown,
  passThrough: number[] = []
): RespondCode => {
  const status = errStatus(error);
  if (status !== null && (status === 504 || passThrough.includes(status))) {
    return status as RespondCode;
  }
  return 502;
};

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
    return c.json({ error: errMessage(error) }, respondStatus(error));
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
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

// Dev Tools catalog: read-only health from cluster state and endpoint probes.
app.get("/api/devtools", async (c) => {
  try {
    const tailnet = await discoverTailnet(process.env, k8s);
    const tools = await evaluateTools(DEV_TOOLS, k8s, tailnet);
    return c.json({
      tailnet: { configured: tailnet !== null, name: tailnet },
      tools,
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

// ── Knowledge: sources, sync, cited search ─────────────────────────────────
// Proxy over the knowledge API; the bearer token never leaves the server.

const knowledgeStatus = (error: unknown): 404 | 409 | 422 | 502 | 504 => {
  const status = errStatus(error);
  if (
    error instanceof KnowledgeApiError &&
    (status === 404 || status === 409 || status === 422 || status === 504)
  ) {
    return status;
  }
  return 502;
};

app.get("/api/knowledge/sources", async (c) => {
  if (knowledgeCfg.base === null) {
    return c.json({ configured: false, sources: [] });
  }
  try {
    const sources = await knowledge.listSources();
    return c.json({ configured: true, sources });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, knowledgeStatus(error));
  }
});

app.post("/api/knowledge/sync", async (c) => {
  if (knowledgeCfg.base === null) {
    return c.json({ error: "knowledge API is not configured" }, 503);
  }
  let body: { sourceId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const sourceId = String(body.sourceId ?? "").trim();
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    return c.json(
      {
        error:
          "sourceId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ (as shown in the sources view)",
      },
      400
    );
  }
  try {
    const job = await knowledge.triggerSync(sourceId);
    return c.json({ jobId: job.jobId, sourceId, status: job.status }, 202);
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, knowledgeStatus(error));
  }
});

app.get("/api/knowledge/sync/:jobId", async (c) => {
  if (knowledgeCfg.base === null) {
    return c.json({ error: "knowledge API is not configured" }, 503);
  }
  const jobId = c.req.param("jobId");
  if (!SOURCE_ID_PATTERN.test(jobId)) {
    return c.json({ error: "invalid job id" }, 400);
  }
  try {
    return c.json(await knowledge.syncJob(jobId));
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, knowledgeStatus(error));
  }
});

app.post("/api/knowledge/search", async (c) => {
  if (knowledgeCfg.base === null) {
    return c.json({ error: "knowledge API is not configured" }, 503);
  }
  let body: {
    includeSuperseded?: boolean;
    mode?: string;
    namespace?: string;
    query?: string;
    topK?: number | string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (query.length === 0) {
    return c.json({ error: "query must not be blank" }, 400);
  }
  if (query.length > KNOWLEDGE_QUERY_MAX) {
    return c.json(
      { error: `query exceeds ${KNOWLEDGE_QUERY_MAX} characters` },
      400
    );
  }
  // Mirrors the retrieval API's contract so upstream never sees a malformed body.
  const upstream: Record<string, unknown> = { query };
  if (body.namespace !== undefined) {
    const namespace = String(body.namespace).trim();
    if (!NAMESPACE_PATTERN.test(namespace)) {
      return c.json(
        { error: "namespace must match ^[a-z0-9][a-z0-9-]{0,63}$" },
        400
      );
    }
    upstream.namespace = namespace;
  }
  if (body.mode !== undefined) {
    const mode = String(body.mode);
    if (!KNOWLEDGE_MODE_SET.has(mode)) {
      return c.json({ error: "mode must be one of bm25, vector, hybrid" }, 400);
    }
    upstream.mode = mode;
  }
  if (body.topK !== undefined) {
    const topK = Number(body.topK);
    if (!Number.isInteger(topK) || topK < 1 || topK > KNOWLEDGE_TOP_K_MAX) {
      return c.json(
        {
          error: `topK must be an integer between 1 and ${KNOWLEDGE_TOP_K_MAX}`,
        },
        400
      );
    }
    upstream.topK = topK;
  }
  if (body.includeSuperseded === true) {
    upstream.filters = { includeSuperseded: true };
  }
  try {
    const out = await knowledge.search(upstream);
    return c.json({
      results: out.results,
      totalCandidates: out.totalCandidates,
    });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, knowledgeStatus(error));
  }
});

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
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

// Open issues across all factory-eligible repos.
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
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

app.get("/api/factory/stats/rollup", async (c) => {
  const now = new Date();
  const rollupWeeks = weekKeysBack(now, STATS_WINDOW_WEEKS);
  const week = weekStart(now);
  const weeks = weekKeysBack(now, STATS_WINDOW_WEEKS);
  const repoList = [...FACTORY_REPOS];
  const results = await Promise.allSettled(
    repoList.map((repo) => collectRepoStats(repo, weeks, ghFetch))
  );
  const ok: { repo: string; stats: RepoStats }[] = [];
  const reposOut = repoList.map((repo, i) => {
    const r = results[i];
    if (r?.status === "fulfilled") {
      ok.push({ repo, stats: r.value });
      return { repo, ...r.value };
    }
    return { error: errMessage(r?.reason), repo };
  });
  const totals = {
    issuesClosed: sumSeries(ok.map((x) => x.stats.issuesClosed)),
    issuesOpened: sumSeries(ok.map((x) => x.stats.issuesOpened)),
    openIssues: ok.reduce((acc, x) => acc + x.stats.openIssues, 0),
    openPrs: ok.reduce((acc, x) => acc + x.stats.openPrs, 0),
    prsMerged: sumSeries(ok.map((x) => x.stats.prsMerged)),
    prsOpened: sumSeries(ok.map((x) => x.stats.prsOpened)),
  };
  const snapshot = {
    capturedAt: now.toISOString(),
    repos: Object.fromEntries(
      ok.map((x) => [x.repo, weekStatsOf(x.stats)] as const)
    ),
    totals: sumWeekStats(ok.map((x) => weekStatsOf(x.stats))),
    week,
  };
  // Never persist an all-repos failure (e.g. a GitHub outage) — zeros would
  // poison the trend history. Partial failures still snapshot what succeeded.
  let persisted = false;
  if (ok.length > 0) {
    try {
      upsertSnapshot(FACTORY_STATS_PATH, snapshot);
      persisted = true;
    } catch (error: unknown) {
      log("warn", "stats snapshot not persisted", {
        error: errMessage(error),
      });
    }
  }
  const history = historyFromStore(loadStatsStore(FACTORY_STATS_PATH));
  return c.json({
    history,
    persisted,
    repos: reposOut,
    stats: { weeks: rollupWeeks },
    totals,
    weeks: rollupWeeks,
  });
});

const FACTORY_PR_HEAD_RE = /^factory\/issue-\d+\//u;

interface CheckVerdict {
  state: string;
  conclusion: string | null;
}

const checksSummary = (checkRuns: GhCheckRuns["check_runs"]): CheckVerdict => {
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
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

// ── Factory output stats (health card) ─────────────────────────────────────
// Bounded windows keep GitHub API cost flat regardless of repo activity.
const STATS_DETAIL_CAP = 20;
const STATS_OPEN_CAP = 10;
const STATS_WEEKS = 6;

interface GhPullDetail {
  additions?: number;
  commits?: number;
  deletions?: number;
}

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

// UTC Monday-aligned week buckets for the last STATS_WEEKS weeks, oldest first.
const weekBuckets = (): { counts: number[]; starts: number[] } => {
  const currentWeek = weekStartMs(Date.now());
  const starts = Array.from(
    { length: STATS_WEEKS },
    (_, i) => currentWeek - (STATS_WEEKS - 1 - i) * 7 * 86_400_000
  );
  return { counts: starts.map(() => 0), starts };
};

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

// `cached` marks a server-cache hit so views can show staleness.
interface FactoryStatsResponse {
  autonomous: { additions: number; commits: number; deletions: number };
  cached: boolean;
  ci: { green: number; total: number };
  merge: { merged: number; total: number };
  queue: FactoryQueue;
  repo: string;
  review: { approved: number; total: number };
  stats: RepoStats;
  weeklyMerges: { label: string; merged: number }[];
  weeks: string[];
}

// One stats call fans out to a dozen GitHub requests; merged history is
// immutable, so a short TTL costs little staleness. Failures are never cached.
const STATS_CACHE_TTL_MS = 120_000;
const statsCache = new Map<
  string,
  { at: number; body: Omit<FactoryStatsResponse, "cached"> }
>();

app.get("/api/factory/stats", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const hit = statsCache.get(repo);
  if (hit && Date.now() - hit.at < STATS_CACHE_TTL_MS) {
    return c.json({ ...hit.body, cached: true });
  }
  try {
    const statsWeeks = weekKeysBack(Date.now(), STATS_WINDOW_WEEKS);
    const stats = await collectRepoStats(repo, statsWeeks, ghFetch);
    const [issues, closedPulls, openPulls] = (await Promise.all([
      ghFetch(`/repos/${repo}/issues?state=open&per_page=100`),
      ghFetch(`/repos/${repo}/pulls?state=closed&per_page=100`),
      ghFetch(`/repos/${repo}/pulls?state=open&per_page=50`),
    ])) as [GhIssue[], GhPull[], GhPull[]];
    const queue = queueCountsFor(issues ?? []);
    const isFactoryPr = (p: GhPull): boolean =>
      FACTORY_PR_HEAD_RE.test(p.head?.ref ?? "");
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
    const body: Omit<FactoryStatsResponse, "cached"> = {
      autonomous,
      ci: { green: rates.ciGreen, total: rates.ciTotal },
      merge: { merged: mergedFactory.length, total: closedFactory.length },
      queue,
      repo,
      review: { approved: rates.reviewApproved, total: openFactory.length },
      stats,
      weeklyMerges: starts.map((ms, i) => ({
        label: weekLabel(ms),
        merged: counts[i] ?? 0,
      })),
      weeks: statsWeeks,
    };
    statsCache.set(repo, { at: Date.now(), body });
    return c.json({ ...body, cached: false });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error));
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

// The panel only reviews and merges what the factory opened.
const notFactoryBranch = (pr: number, meta: GhPull): string | null => {
  const headRef = meta.head?.ref ?? "";
  return FACTORY_PR_HEAD_RE.test(headRef)
    ? null
    : `PR #${pr} head '${headRef}' is not a factory branch`;
};

// Merge preconditions on the PR object itself: factory branch, not draft,
// not blocked. Returns the refusal message, or null when safe to proceed.
const mergeGuardError = (pr: number, meta: GhPull): string | null => {
  const branchError = notFactoryBranch(pr, meta);
  if (branchError !== null) {
    return `${branchError} — refusing to merge`;
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

// Strict MCP request shapes: unknown fields (e.g. smuggled Kubernetes
// settings) are rejected, matching additionalProperties: false in the spec.
const rejectUnknownFields = (
  body: Record<string, unknown>,
  allowed: string[]
): string | null => {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  return unknown.length
    ? `unknown fields (allowed: ${allowed.join(", ")})`
    : null;
};

// Replaces entries by name rather than appending: duplicate env names draw
// API warnings and leave anyone reading the spec guessing which value runs.
const withEnv = (env: EnvVar[], set: Record<string, string>): EnvVar[] => [
  ...env.filter((e) => !Object.hasOwn(set, e.name)),
  ...Object.entries(set).map(([name, value]) => ({ name, value })),
];

// Clone the repo's orchestrator CronJob into an ad-hoc Job pinned to the
// requested repo, issue, profile, and caller. Returns the job name or the
// failure message; the queued label is kept either way.
const triggerFactoryJob = async (
  repo: string,
  profile: string,
  issueNum: number,
  requestedBy: string
): Promise<string | Error> => {
  const cronJob = FACTORY_ORCHESTRATORS.get(repo);
  if (cronJob === undefined) {
    return new Error(`no orchestrator for ${repo}`);
  }
  try {
    const cj = await k8s.getCronJob(cronJob);
    const template = cj.spec?.jobTemplate;
    if (!template) {
      return new Error("CronJob has no jobTemplate");
    }
    const ts = Date.now().toString(36);
    const jobName = `factory-issue-${issueNum}-${ts}`.slice(0, 63);
    // Inject FACTORY_ISSUE directly to avoid racing GitHub label propagation.
    const spec = structuredClone(template.spec ?? {}) as JobTemplateSpec;
    // Finished Jobs never linger, even if the CronJob template loses its TTL.
    spec.ttlSecondsAfterFinished ??= FACTORY_JOB_TTL_SECONDS;
    const containers = spec.template?.spec?.containers ?? [];
    if (containers[0]) {
      containers[0].env = withEnv(containers[0].env ?? [], {
        FACTORY_ISSUE: String(issueNum),
        FACTORY_PROFILE: profile,
        FACTORY_REPO: repo,
        FACTORY_TRIGGERED_BY: requestedBy,
      });
    }
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        labels: {
          "factory.gwkline.io/issue": String(issueNum),
          "factory.gwkline.io/profile": profile,
          "factory.gwkline.io/repo": repo,
          "factory.gwkline.io/requested-by": requestedBy,
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
  let meta: GhPull;
  try {
    meta = (await ghFetch(`/repos/${repo}/pulls/${pr}`)) as GhPull;
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error, [404]));
  }
  const branchError = notFactoryBranch(pr, meta);
  if (branchError !== null) {
    return c.json({ error: `${branchError} — refusing to review` }, 409);
  }
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

interface GhGraphql {
  data?: {
    markPullRequestReadyForReview?: { pullRequest?: { isDraft?: boolean } };
  };
  errors?: { message?: string }[];
}

// Un-draft a factory PR. REST cannot flip draft; only this GraphQL mutation can.
app.post("/api/factory/ready", async (c) => {
  let body: { repo?: string; pr?: number | string };
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
  let meta: GhPull;
  try {
    meta = (await ghFetch(`/repos/${repo}/pulls/${pr}`)) as GhPull;
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error, [404]));
  }
  const branchError = notFactoryBranch(pr, meta);
  if (branchError !== null) {
    return c.json({ error: `${branchError} — refusing to change it` }, 409);
  }
  if (meta.draft !== true) {
    return c.json({ error: `PR #${pr} is already ready for review` }, 409);
  }
  try {
    const out = (await ghFetch("/graphql", {
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
        variables: { id: meta.node_id },
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })) as GhGraphql;
    const isDraft =
      out.data?.markPullRequestReadyForReview?.pullRequest?.isDraft;
    if (out.errors?.length || isDraft !== false) {
      return c.json(
        {
          error:
            out.errors?.map((e) => e.message).join("; ") ||
            `PR #${pr} is still a draft`,
        },
        502
      );
    }
    return c.json({ isDraft, pr, repo });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error));
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
  const unknown = rejectUnknownFields(body, ["issue", "profile", "repo"]);
  if (unknown !== null) {
    return c.json({ error: unknown }, 400);
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
    return c.json({ error: errMessage(error) }, respondStatus(error));
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

  // GitHub labels are the ledger; the orchestrator polls for factory/queued.
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

  // Trigger the orchestrator now instead of waiting for the next scheduled tick.
  const requestedBy = c.get("caller");
  const trigger = await triggerFactoryJob(repo, profile, issueNum, requestedBy);
  if (typeof trigger !== "string") {
    // Keep the label; the next scheduled tick will pick the issue up.
    return c.json(
      { error: trigger, issue: issueNum, jobName: null, queued: true, repo },
      502
    );
  }
  return c.json(
    {
      issue: issueNum,
      jobName: trigger,
      profile,
      queued: true,
      repo,
      requestedBy,
    },
    201
  );
});

// ── Factory run surface for MCP agents ──────────────────────────────────────
// Contract: deploy/executor/factory-openapi.json (checked by factory-mcp.test.ts).

// Tool: list profiles — admitted profiles, allowlisted repos, and defaults.
app.get("/api/factory/profiles", (c) =>
  c.json({
    defaultProfile: DEFAULT_FACTORY_PROFILE,
    defaultRepo: DEFAULT_FACTORY_REPO,
    profiles: FACTORY_PROFILE_INFO,
    repos: [...FACTORY_REPOS],
  })
);

// Repo allowlist + issue bounds for the run lifecycle routes.
const parseRunTarget = (body: {
  issue?: number | string;
  repo?: string;
}): { error: string; status: 400 } | { issue: number; repo: string } => {
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return {
      error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})`,
      status: 400,
    };
  }
  const issueNum = Number(body.issue);
  if (!Number.isInteger(issueNum) || issueNum < 1 || issueNum > 10_000_000) {
    return { error: "issue must be a positive integer", status: 400 };
  }
  return { issue: issueNum, repo };
};

// Parse the run marker comment: status rows, log tail, report, and PR link.
const parseMarkerBody = (body: string) => {
  const row = (name: string): string | null => {
    const m = new RegExp(
      `^\\|\\s*${name}\\s*\\|\\s*(?<value>[^|]+?)\\s*\\|`,
      "mu"
    ).exec(body);
    return m?.groups?.value ?? null;
  };
  const fence = (summary: string): string | null => {
    const m = new RegExp(
      `<summary>${summary}</summary>\\s*\\n+\`\`\`[a-z]*\\n(?<fence>[\\s\\S]*?)\`\`\``,
      "u"
    ).exec(body);
    return m?.groups?.fence?.trim() ?? null;
  };
  const prMatch = /Draft PR: (?<pr>\S+)/u.exec(body);
  return {
    logTail: fence("log tail"),
    prUrl: prMatch?.groups?.pr ?? null,
    profile: row("Profile"),
    report: fence("worker report"),
    requestedBy: row("Requested by"),
    status: row("Status"),
  };
};

// Maps upstream failures to actionable statuses without leaking GitHub internals.
type IssueFetch =
  | { issue: GhIssue }
  | { error: string; status: 404 | 502 | 504 };
const fetchIssue = async (
  repo: string,
  issueNum: number
): Promise<IssueFetch> => {
  try {
    return {
      issue: (await ghFetch(`/repos/${repo}/issues/${issueNum}`)) as GhIssue,
    };
  } catch (error: unknown) {
    if (errStatus(error) === 404) {
      return { error: `issue #${issueNum} not found in ${repo}`, status: 404 };
    }
    return {
      error: errMessage(error),
      status: errStatus(error) === 504 ? 504 : 502,
    };
  }
};

// The latest run marker comment (created once, edited in place). Read
// failures degrade to label-only state.
const fetchRunMarker = async (
  repo: string,
  issueNum: number
): Promise<{
  marker: GhComment | null;
  parsed: ReturnType<typeof parseMarkerBody> | null;
}> => {
  try {
    const comments = (await ghFetch(
      `/repos/${repo}/issues/${issueNum}/comments?per_page=100`
    )) as GhComment[];
    const marker =
      (comments ?? []).findLast((cm) =>
        cm.body.includes("<!-- factory:run:")
      ) ?? null;
    return { marker, parsed: marker ? parseMarkerBody(marker.body) : null };
  } catch {
    return { marker: null, parsed: null };
  }
};

// Issue numbers repeat across repos, so a run's Jobs match on both. Jobs
// whose repo is unknown belong to no run.
const isRunJob = (j: K8sObject, repo: string, issueNum: number): boolean =>
  j.metadata?.labels?.["factory.gwkline.io/issue"] === String(issueNum) &&
  jobRepo(j) === repo;

const fetchRunJobs = async (
  repo: string,
  issueNum: number
): Promise<{ name: string; status: string }[]> => {
  try {
    const all = await k8s.listJobs();
    return (all.items ?? [])
      .filter((j: K8sObject) => isRunJob(j, repo, issueNum))
      .map((j: K8sObject) => ({
        name: j.metadata?.name ?? "",
        status: viewJob(j).status,
      }));
  } catch {
    // jobs unavailable — comment ledger still answers
    return [];
  }
};

// Tool: get run — ledger labels, the marker comment, and any in-flight Job.
app.get("/api/factory/run", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const issueNum = parseNum(c.req.query("issue"));
  if (issueNum === null) {
    return c.json({ error: "issue must be a positive integer" }, 400);
  }
  const fetched = await fetchIssue(repo, issueNum);
  if ("error" in fetched) {
    return c.json({ error: fetched.error }, fetched.status);
  }
  const { issue } = fetched;
  if (issue.pull_request) {
    return c.json({ error: `issue #${issueNum} is a pull request` }, 404);
  }
  const state = runStateFor(issue);
  if (state === null) {
    return c.json({ error: `no factory run on issue #${issueNum}` }, 404);
  }
  const { marker, parsed } = await fetchRunMarker(repo, issueNum);
  const jobs = await fetchRunJobs(repo, issueNum);
  return c.json({
    artifacts: {
      logTail: parsed?.logTail ?? null,
      pr: parsed?.prUrl ?? null,
      report: parsed?.report ?? null,
      runComment: marker?.html_url ?? null,
    },
    issue: issueNum,
    jobs,
    profile: parsed?.profile ?? null,
    repo,
    requestedBy: parsed?.requestedBy ?? null,
    state,
    title: issue.title,
    url: issue.html_url,
  });
});

// Tool: list runs — open issues carrying a factory/* label.
app.get("/api/factory/runs", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) {
    return c.json(
      { error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` },
      400
    );
  }
  const state = c.req.query("state")?.trim();
  if (
    state !== undefined &&
    state !== "" &&
    !FACTORY_RUN_STATE_NAMES.has(state)
  ) {
    return c.json(
      {
        error: `unknown state (use ${[...FACTORY_RUN_STATE_NAMES].join(", ")})`,
      },
      400
    );
  }
  try {
    const issues = (await ghFetch(
      `/repos/${repo}/issues?state=open&per_page=100`
    )) as GhIssue[];
    const runs = (issues ?? [])
      .filter((i) => !i.pull_request && runStateFor(i) !== null)
      .map((i) => ({
        issue: i.number,
        state: runStateFor(i),
        title: i.title,
        updatedAt: i.updated_at ?? null,
        url: i.html_url,
      }))
      .filter((r) => state === undefined || state === "" || r.state === state);
    return c.json({ repo, runs });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
});

// Label swap shared by cancel/retry. Returns the first failure.
const swapRunLabels = async (
  repo: string,
  issueNum: number,
  from: string[],
  to: string[]
): Promise<string | null> => {
  const removals = await Promise.all(
    from.map(async (label): Promise<string | null> => {
      try {
        await ghFetch(
          `/repos/${repo}/issues/${issueNum}/labels/${encodeURIComponent(label)}`,
          { method: "DELETE" }
        );
        return null;
      } catch (error: unknown) {
        if (errStatus(error) === 404) {
          // label absent — nothing to strip
          return null;
        }
        return `failed to remove label ${label}: ${errMessage(error)}`;
      }
    })
  );
  const removalError = removals.find((r) => r !== null);
  if (removalError !== undefined && removalError !== null) {
    return removalError;
  }
  try {
    await ghFetch(`/repos/${repo}/issues/${issueNum}/labels`, {
      body: JSON.stringify({ labels: to }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch (error: unknown) {
    return `failed to label issue: ${errMessage(error)}`;
  }
  return null;
};

// Best-effort audit comment recording who drove the lifecycle transition.
const auditComment = async (
  repo: string,
  issueNum: number,
  body: string
): Promise<void> => {
  try {
    await ghFetch(`/repos/${repo}/issues/${issueNum}/comments`, {
      body: JSON.stringify({ body }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    // audit comment is best-effort; the label transition is the real ledger
  }
};

const inFlightJobs = async (
  repo: string,
  issueNum: number
): Promise<K8sObject[]> => {
  const all = await k8s.listJobs();
  return (all.items ?? []).filter((j: K8sObject) => {
    if (!isRunJob(j, repo, issueNum)) {
      return false;
    }
    const conditions = j.status?.conditions ?? [];
    const terminal = conditions.some(
      (cond) =>
        (cond.type === "Complete" || cond.type === "Failed") &&
        cond.status === "True"
    );
    return !terminal && (j.status?.active ?? 1) > 0;
  });
};

// Tool: cancel run — label factory/cancelled and stop any in-flight Job.
app.post("/api/factory/run/cancel", async (c) => {
  let body: { issue?: number | string; repo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const unknown = rejectUnknownFields(body, ["issue", "repo"]);
  if (unknown !== null) {
    return c.json({ error: unknown }, 400);
  }
  const target = parseRunTarget(body);
  if ("error" in target) {
    return c.json({ error: target.error }, target.status);
  }
  const requestedBy = c.get("caller");
  const fetched = await fetchIssue(target.repo, target.issue);
  if ("error" in fetched) {
    return c.json({ error: fetched.error }, fetched.status);
  }
  const { issue } = fetched;
  if (issue.pull_request || issue.state !== "open") {
    return c.json({ error: `issue #${target.issue} has no open run` }, 404);
  }
  const state = runStateFor(issue);
  if (state === null) {
    return c.json({ error: `no factory run on issue #${target.issue}` }, 404);
  }
  if (FACTORY_TERMINAL_DONE.has(state)) {
    return c.json(
      {
        error: `run on issue #${target.issue} is ${state} — close the draft PR instead of cancelling`,
      },
      409
    );
  }
  if (!FACTORY_CANCELABLE.has(state)) {
    return c.json(
      { error: `run on issue #${target.issue} is already ${state}` },
      409
    );
  }
  // A failed delete still leaves the label swapped; the next tick converges.
  let stopping: string[] = [];
  try {
    const inFlight = await inFlightJobs(target.repo, target.issue);
    stopping = inFlight.map((j) => j.metadata?.name ?? "");
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error));
  }
  const deletes = await Promise.all(
    stopping.map(async (name): Promise<string | null> => {
      try {
        await k8s.deleteJob(name);
        return null;
      } catch (error: unknown) {
        if (errStatus(error) === 404) {
          // already gone — job finished mid-cancel
          return null;
        }
        return `failed to stop job ${name}: ${errMessage(error)}`;
      }
    })
  );
  const deleteError = deletes.find((d) => d !== null);
  if (deleteError !== undefined && deleteError !== null) {
    return c.json(
      {
        cancelled: false,
        error: deleteError,
        issue: target.issue,
        repo: target.repo,
      },
      502
    );
  }
  const swapError = await swapRunLabels(
    target.repo,
    target.issue,
    FACTORY_ACTIVE_LABELS,
    ["factory/cancelled"]
  );
  if (swapError !== null) {
    return c.json({ error: swapError }, 502);
  }
  await auditComment(
    target.repo,
    target.issue,
    `🛑 Factory Run cancelled (requested by \`${requestedBy}\`).`
  );
  return c.json({
    cancelled: true,
    issue: target.issue,
    jobsStopped: stopping,
    repo: target.repo,
    requestedBy,
  });
});

// Tool: retry run — re-queue a failed/cancelled run, optionally with a new
// profile, and trigger the orchestrator immediately.
app.post("/api/factory/run/retry", async (c) => {
  let body: { issue?: number | string; profile?: string; repo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const unknown = rejectUnknownFields(body, ["issue", "profile", "repo"]);
  if (unknown !== null) {
    return c.json({ error: unknown }, 400);
  }
  const target = parseRunTarget(body);
  if ("error" in target) {
    return c.json({ error: target.error }, target.status);
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
  const requestedBy = c.get("caller");
  const fetched = await fetchIssue(target.repo, target.issue);
  if ("error" in fetched) {
    return c.json({ error: fetched.error }, fetched.status);
  }
  const { issue } = fetched;
  if (issue.pull_request || issue.state !== "open") {
    return c.json({ error: `issue #${target.issue} has no open run` }, 404);
  }
  const state = runStateFor(issue);
  if (state === null) {
    return c.json({ error: `no factory run on issue #${target.issue}` }, 404);
  }
  if (!FACTORY_RETRYABLE.has(state)) {
    return c.json(
      {
        error: `run on issue #${target.issue} is ${state} — only failed or cancelled runs can be retried`,
      },
      409
    );
  }
  const swapError = await swapRunLabels(
    target.repo,
    target.issue,
    FACTORY_FAILED_LABELS,
    ["factory/queued"]
  );
  if (swapError !== null) {
    return c.json({ error: swapError }, 502);
  }
  const trigger = await triggerFactoryJob(
    target.repo,
    profile,
    target.issue,
    requestedBy
  );
  if (typeof trigger !== "string") {
    // Label already applied — the next tick picks the issue up anyway.
    return c.json(
      {
        error: trigger,
        issue: target.issue,
        jobName: null,
        queued: true,
        repo: target.repo,
      },
      502
    );
  }
  await auditComment(
    target.repo,
    target.issue,
    `🔁 Factory Run re-queued (requested by \`${requestedBy}\`).`
  );
  return c.json(
    {
      issue: target.issue,
      jobName: trigger,
      profile,
      queued: true,
      repo: target.repo,
      requestedBy,
    },
    201
  );
});

// CronJob suspend/resume + schedule edit.
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
    if (
      typeof body.schedule !== "string" ||
      !validCronSchedule(body.schedule)
    ) {
      return c.json(
        {
          error:
            "schedule must be five cron fields: minute hour day-of-month month day-of-week",
        },
        400
      );
    }
    patch.spec.schedule = body.schedule.trim().split(/\s+/u).join(" ");
  }
  if (!Object.keys(patch.spec).length) {
    return c.json({ error: "nothing to patch" }, 400);
  }
  try {
    await k8s.patchCronJob(name, patch);
    return c.json({ name, ok: true });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error, [404]));
  }
});

app.delete("/api/jobs/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[\w-]+$/u.test(name)) {
    return c.json({ error: "invalid job name" }, 400);
  }
  try {
    await k8s.deleteJob(name);
    return c.json({ name, ok: true });
  } catch (error: unknown) {
    return c.json({ error: errMessage(error) }, respondStatus(error, [404]));
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

// Non-API paths serve the SPA, with index.html as the client-route fallback.
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
const ports = tailnetPort === null ? [port] : [port, tailnetPort];
const servers = ports.map(
  (p) => serve({ fetch: app.fetch, port: p }) as Server
);
await Promise.all(servers.map((s) => once(s, "listening")));
log("info", `listening on ${ports.join(", ")}`, { ports });

// Well inside the pod's default 30 s termination grace period.
const DRAIN_MS = 10_000;

// SIGTERM: stop accepting connections, let in-flight requests finish, then
// exit. Keep-alive sockets close as soon as they go idle; whatever is still
// open after DRAIN_MS is cut.
const drain = async (): Promise<void> => {
  log("info", "draining", { drainMs: DRAIN_MS });
  const idle = setInterval(() => {
    for (const s of servers) {
      s.closeIdleConnections();
    }
  }, 100);
  const cut = setTimeout(() => {
    for (const s of servers) {
      s.closeAllConnections();
    }
  }, DRAIN_MS);
  await Promise.all(
    servers.map((s) => {
      s.close();
      return once(s, "close");
    })
  );
  clearInterval(idle);
  clearTimeout(cut);
  log("info", "stopped");
  process.exit(0);
};
process.once("SIGTERM", () => {
  void drain();
});
