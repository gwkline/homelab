// Contract + integration tests for the factory operations surface exposed
// through Executor MCP (#84). The OpenAPI contract lives in
// deploy/executor/factory-openapi.json; these tests keep spec and server
// honest and cover the lifecycle: denied, approval-required (policy class),
// idempotent, and successful calls, plus caller/run identity preservation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const repoRoot = path.join(root, "..", "..");

const readSpec = (): {
  paths: Record<
    string,
    Record<string, { operationId?: string; "x-factory-policy"?: string }>
  >;
  components: { schemas: Record<string, Record<string, unknown>> };
  servers: { url: string }[];
} =>
  JSON.parse(
    readFileSync(
      path.join(repoRoot, "deploy", "executor", "factory-openapi.json"),
      "utf-8"
    )
  );

const OPS: [string, string][] = [
  ["/api/factory/profiles", "get"],
  ["/api/factory/run", "get"],
  ["/api/factory/run", "post"],
  ["/api/factory/runs", "get"],
  ["/api/factory/run/cancel", "post"],
  ["/api/factory/run/retry", "post"],
];

test("factory OpenAPI contract: policy classes, strict bodies, no k8s surface", () => {
  const spec = readSpec();
  // Every factory operation carries an explicit policy class: reads are
  // policy-allowed, mutations are approval-required (Executor gates them).
  const mutating = new Set(["post", "delete", "put", "patch"]);
  for (const [route, method] of OPS) {
    const op = spec.paths[route]?.[method];
    assert.ok(op, `spec must describe ${method.toUpperCase()} ${route}`);
    assert.ok(op.operationId, `${route} ${method} has operationId`);
    if (mutating.has(method)) {
      assert.equal(
        op["x-factory-policy"],
        "approval-required",
        `${op.operationId} must be approval-required`
      );
    } else {
      assert.equal(
        op["x-factory-policy"],
        "read",
        `${op.operationId} must be policy-allowed read`
      );
    }
  }
  // Request bodies are closed: only (repo, issue, profile) exist — never raw
  // Kubernetes fields or profile overrides.
  for (const schemaName of ["CreateRun", "RetryRun", "RunTarget"]) {
    const s = spec.components.schemas[schemaName];
    assert.ok(s, `${schemaName} exists`);
    assert.equal(s.additionalProperties, false, `${schemaName} is strict`);
    assert.ok(
      Object.keys(s.properties ?? {}).every((k) =>
        ["repo", "issue", "profile"].includes(k)
      ),
      `${schemaName} has only factory inputs`
    );
    assert.ok(s.required, `${schemaName} requires the issue target`);
  }
  // Profile is a closed enum shared by create and retry.
  const profile = spec.components.schemas.ProfileName;
  assert.ok(profile, "ProfileName schema exists");
  assert.deepEqual(profile.enum, ["code-pr", "security"]);
  // The spec points Executor at the in-cluster panel service, not any public host.
  const [server] = spec.servers;
  assert.ok(server, "spec declares a server");
  assert.match(server.url, /^http:\/\/panel-http\.agents\.svc:3000$/u);
});

// Mock-server helpers shared by the in-memory GitHub (module scope so they
// are not recreated per request).
const readBody = (req: IncomingMessage): Promise<string> => {
  let b = "";
  req.on("data", (c) => (b += c));
  return new Promise((r) => req.on("end", () => r(b)));
};
const json = (res: ServerResponse, payload: unknown): void => {
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(payload));
};

