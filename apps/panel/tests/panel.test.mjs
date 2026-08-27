import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("jobNameFor is dns-1123 safe and deterministic", async () => {
  const { jobNameFor } = await import(join(root, "dist", "jobs.js"));
  const a = jobNameFor("node /data/repos/x/check.mjs --flag", 1000);
  const b = jobNameFor("node /data/repos/x/check.mjs --flag", 1000);
  assert.equal(a, b);
  assert.match(a, /^panel-[a-z0-9-]+$/);
  assert.ok(a.length <= 63, `name too long: ${a.length}`);
  const weird = jobNameFor("!!! @@@ ###", 1000);
  assert.match(weird, /^panel-[a-z0-9-]+$/);
});

test("jobManifest locks down the container", async () => {
  const { jobManifest } = await import(join(root, "dist", "jobs.js"));
  const m = jobManifest({ name: "panel-test", command: "echo hi", issue: "42" });
  const c = m.spec.template.spec.containers[0];
  assert.equal(m.metadata.namespace, "sandbox");
  assert.equal(c.securityContext.runAsUser, 1000);
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(m.spec.template.spec.automountServiceAccountToken, false);
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.LOOP_COMMAND, "echo hi");
  assert.equal(env.WATCHER_ISSUE, "42");
});

test("viewJob derives status and issue", async () => {
  const { viewJob } = await import(join(root, "dist", "jobs.js"));
  const now = new Date().toISOString();
  const complete = viewJob({
    metadata: { name: "panel-a", creationTimestamp: now },
    status: { conditions: [{ type: "Complete", status: "True" }] },
    spec: { template: { spec: { containers: [{ env: [{ name: "WATCHER_ISSUE", value: "7" }] }] } } },
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.issue, "7");
  const running = viewJob({ metadata: { name: "panel-b", creationTimestamp: now }, status: { active: 1 } });
  assert.equal(running.status, "running");
  const failed = viewJob({
    metadata: { name: "panel-c", creationTimestamp: now },
    status: { conditions: [{ type: "Failed", status: "True" }] },
  });
  assert.equal(failed.status, "failed");
});

test("GET /api/factory/prs lists open factory PRs with CI + review status", async () => {
  const { spawnSync } = await import("node:child_process");
  const stage = mkdtempSync(join(tmpdir(), "panel-prs-"));
  mkdirSync(join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) copyFileSync(join(root, "dist", f), join(stage, f));
  copyFileSync(join(root, "web", "dist", "index.html"), join(stage, "web", "dist", "index.html"));

  // Mock GitHub API server: pull list + per-PR enrichment
  const ghCalls = [];
  const gh = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    ghCalls.push(req.url);
    if (req.url.startsWith("/repos/gwkline/launchpad/pulls?")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
        {
          number: 8, title: "draft one", state: "open", draft: true,
          html_url: "https://github.com/gwkline/launchpad/pull/8",
          head: { ref: "factory/issue-6/code-pr", sha: "abc123" },
          labels: [{ name: "factory/draft-pr" }],
          body: "Closes #6",
        },
        {
          number: 11, title: "not a factory pr", state: "open", draft: false,
          html_url: "https://github.com/gwkline/launchpad/pull/11",
          head: { ref: "feat/manual-thing", sha: "def456" },
          labels: [],
          body: "",
        },
      ]));
      return;
    }
    if (req.url.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ total_count: 1, check_runs: [{ name: "validate", status: "completed", conclusion: "success" }] }));
      return;
    }
    if (req.url.match(/\/pulls\/\d+\/reviews(\?.*)?$/)) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ state: "APPROVED", user: { login: "gwkline" } }]));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise((r) => gh.listen(0, "127.0.0.1", r));
  const ghPort = gh.address().port;

  const port = 3941;
  const child = spawn(process.execPath, [join(stage, "index.js")], {
    env: { ...process.env, PORT: String(port), PANEL_ROOT: stage, PANEL_K8S_BASE: "http://127.0.0.1:1", GH_API_BASE: `http://127.0.0.1:${ghPort}`, GH_TOKEN: "test-token" },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 5000);
      child.stdout.on("data", (d) => d.toString().includes("listening") && (clearTimeout(t), resolve()));
    });

    const badRepo = await fetch(`http://127.0.0.1:${port}/api/factory/prs?repo=evil/repo`);
    assert.equal(badRepo.status, 400);

    const r = await fetch(`http://127.0.0.1:${port}/api/factory/prs?repo=gwkline/launchpad`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.prs));
    // only factory/* heads are included, manual PRs filtered out
    assert.equal(j.prs.length, 1);
    const pr = j.prs[0];
    assert.equal(pr.number, 8);
    assert.equal(pr.isDraft, true);
    assert.equal(pr.headRef, "factory/issue-6/code-pr");
    assert.equal(pr.reviewDecision, "APPROVED");
    assert.equal(pr.checks.state, "success");
    assert.equal(pr.linkedIssue, 6);
  } finally {
    child.kill();
    gh.close();
  }
});

test("server serves SPA and proxies k8s with locked-down manifests", async () => {
  const created = [];
  const mock = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    if (req.method === "POST" && req.url.includes("/jobs")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        created.push(JSON.parse(body));
        res.writeHead(201, { "content-type": "application/json" }).end(body);
      });
      return;
    }
    const fixture = req.url.includes("cronjobs")
      ? { items: [{ metadata: { name: "loop-example" }, spec: { schedule: "0 9 * * *" }, status: {} }] }
      : { items: [{ metadata: { name: "panel-x", creationTimestamp: new Date().toISOString() }, status: { active: 1 } }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fixture));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;

  const stage = mkdtempSync(join(tmpdir(), "panel-"));
  mkdirSync(join(stage, "web", "dist"), { recursive: true });
  copyFileSync(join(root, "dist", "index.js"), join(stage, "index.js"));
  copyFileSync(join(root, "dist", "jobs.js"), join(stage, "jobs.js"));
  copyFileSync(join(root, "dist", "k8s.js"), join(stage, "k8s.js"));
  copyFileSync(join(root, "web", "dist", "index.html"), join(stage, "web", "dist", "index.html"));

  const port = 3931;
  const child = spawn(process.execPath, [join(stage, "index.js")], {
    env: {
      ...process.env,
      PORT: String(port),
      PANEL_ROOT: stage,
      PANEL_K8S_BASE: `http://127.0.0.1:${mockPort}`,
      PANEL_K8S_TOKEN: "test-token",
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 5000);
      child.stdout.on("data", (d) => d.toString().includes("listening") && (clearTimeout(t), resolve()));
    });

    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    assert.equal(state.jobs[0].name, "panel-x");
    assert.equal(state.jobs[0].status, "running");
    assert.equal(state.cronjobs[0].schedule, "0 9 * * *");

    const launch = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "node check.mjs", issue: "9" }),
    });
    assert.equal(launch.status, 201);
    assert.equal(created.length, 1);
    const sent = created[0];
    assert.equal(sent.metadata.namespace, "sandbox");
    const c = sent.spec.template.spec.containers[0];
    assert.equal(c.securityContext.runAsUser, 1000);
    assert.ok(c.env.find((e) => e.name === "WATCHER_ISSUE" && e.value === "9"));

    const bad = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "" }),
    });
    assert.equal(bad.status, 400);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes("homelab factory"));
  } finally {
    child.kill();
    mock.close();
  }
});
