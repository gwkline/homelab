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
const FACTORY_REPOS = new Set(["gwkline/homelab", "gwkline/launchpad"]);
const DEFAULT_FACTORY_REPO = process.env.FACTORY_REPO ?? "gwkline/launchpad";

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

async function ghFetch(path: string, init: RequestInit = {}) {
  const token = ghToken();
  if (!token) throw Object.assign(new Error("GH_TOKEN not configured (mount github-token secret)"), { status: 500 });
  const res = await fetch(`https://api.github.com${path}`, {
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

app.post("/api/factory/run", async (c) => {
  let body: { issue?: number | string; repo?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const repo = (body.repo ?? DEFAULT_FACTORY_REPO).trim();
  if (!FACTORY_REPOS.has(repo)) return c.json({ error: `repo not allowed (use ${[...FACTORY_REPOS].join(", ")})` }, 400);
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
      containers[0].env = [...(containers[0].env ?? []), { name: "FACTORY_ISSUE", value: String(issueNum) }];
    }
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName, namespace: FACTORY_NS, labels: { "factory.gwkline.io/trigger": "panel", "factory.gwkline.io/issue": String(issueNum) } },
      spec,
    };
    await k8s.createJob(job);
  } catch (err: any) {
    // Label already applied — surface the k8s error but don't roll back the label (next tick will pick it up anyway).
    const status = err.status === 409 ? 409 : 502;
    return c.json({ error: err.message, jobName, queued: true, issue: issueNum, repo }, status);
  }

  return c.json({ queued: true, jobName, issue: issueNum, repo }, 201);
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
