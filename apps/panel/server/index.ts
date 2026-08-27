import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, api } from "./k8s.js";
import { jobNameFor, jobManifest, viewJob } from "./jobs.js";

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

function ghToken(): string | null {
  const direct = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "";
  if (direct) return direct.trim();
  for (const p of ["/secrets/token", "/secrets/github-token", "/var/run/secrets/github-token"]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    } catch {}
  }
  return null;
}

const GH_API_BASE = (process.env.GH_API_BASE ?? "https://api.github.com").replace(/\/$/, "");

async function ghFetch(path: string, init: RequestInit = {}) {
  const token = ghToken();
  if (!token) throw Object.assign(new Error("GH_TOKEN not configured (mount github-token secret)"), { status: 500 });
  const res = await fetch(`${GH_API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {}
  if (!res.ok) {
    const msg = (json as { message?: string } | undefined)?.message ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(msg), { status: res.status, body: json });
  }
  return json;
}

app.get("/api/state", async (c) => {
  try {
    const [jobs, cronjobs] = await Promise.all([k8s.listJobs(), k8s.listCronJobs()]);
    return c.json({
      jobs: (jobs.items ?? []).map(viewJob).sort((a, b) => b.age.localeCompare(a.age)),
      cronjobs: (cronjobs.items ?? []).map((cj: any) => ({
        name: cj.metadata.name,
        schedule: cj.spec.schedule,
        suspended: cj.spec.suspend === true,
        lastScheduled: cj.status?.lastScheduleTime ?? null,
      })),
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// Aggregate view: open issues across ALL factory-eligible repos in one response.
app.get("/api/factory/all-issues", async (c) => {
  const repos = [...FACTORY_REPOS];
  const results = await Promise.allSettled(
    repos.map(async (repo) => {
      const data = (await ghFetch(`/repos/${repo}/issues?state=open&per_page=30`)) as any[];
      return {
        repo,
        issues: data
          .filter((i: any) => !i.pull_request)
          .map((i: any) => ({
            number: i.number,
            title: i.title,
            url: i.html_url,
            labels: (i.labels ?? []).map((l: any) => l.name),
            state: i.state,
          })),
      };
    }),
  );
  const reposOut = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { repo: repos[i], issues: [], error: String((r as PromiseRejectedResult).reason?.message ?? r.reason) },
  );
  return c.json({ repos: reposOut });
});

app.get("/api/factory/issues", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
  try {
    const data = (await ghFetch(`/repos/${repo}/issues?state=open&per_page=50`)) as any[];
    const issues = data
      .filter((i: any) => !i.pull_request)
      .map((i: any) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        labels: (i.labels ?? []).map((l: any) => l.name),
        state: i.state,
      }));
    return c.json({ repo, issues });
  } catch (err: any) {
    return c.json({ error: err.message }, err.status === 401 || err.status === 403 ? 502 : 502);
  }
});

const FACTORY_PR_HEAD_RE = /^factory\/issue-\d+\//;

function checksSummary(checkRuns: any[]): { state: string; conclusion: string | null } {
  // Aggregate check-run conclusions into one green/pending/red verdict.
  if (!checkRuns?.length) return { state: "none", conclusion: null };
  const conclusions = checkRuns.map((c) => c.conclusion ?? c.status ?? "pending");
  const red = ["failure", "timed_out", "action_required", "cancelled", "startup_failure", "stale"];
  const pending = ["pending", "queued", "in_progress", "waiting"];
  if (conclusions.some((x) => red.includes(x))) return { state: "failure", conclusion: "failure" };
  if (conclusions.some((x) => pending.includes(x))) return { state: "pending", conclusion: null };
  const allSuccess = conclusions.every((x) => x === "success" || x === "neutral" || x === "skipped");
  return allSuccess ? { state: "success", conclusion: "success" } : { state: "unknown", conclusion: String(conclusions[0]) };
}

app.get("/api/factory/prs", async (c) => {
  const repo = (c.req.query("repo") ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
  try {
    const pulls = (await ghFetch(`/repos/${repo}/pulls?state=open&per_page=50`)) as any[];
    const factoryPrs = pulls.filter((p: any) => FACTORY_PR_HEAD_RE.test(p.head?.ref ?? ""));
    const prs = await Promise.all(
      factoryPrs.map(async (p: any) => {
        const num = p.number;
        let checkState: string | null = null;
        let reviewDecision: string = "PENDING";
        try {
          const cr = (await ghFetch(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100`)) as any;
          checkState = checksSummary(cr.check_runs ?? []).state;
        } catch {}
        try {
          const reviews = (await ghFetch(`/repos/${repo}/pulls/${num}/reviews?per_page=100`)) as any[];
          if ((reviews ?? []).some((r) => r.state === "CHANGES_REQUESTED")) reviewDecision = "CHANGES_REQUESTED";
          else if ((reviews ?? []).some((r) => r.state === "APPROVED")) reviewDecision = "APPROVED";
        } catch {}
        const m = /factory\/issue-(\d+)\//.exec(p.head.ref);
        return {
          number: num,
          title: p.title,
          headRef: p.head.ref,
          url: p.html_url,
          isDraft: p.draft === true,
          reviewDecision,
          state: p.state,
          checks: checkState ? { state: checkState } : { state: "none" },
          labels: (p.labels ?? []).map((l: any) => l.name),
          linkedIssue: m ? Number(m[1]) : null,
        };
      }),
    );
    prs.sort((a, b) => a.number - b.number);
    return c.json({ repo, prs });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

