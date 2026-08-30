import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");

test("jobNameFor is dns-1123 safe and deterministic", async () => {
  const { jobNameFor } = await import(path.join(root, "dist", "jobs.js"));
  const a = jobNameFor("node /data/repos/x/check.mjs --flag", 1000);
  const b = jobNameFor("node /data/repos/x/check.mjs --flag", 1000);
  assert.equal(a, b);
  assert.match(a, /^panel-[a-z0-9-]+$/u);
  assert.ok(a.length <= 63, `name too long: ${a.length}`);
  const weird = jobNameFor("!!! @@@ ###", 1000);
  assert.match(weird, /^panel-[a-z0-9-]+$/u);
});

test("jobManifest locks down the container", async () => {
  const { jobManifest } = await import(path.join(root, "dist", "jobs.js"));
  const m = jobManifest({
    command: "echo hi",
    issue: "42",
    name: "panel-test",
  });
  const [c] = m.spec.template.spec.containers;
  assert.equal(m.metadata.namespace, "sandbox");
  assert.equal(c.securityContext.runAsUser, 1000);
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext.capabilities.drop, ["ALL"]);
  assert.equal(m.spec.template.spec.automountServiceAccountToken, false);
  const env = Object.fromEntries(
    c.env.map((e: { name: string; value: string }) => [e.name, e.value])
  );
  assert.equal(env.LOOP_COMMAND, "echo hi");
  assert.equal(env.WATCHER_ISSUE, "42");
});

test("viewJob derives status and issue", async () => {
  const { viewJob } = await import(path.join(root, "dist", "jobs.js"));
  const now = new Date().toISOString();
  const complete = viewJob({
    metadata: { creationTimestamp: now, name: "panel-a" },
    spec: {
      template: {
        spec: {
          containers: [{ env: [{ name: "WATCHER_ISSUE", value: "7" }] }],
        },
      },
    },
    status: { conditions: [{ status: "True", type: "Complete" }] },
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.issue, "7");
  const running = viewJob({
    metadata: { creationTimestamp: now, name: "panel-b" },
    status: { active: 1 },
  });
  assert.equal(running.status, "running");
  const failed = viewJob({
    metadata: { creationTimestamp: now, name: "panel-c" },
    status: { conditions: [{ status: "True", type: "Failed" }] },
  });
  assert.equal(failed.status, "failed");
});

test("GET /api/factory/prs lists open factory PRs with CI + review status", async () => {
  const stage = mkdtempSync(path.join(tmpdir(), "panel-prs-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) {
    copyFileSync(path.join(root, "dist", f), path.join(stage, f));
  }
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );

  // Mock GitHub API server: pull list + per-PR enrichment
  const ghCalls: string[] = [];
  const gh = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    if (req.url === null) {
      throw new Error("no url");
    }
    ghCalls.push(url);
    if (url.startsWith("/repos/gwkline/launchpad/pulls?")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          {
            body: "Closes #6",
            draft: true,
            head: { ref: "factory/issue-6/code-pr", sha: "abc123" },
            html_url: "https://github.com/gwkline/launchpad/pull/8",
            labels: [{ name: "factory/draft-pr" }],
            number: 8,
            state: "open",
            title: "draft one",
          },
          {
            body: "",
            draft: false,
            head: { ref: "feat/manual-thing", sha: "def456" },
            html_url: "https://github.com/gwkline/launchpad/pull/11",
            labels: [],
            number: 11,
            state: "open",
            title: "not a factory pr",
          },
        ])
      );
      return;
    }
    if (url.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          check_runs: [
            { conclusion: "success", name: "validate", status: "completed" },
          ],
          total_count: 1,
        })
      );
      return;
    }
    if (/\/pulls\/\d+\/reviews(?:\?.*)?$/u.test(url)) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify([{ state: "APPROVED", user: { login: "gwkline" } }])
        );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  const ghPort = (gh.address() as AddressInfo).port;

  const port = 3941;
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      GH_API_BASE: `http://127.0.0.1:${ghPort}`,
      GH_TOKEN: "test-token",
      PANEL_K8S_BASE: "http://127.0.0.1:1",
      PANEL_ROOT: stage,
      PORT: String(port),
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("server did not start")),
        5000
      );
      child.stdout.on(
        "data",
        (d) =>
          d.toString().includes("listening") && (clearTimeout(t), resolve())
      );
    });

    const badRepo = await fetch(
      `http://127.0.0.1:${port}/api/factory/prs?repo=evil/repo`
    );
    assert.equal(badRepo.status, 400);

    const r = await fetch(
      `http://127.0.0.1:${port}/api/factory/prs?repo=gwkline/launchpad`
    );
    assert.equal(r.status, 200);
    const j = (await r.json()) as {
      prs: {
        number: number;
        isDraft: boolean;
        headRef: string;
        reviewDecision: string;
        checks: { state: string };
        linkedIssue: number | null;
      }[];
    };
    assert.ok(Array.isArray(j.prs));
    // only factory/* heads are included, manual PRs filtered out
    assert.equal(j.prs.length, 1);
    const [pr] = j.prs;
    assert.ok(pr, "expected one factory PR");
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

