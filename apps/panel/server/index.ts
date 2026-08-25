import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, api } from "./k8s.js";
import { jobNameFor, jobManifest, viewJob } from "./jobs.js";

const root = process.env.PANEL_ROOT ?? process.cwd();
const app = new Hono();
const k8s = api(loadConfig());

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