const FACTORY_REVIEW_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const FACTORY_MERGE_STRATEGIES = new Set(["squash", "merge", "rebase"]);

function parseNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : null;
}

app.post("/api/factory/review", async (c) => {
  let body: { repo?: string; pr?: number | string; event?: string; body?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
  const pr = parseNum(body.pr);
  if (pr == null) return c.json({ error: "pr must be a positive integer" }, 400);
  const event = String(body.event ?? "").trim();
  if (!FACTORY_REVIEW_EVENTS.has(event)) return c.json({ error: `event must be one of ${[...FACTORY_REVIEW_EVENTS].join(", ")}` }, 400);
  const reviewBody = typeof body.body === "string" && body.body.trim() ? body.body.trim().slice(0, 4000) : undefined;
  try {
    const review = await ghFetch(`/repos/${repo}/pulls/${pr}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewBody ? { event, body: reviewBody } : { event }),
    });
    const r = review as any;
    return c.json({ id: r?.id ?? null, state: r?.state ?? null, pr, repo, event });
  } catch (err: any) {
    return c.json({ error: err.message }, err.status === 404 || err.status === 422 ? 404 : 502);
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
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
  const pr = parseNum(body.pr);
  if (pr == null) return c.json({ error: "pr must be a positive integer" }, 400);
  const strategy = FACTORY_MERGE_STRATEGIES.has(body.strategy ?? "") ? body.strategy! : "squash";

  // Guard: only merge factory-generated PRs with green checks + approval.
  let meta: any;
  try {
    meta = await ghFetch(`/repos/${repo}/pulls/${pr}`);
  } catch (err: any) {
    return c.json({ error: err.message }, err.status === 404 ? 404 : 502);
  }
  if (!FACTORY_PR_HEAD_RE.test(meta.head?.ref ?? "")) {
    return c.json({ error: `PR #${pr} head '${meta.head?.ref}' is not a factory branch — refusing to merge` }, 409);
  }
  if (meta.draft === true) {
    return c.json({ error: `PR #${pr} is still a draft` }, 409);
  }
  if ((meta.mergeable_state ?? "").includes("blocked") && !(meta.mergeable === true)) {
    // fallthrough: attempt anyway only when mergeable is explicitly true
    return c.json({ error: `PR #${pr} is blocked (branch protection or failing checks)` }, 409);
  }
  try {
    const cr = (await ghFetch(`/repos/${repo}/commits/${meta.head.sha}/check-runs?per_page=100`)) as any;
    if (checksSummary(cr.check_runs ?? []).state !== "success") {
      return c.json({ error: `PR #${pr} checks are not green — refusing to merge` }, 409);
    }
    const reviews = (await ghFetch(`/repos/${repo}/pulls/${pr}/reviews?per_page=100`)) as any[];
    const approved = (reviews ?? []).some((r) => r.state === "APPROVED");
    if (!approved) {
      return c.json({ error: `PR #${pr} has no approving review — approve it first` }, 409);
    }
  } catch (err: any) {
    return c.json({ error: `guard check failed: ${err.message}` }, 502);
  }

  try {
    const res = await ghFetch(`/repos/${repo}/pulls/${pr}/merge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merge_method: strategy,
        commit_title: `feat(factory): ${meta.title} (#${pr})`.slice(0, 200),
      }),
    });
    const m = res as any;
    return c.json({ merged: m?.merged === true, sha: m?.sha ?? null, pr, repo, strategy });
  } catch (err: any) {
    return c.json({ error: err.message }, err.status === 405 || err.status === 409 ? 409 : 502);
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
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
  const profile = (body.profile ?? DEFAULT_FACTORY_PROFILE).trim();
  if (!FACTORY_PROFILES.has(profile)) return c.json({ error: `profile not allowed (use ${[...FACTORY_PROFILES].join(", ")})` }, 400);
  const issueNum = Number(body.issue);
  if (!Number.isInteger(issueNum) || issueNum < 1 || issueNum > 10_000_000) return c.json({ error: "issue must be a positive integer" }, 400);

  let issue: any;
  try {
    issue = await ghFetch(`/repos/${repo}/issues/${issueNum}`);
  } catch (err: any) {
    if (err.status === 404) return c.json({ error: `issue #${issueNum} not found in ${repo}` }, 404);
    return c.json({ error: err.message }, 502);
  }
  if (issue.pull_request) return c.json({ error: `issue #${issueNum} is a pull request` }, 400);
  if (issue.state !== "open") return c.json({ error: `issue #${issueNum} is ${issue.state}` }, 409);
  const labels: string[] = (issue.labels ?? []).map((l: any) => l.name);
  const has = (name: string) => labels.includes(name);
  if (has("factory/queued")) return c.json({ error: `issue #${issueNum} is already queued` }, 409);
  if (has("factory/in-progress")) return c.json({ error: `issue #${issueNum} is already in-progress` }, 409);
  if (has("factory/draft-pr")) return c.json({ error: `issue #${issueNum} already has a draft PR` }, 409);

  // 1. Label it queued (GitHub is the ledger — orchestrator polls this label)
  try {
    await ghFetch(`/repos/${repo}/issues/${issueNum}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: ["factory/queued"] }),
    });
  } catch (err: any) {
    return c.json({ error: `failed to label issue: ${err.message}` }, 502);
  }

  // 2. Immediately trigger the orchestrator (create Job from CronJob), so the user doesn't wait 6h.
  // The CronJob's Job-from-CronJob run is the same path as the scheduled tick, just ad-hoc.
  let jobName: string | null = null;
  try {
    const cj = await k8s.getCronJob(FACTORY_CRONJOB);
    const template = (cj as any).spec?.jobTemplate;
    if (!template) throw new Error("CronJob has no jobTemplate");
    const ts = Date.now().toString(36);
    jobName = `factory-issue-${issueNum}-${ts}`.slice(0, 63);
    // Clone the template so we can inject FACTORY_ISSUE (avoids GH label propagation race)
    const spec = JSON.parse(JSON.stringify(template.spec));
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
      metadata: { name: jobName, namespace: FACTORY_NS, labels: { "factory.gwkline.io/trigger": "panel", "factory.gwkline.io/issue": String(issueNum), "factory.gwkline.io/profile": profile, "factory.gwkline.io/repo": repo } },
      spec,
    };
    await k8s.createJob(job);
  } catch (err: any) {
    // Label already applied — surface the k8s error but don't roll back the label (next tick will pick it up anyway).
    const status = err.status === 409 ? 409 : 502;
    return c.json({ error: err.message, jobName, queued: true, issue: issueNum, repo }, status);
  }

  return c.json({ queued: true, jobName, issue: issueNum, repo, profile }, 201);
});

app.post("/api/jobs", async (c) => {
  let body: { command?: string; issue?: string; repo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const command = body.command?.trim();
  if (!command) return c.json({ error: "command is required" }, 400);
  if (command.length > 2000) return c.json({ error: "command too long" }, 400);
  const issue = body.issue !== undefined ? String(body.issue) : undefined;
  if (issue !== undefined && !/^\d{1,7}$/.test(issue)) {
    return c.json({ error: "issue must be a number" }, 400);
  }
  const name = jobNameFor(command);
  try {
    await k8s.createJob(jobManifest({ name, command, issue, repo: body.repo }));
    return c.json({ name }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, err.status === 409 ? 409 : 502);
  }
});

const web = join(root, "web", "dist");
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/")) return next();
  try {
    const rel = c.req.path === "/" ? "index.html" : c.req.path.slice(1);
    const file = readFileSync(join(web, rel));
    const type = rel.endsWith(".js") ? "text/javascript"
      : rel.endsWith(".css") ? "text/css"
      : rel.endsWith(".svg") ? "image/svg+xml"
      : "text/html";
    return c.body(file, 200, { "content-type": type });
  } catch {
    return c.body(readFileSync(join(web, "index.html")), 200, { "content-type": "text/html" });
  }
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`[panel] listening on ${port}`));