test("POST /api/factory/review + /merge guard and forward (write path)", async () => {
  const stage = mkdtempSync(path.join(tmpdir(), "panel-rev-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) {
    copyFileSync(path.join(root, "dist", f), path.join(stage, f));
  }
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );

  interface GhCall {
    body: unknown;
    method: string | undefined;
    url: string | undefined;
  }
  const ghCalls: GhCall[] = [];
  const gh = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      ghCalls.push({
        body: chunks ? JSON.parse(chunks) : null,
        method: req.method,
        url,
      });
      const prMeta = {
        body: "Closes #6",
        draft: false,
        head: { ref: "factory/issue-6/code-pr", sha: "abc123" },
        html_url: "https://github.com/gwkline/launchpad/pull/8",
        labels: [],
        number: 8,
        state: "open",
        title: "draft one",
      };
      if (req.url?.startsWith("/repos/evil")) {
        res.writeHead(404).end('{"message":"Not Found"}');
        return;
      }
      if (url.includes("/check-runs")) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            check_runs: [
              {
                conclusion: "success",
                name: "validate",
                status: "completed",
              },
            ],
            total_count: 1,
          })
        );
        return;
      }
      if (
        url.match(/\/pulls\/\d+\/reviews(?:\?.*)?$/u) &&
        req.method === "GET"
      ) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify([{ state: "APPROVED", user: { login: "gwkline" } }])
          );
        return;
      }
      if (url.match(/\/pulls\/8$/u) && req.method === "GET") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(prMeta));
        return;
      }
      if (url.endsWith("/merge") && req.method === "PUT") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ merged: true, sha: "deadbeef" }));
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ id: 424_242 }));
    });
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  const ghPort = (gh.address() as AddressInfo).port;

  const port = 3951;
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      GH_API_BASE: `http://127.0.0.1:${ghPort}`,
      GH_TOKEN: "test-token",
      PANEL_K8S_BASE: "http://127.0.0.1:1",
      PANEL_ROOT: stage,
      PORT: String(port),
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("server did not start")),
        5000
      );
      child.stdout.on(
        "data",
        (d) =>
          d.toString().includes("listening") && (clearTimeout(t), resolve())
      );
    });
    const base = `http://127.0.0.1:${port}`;

    // validation guards
    assert.equal(
      (
        await fetch(`${base}/api/factory/review`, {
          body: JSON.stringify({ event: "APPROVE", pr: 8, repo: "evil/r" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${base}/api/factory/review`, {
          body: JSON.stringify({
            event: "APPROVE",
            pr: -1,
            repo: "gwkline/launchpad",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(`${base}/api/factory/review`, {
          body: JSON.stringify({
            event: "HACK",
            pr: 8,
            repo: "gwkline/launchpad",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).status,
      400
    );

    // happy path review
    const rv = await fetch(`${base}/api/factory/review`, {
      body: JSON.stringify({
        body: "LGTM via panel",
        event: "APPROVE",
        pr: 8,
        repo: "gwkline/launchpad",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(rv.status, 200);
    const posted = ghCalls.find(
      (c) =>
        c.method === "POST" &&
        c.url === "/repos/gwkline/launchpad/pulls/8/reviews"
    );
    assert.ok(posted, "review POST forwarded to GitHub");
    const postedBody = posted.body as { event: string; body: string };
    assert.equal(postedBody.event, "APPROVE");
    assert.equal(postedBody.body, "LGTM via panel");

    // merge guard: non-factory head must be rejected
    ghCalls.length = 0;
    const badHead = await fetch(`${base}/api/factory/merge`, {
      body: JSON.stringify({
        pr: 999,
        repo: "gwkline/launchpad",
        strategy: "squash",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(badHead.status, 409);

    // happy path merge
    const mg = await fetch(`${base}/api/factory/merge`, {
      body: JSON.stringify({
        pr: 8,
        repo: "gwkline/launchpad",
        strategy: "squash",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(mg.status, 200);
    const merged = (await mg.json()) as { merged: boolean };
    assert.equal(merged.merged, true);
    const putMerge = ghCalls.find(
      (c) =>
        c.method === "PUT" && c.url === "/repos/gwkline/launchpad/pulls/8/merge"
    );
    assert.ok(putMerge, "merge PUT forwarded to GitHub");
    assert.equal(
      (putMerge?.body as { merge_method?: string } | null)?.merge_method,
      "squash"
    );
  } finally {
    child.kill();
    gh.close();
  }
});

test("server serves SPA and proxies k8s with locked-down manifests", async () => {
  const created: unknown[] = [];
  const mock = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    if (req.method === "POST" && req.url?.includes("/jobs")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        created.push(JSON.parse(body));
        res.writeHead(201, { "content-type": "application/json" }).end(body);
      });
      return;
    }
    const fixture = req.url?.includes("cronjobs")
      ? {
          items: [
            {
              metadata: { name: "loop-example" },
              spec: { schedule: "0 9 * * *" },
              status: {},
            },
          ],
        }
      : {
          items: [
            {
              metadata: {
                creationTimestamp: new Date().toISOString(),
                name: "panel-x",
              },
              status: { active: 1 },
            },
          ],
        };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(fixture));
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = (mock.address() as AddressInfo).port;

  const stage = mkdtempSync(path.join(tmpdir(), "panel-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  copyFileSync(
    path.join(root, "dist", "index.js"),
    path.join(stage, "index.js")
  );
  copyFileSync(path.join(root, "dist", "jobs.js"), path.join(stage, "jobs.js"));
  copyFileSync(path.join(root, "dist", "k8s.js"), path.join(stage, "k8s.js"));
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );

  const port = 3931;
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      PANEL_K8S_BASE: `http://127.0.0.1:${mockPort}`,
      PANEL_K8S_TOKEN: "test-token",
      PANEL_ROOT: stage,
      PORT: String(port),
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("server did not start")),
        5000
      );
      child.stdout.on(
        "data",
        (d) =>
          d.toString().includes("listening") && (clearTimeout(t), resolve())
      );
    });

    const state = (await (
      await fetch(`http://127.0.0.1:${port}/api/state`)
    ).json()) as {
      jobs: { name: string; status: string }[];
      cronjobs: { schedule: string }[];
    };
    assert.equal(state.jobs[0]?.name, "panel-x");
    assert.equal(state.jobs[0]?.status, "running");
    assert.equal(state.cronjobs[0]?.schedule, "0 9 * * *");

    const launch = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      body: JSON.stringify({ command: "node check.mjs", issue: "9" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(launch.status, 201);
    assert.equal(created.length, 1);
    const [sent] = created;
    assert.equal(
      (sent as { metadata: { namespace: string } }).metadata.namespace,
      "sandbox"
    );
    const [c] = (
      sent as {
        spec: {
          template: {
            spec: {
              containers: {
                securityContext: { runAsUser: number };
                env: { name: string; value: string }[];
              }[];
            };
          };
        };
      }
    ).spec.template.spec.containers;
    assert.ok(c, "created job has one container");
    assert.equal(c.securityContext.runAsUser, 1000);
    assert.ok(c.env.find((e) => e.name === "WATCHER_ISSUE" && e.value === "9"));

    const bad = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      body: JSON.stringify({ command: "" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(bad.status, 400);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes("homelab factory"));
  } finally {
    child.kill();
    mock.close();
  }
});