test("factory MCP surface: denied, idempotent, and successful lifecycle", async () => {
  // ── In-memory GitHub (stateful enough for idempotency + audit checks) ──
  interface GhIssue {
    html_url: string;
    labels: { name: string }[];
    number: number;
    pull_request?: unknown;
    state: string;
    title: string;
    updated_at: string;
  }
  const state = {
    comments: new Map<string, { body: string; html_url: string }[]>(),
    ghWrites: [] as string[],
    issues: new Map<string, GhIssue>(),
    jobEnv: [] as Record<string, string>[],
    jobLabels: [] as Record<string, string>[],
    jobNames: [] as string[],
    jobsDeleted: [] as string[],
  };
  const issue = (
    repo: string,
    n: number,
    labelNames: string[],
    extra?: Partial<GhIssue>
  ): void => {
    state.issues.set(`${repo}/${n}`, {
      html_url: `https://github.com/${repo}/issues/${n}`,
      labels: labelNames.map((name) => ({ name })),
      number: n,
      state: "open",
      title: `fixture ${n}`,
      updated_at: new Date().toISOString(),
      ...extra,
    });
    state.comments.set(`${repo}/${n}`, []);
  };
  issue("gwkline/launchpad", 6, ["factory/in-progress"]);
  issue("gwkline/launchpad", 7, []);
  state.comments.set("gwkline/launchpad/6", [
    {
      body: [
        "<!-- factory:run:6:2026-09-05T00:00:00Z -->",
        "## 🏭 Factory Run",
        "",
        "| | |",
        "|---|---|",
        "| Status | running |",
        "| Started | 2026-09-05T00:00:00Z |",
        "| Requested by | hermes |",
        "| Profile | code-pr |",
        "| Workflow | code-pr@v1 (worker-img) |",
        "",
        "_Job `factory-issue-6-x` running._",
      ].join("\n"),
      html_url: "https://github.com/gwkline/launchpad/issues/6#issuecomment-1",
    },
  ]);
  issue("gwkline/launchpad", 8, ["factory/draft-pr"]);
  issue("gwkline/launchpad", 9, ["factory/queued"]);
  issue("gwkline/launchpad", 10, ["factory/failed"]);
  issue("gwkline/launchpad", 11, ["factory/in-progress"]);
  issue("gwkline/launchpad", 12, []);
  issue("gwkline/launchpad", 13, []);
  const findIssue = (repo: string, n: number) =>
    state.issues.get(`${repo}/${n}`);

  // Ledger mutations: DELETE label, POST labels, POST comment.
  const handleGhWrite = (
    req: IncomingMessage,
    res: ServerResponse,
    url: string
  ): boolean => {
    const mLabel =
      /\/repos\/(?<owner>[^/]+)\/(?<name>[^/]+)\/issues\/(?<num>\d+)\/labels\/(?<label>.+)$/u.exec(
        url
      );
    if (req.method === "DELETE" && mLabel) {
      const label = decodeURIComponent(mLabel.groups?.label ?? "");
      const i = findIssue(
        `${mLabel.groups?.owner}/${mLabel.groups?.name}`,
        Number(mLabel.groups?.num)
      );
      assert.ok(i);
      state.ghWrites.push(`delete-label:${label}`);
      i.labels = i.labels.filter((l) => l.name !== label);
      res.writeHead(200).end("{}");
      return true;
    }
    const mLabels =
      /\/repos\/(?<owner>[^/]+)\/(?<name>[^/]+)\/issues\/(?<num>\d+)\/labels$/u.exec(
        url
      );
    if (req.method === "POST" && mLabels) {
      void readBody(req).then((b) => {
        const { name, num, owner } = mLabels.groups ?? {};
        const added = (JSON.parse(b).labels ?? []) as string[];
        state.ghWrites.push(`add-labels:${added.join(",")}`);
        const i = findIssue(`${owner}/${name}`, Number(num));
        assert.ok(i);
        for (const labelName of added) {
          i.labels.push({ name: labelName });
        }
        res.writeHead(200).end("{}");
      });
      return true;
    }
    const mComment =
      /\/repos\/(?<owner>[^/]+)\/(?<name>[^/]+)\/issues\/(?<num>\d+)\/comments$/u.exec(
        url
      );
    if (req.method === "POST" && mComment) {
      void readBody(req).then((b) => {
        const { name, num, owner } = mComment.groups ?? {};
        const comment = {
          body: JSON.parse(b).body as string,
          html_url: `https://github.com/${owner}/${name}/issues/${num}#issuecomment-9`,
        };
        state.comments.get(`${owner}/${name}/${num}`)?.push(comment);
        res.writeHead(201).end(JSON.stringify(comment));
      });
      return true;
    }
    return false;
  };
  // Ledger reads: comments, single issue, issue list.
  const handleGhRead = (
    req: IncomingMessage,
    res: ServerResponse,
    url: string
  ): boolean => {
    const mComments =
      /\/repos\/(?<owner>[^/]+)\/(?<name>[^/]+)\/issues\/(?<num>\d+)\/comments\?/u.exec(
        url
      );
    if (req.method === "GET" && mComments) {
      const { name, num, owner } = mComments.groups ?? {};
      json(res, state.comments.get(`${owner}/${name}/${num}`) ?? []);
      return true;
    }
    const mIssue =
      /\/repos\/(?<owner>[^/]+)\/(?<name>[^/]+)\/issues\/(?<num>\d+)$/u.exec(
        url
      );
    if (req.method === "GET" && mIssue) {
      const { name, num, owner } = mIssue.groups ?? {};
      const i = findIssue(`${owner}/${name}`, Number(num));
      if (!i) {
        res.writeHead(404).end('{"message":"Not Found"}');
        return true;
      }
      json(res, i);
      return true;
    }
    if (req.method === "GET" && /\/issues\?/u.test(url)) {
      json(res, [...state.issues.values()]);
      return true;
    }
    return false;
  };
  const gh = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    if (handleGhWrite(req, res, url) || handleGhRead(req, res, url)) {
      return;
    }
    json(res, {});
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  const ghPort = (gh.address() as AddressInfo).port;

  // ── Mock Kubernetes API: cronjob template + job create/list/delete ──
  const created: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const seedJobs = [
    {
      metadata: {
        creationTimestamp: new Date().toISOString(),
        labels: { "factory.gwkline.io/issue": "6" },
        name: "factory-issue-6-old",
      },
      status: { active: 1 },
    },
    {
      metadata: {
        creationTimestamp: new Date().toISOString(),
        labels: { "factory.gwkline.io/issue": "9" },
        name: "factory-issue-9-live",
      },
      status: { active: 1 },
    },
  ];
  const k8sMock = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.includes("/cronjobs/")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          spec: {
            jobTemplate: {
              spec: {
                template: {
                  spec: {
                    containers: [
                      { env: [{ name: "FACTORY_REPO", value: "seed" }] },
                    ],
                  },
                },
              },
            },
          },
        })
      );
      return;
    }
    if (req.method === "POST" && url.endsWith("/jobs")) {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        const j = JSON.parse(b) as Record<string, unknown>;
        created.push(j);
        res.writeHead(201).end(b);
      });
      return;
    }
    if (req.method === "DELETE" && url.includes("/jobs/")) {
      const name = decodeURIComponent(url.split("/jobs/")[1] ?? "");
      deleted.push(name);
      res.writeHead(200).end("{}");
      return;
    }
    if (req.method === "GET" && url.endsWith("/jobs")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          items: [
            ...seedJobs,
            ...created.map((j) => ({
              metadata: {
                creationTimestamp: new Date().toISOString(),
                ...(j.metadata as object),
              },
              status: { active: 1 },
            })),
          ],
        })
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => k8sMock.listen(0, "127.0.0.1", r));
  const k8sPort = (k8sMock.address() as AddressInfo).port;

  const stage = mkdtempSync(path.join(tmpdir(), "panel-factory-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) {
    copyFileSync(path.join(root, "dist", f), path.join(stage, f));
  }
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );
  const port = 3951;
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      // Hermetic defaults: the hosting pod may inject FACTORY_REPO/PROFILE.
      FACTORY_PROFILE: "code-pr",
      FACTORY_REPO: "gwkline/launchpad",
      GH_API_BASE: `http://127.0.0.1:${ghPort}`,
      GH_TOKEN: "test-token",
      PANEL_K8S_BASE: `http://127.0.0.1:${k8sPort}`,
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

    // ── Contract: every spec operation exists on the server (route probing) ──
    const profiles = await fetch(`${base}/api/factory/profiles`);
    assert.equal(profiles.status, 200);
    const profilesBody = (await profiles.json()) as {
      profiles: { name: string }[];
      repos: string[];
      defaultProfile: string;
      defaultRepo: string;
    };
    assert.deepEqual(
      profilesBody.profiles.map((p) => p.name),
      ["code-pr", "security"]
    );
    assert.ok(profilesBody.repos.includes("gwkline/launchpad"));

    // ── Denied: unknown profile / repo / smuggled k8s fields ──
    const badProfile = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({ issue: 6, profile: "bash-1" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(badProfile.status, 400);
    assert.match(
      ((await badProfile.json()) as { error: string }).error,
      /profile not allowed/u
    );

    const k8sSmuggle = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({
        image: "evil",
        issue: 6,
        serviceAccountName: "evil",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(k8sSmuggle.status, 400);
    assert.match(
      ((await k8sSmuggle.json()) as { error: string }).error,
      /unknown fields/u
    );

    const badRepo = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({ issue: 6, repo: "evil/repo" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(badRepo.status, 400);

    // ── Success: create run (approval-required policy class; identity rides
    // the host-side header, never the tool arguments) ──
    const create = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({ issue: 7, repo: "gwkline/launchpad" }),
      headers: {
        "content-type": "application/json",
        "x-factory-requested-by": "hermes",
      },
      method: "POST",
    });
    if (create.status !== 201) {
      console.error("create debug:", await create.clone().text());
    }
    assert.equal(create.status, 201);
    const createBody = (await create.json()) as {
      jobName: string;
      queued: boolean;
      requestedBy: string;
    };
    assert.equal(createBody.queued, true);
    assert.equal(createBody.requestedBy, "hermes");
    assert.ok(createBody.jobName);
    // Issue now carries factory/queued (stateful mock), job has the identity.
    assert.ok(
      findIssue("gwkline/launchpad", 7)?.labels.some(
        (l) => l.name === "factory/queued"
      )
    );
    const job = created.at(-1) as {
      metadata: { labels: Record<string, string> };
      spec: {
        template: {
          spec: { containers: { env: { name: string; value: string }[] }[] };
        };
      };
    };
    assert.ok(job);
    const env = Object.fromEntries(
      (job.spec.template.spec.containers[0]?.env ?? []).map((e) => [
        e.name,
        e.value,
      ])
    );
    assert.equal(env.FACTORY_TRIGGERED_BY, "hermes");
    assert.equal(
      job.metadata.labels["factory.gwkline.io/requested-by"],
      "hermes"
    );
    assert.equal(job.metadata.labels["factory.gwkline.io/issue"], "7");

    // ── Idempotent: same call now refused with the actionable state ──
    const jobsBefore = created.length;
    const again = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({ issue: 7, repo: "gwkline/launchpad" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(again.status, 409);
    assert.match(
      ((await again.json()) as { error: string }).error,
      /already queued/u
    );
    assert.equal(
      created.length,
      jobsBefore,
      "no duplicate Job on idempotent refusal"
    );
    // Direct panel call without the Executor header records as panel.
    const selfCreate = await fetch(`${base}/api/factory/run`, {
      body: JSON.stringify({ issue: 12 }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(selfCreate.status, 201);
    assert.equal(
      ((await selfCreate.json()) as { requestedBy: string }).requestedBy,
      "panel"
    );

    // ── Get run: ledger state + audit comment parse + artifacts ──
    const run = await fetch(
      `${base}/api/factory/run?repo=gwkline/launchpad&issue=6`
    );
    assert.equal(run.status, 200);
    const runBody = (await run.json()) as {
      artifacts: {
        logTail: string | null;
        pr: string | null;
        runComment: string | null;
      };
      issue: number;
      jobs: { name: string }[];
      profile: string | null;
      requestedBy: string | null;
      state: string;
    };
    assert.equal(runBody.issue, 6);
    assert.equal(runBody.state, "running");
    assert.equal(runBody.profile, "code-pr");
    assert.equal(runBody.requestedBy, "hermes");
    assert.equal(
      runBody.artifacts.runComment,
      "https://github.com/gwkline/launchpad/issues/6#issuecomment-1"
    );
    assert.deepEqual(
      runBody.jobs.map((j) => j.name),
      ["factory-issue-6-old"]
    );

    const noRun = await fetch(
      `${base}/api/factory/run?repo=gwkline/launchpad&issue=8`
    );
    // draft-pr is a valid run state
    assert.ok(noRun.status === 200);
    // Issue 13 exists but carries no factory ledger label.
    const noRunIssue = await fetch(
      `${base}/api/factory/run?repo=gwkline/launchpad&issue=13`
    );
    assert.equal(noRunIssue.status, 404);
    const missingIssue = await fetch(
      `${base}/api/factory/run?repo=gwkline/launchpad&issue=999`
    );
    assert.equal(missingIssue.status, 404);

    // ── List runs + state filter ──
    const list = await fetch(`${base}/api/factory/runs?repo=gwkline/launchpad`);
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as {
      runs: { issue: number; state: string }[];
    };
    assert.ok(listBody.runs.length >= 5);
    assert.ok(
      listBody.runs.some((r) => r.issue === 10 && r.state === "failed")
    );
    const badState = await fetch(
      `${base}/api/factory/runs?repo=gwkline/launchpad&state=bogus`
    );
    assert.equal(badState.status, 400);
    const filtered = await fetch(
      `${base}/api/factory/runs?repo=gwkline/launchpad&state=failed`
    );
    const filteredBody = (await filtered.json()) as {
      runs: { issue: number }[];
    };
    assert.deepEqual(
      filteredBody.runs.map((r) => r.issue),
      [10]
    );

    // ── Cancel: success (queued → cancelled, in-flight job stopped, audit) ──
    const cancel = await fetch(`${base}/api/factory/run/cancel`, {
      body: JSON.stringify({ issue: 9, repo: "gwkline/launchpad" }),
      headers: {
        "content-type": "application/json",
        "x-factory-requested-by": "hermes",
      },
      method: "POST",
    });
    assert.equal(cancel.status, 200);
    const cancelBody = (await cancel.json()) as {
      cancelled: boolean;
      issue: number;
      jobsStopped: string[];
      requestedBy: string;
    };
    assert.equal(cancelBody.cancelled, true);
    assert.deepEqual(cancelBody.jobsStopped, ["factory-issue-9-live"]);
    assert.equal(cancelBody.requestedBy, "hermes");
    assert.ok(deleted.includes("factory-issue-9-live"));
    const i9 = findIssue("gwkline/launchpad", 9);
    assert.ok(i9?.labels.some((l) => l.name === "factory/cancelled"));
    assert.ok(!i9?.labels.some((l) => l.name === "factory/queued"));
    const audit = state.comments.get("gwkline/launchpad/9")?.at(-1)?.body ?? "";
    assert.match(audit, /cancelled \(requested by `hermes`/u);

    // ── Cancel refusals: published run + unknown run ──
    const cancelDone = await fetch(`${base}/api/factory/run/cancel`, {
      body: JSON.stringify({ issue: 8, repo: "gwkline/launchpad" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(cancelDone.status, 409);
    assert.match(
      ((await cancelDone.json()) as { error: string }).error,
      /close the draft PR/u
    );
    const cancelNone = await fetch(`${base}/api/factory/run/cancel`, {
      body: JSON.stringify({ issue: 999, repo: "gwkline/launchpad" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(cancelNone.status, 404);

    // ── Retry: success on failed run; refusal on running run; denied profile ──
    const retry = await fetch(`${base}/api/factory/run/retry`, {
      body: JSON.stringify({
        issue: 10,
        profile: "security",
        repo: "gwkline/launchpad",
      }),
      headers: {
        "content-type": "application/json",
        "x-factory-requested-by": "t3code",
      },
      method: "POST",
    });
    assert.equal(retry.status, 201);
    const retryBody = (await retry.json()) as {
      jobName: string;
      requestedBy: string;
    };
    assert.equal(retryBody.requestedBy, "t3code");
    assert.ok(
      findIssue("gwkline/launchpad", 10)?.labels.some(
        (l) => l.name === "factory/queued"
      )
    );
    const retryJob = created.at(-1) as {
      metadata: { labels: Record<string, string> };
    };
    assert.equal(
      retryJob.metadata.labels["factory.gwkline.io/requested-by"],
      "t3code"
    );
    assert.equal(
      retryJob.metadata.labels["factory.gwkline.io/profile"],
      "security"
    );
    assert.match(
      state.comments.get("gwkline/launchpad/10")?.at(-1)?.body ?? "",
      /re-queued \(requested by `t3code`/u
    );
    const retryRunning = await fetch(`${base}/api/factory/run/retry`, {
      body: JSON.stringify({ issue: 11, repo: "gwkline/launchpad" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(retryRunning.status, 409);
    assert.match(
      ((await retryRunning.json()) as { error: string }).error,
      /is running .* can be retried/u
    );
    const retryBadProfile = await fetch(`${base}/api/factory/run/retry`, {
      body: JSON.stringify({ issue: 10, profile: "bash-1" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(retryBadProfile.status, 400);

    // ── Malformed bodies are denied, not crashing ──
    const badJson = await fetch(`${base}/api/factory/run/cancel`, {
      body: "not-json",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(badJson.status, 400);
    const noIssue = await fetch(`${base}/api/factory/run/retry`, {
      body: JSON.stringify({ repo: "gwkline/launchpad" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(noIssue.status, 400);
  } finally {
    child.kill();
    gh.close();
    k8sMock.close();
  }
});
