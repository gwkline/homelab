// Mutating routes: cross-site refusal, content type, caller identity.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { ALLOWED_LOGIN, freePort, jsonAs, startPanel } from "./helpers.ts";

const REPO = "gwkline/launchpad";

const MUTATIONS: { body: unknown; method: string; route: string }[] = [
  {
    body: { event: "APPROVE", pr: 8, repo: REPO },
    method: "POST",
    route: "/api/factory/review",
  },
  { body: { pr: 8, repo: REPO }, method: "POST", route: "/api/factory/merge" },
  { body: { issue: 7, repo: REPO }, method: "POST", route: "/api/factory/run" },
  {
    body: { issue: 7, repo: REPO },
    method: "POST",
    route: "/api/factory/run/cancel",
  },
  {
    body: { issue: 7, repo: REPO },
    method: "POST",
    route: "/api/factory/run/retry",
  },
  {
    body: { sourceId: "homelab-docs" },
    method: "POST",
    route: "/api/knowledge/sync",
  },
  { body: { query: "x" }, method: "POST", route: "/api/knowledge/search" },
  {
    body: { suspended: true },
    method: "PATCH",
    route: "/api/cronjobs/factory-orchestrator",
  },
  { body: {}, method: "DELETE", route: "/api/jobs/factory-issue-7-x" },
];

type Mutation = (typeof MUTATIONS)[number];

const send = async (
  base: string,
  m: Mutation,
  headers: Record<string, string>
): Promise<number> =>
  (
    await fetch(`${base}${m.route}`, {
      body: JSON.stringify(m.body),
      headers,
      method: m.method,
    })
  ).status;

const portOf = (server: Server): number =>
  (server.address() as AddressInfo).port;

// The headers a tailnet browser arrives with after the Tailscale proxy.
const browser = (
  site: string,
  extra: Record<string, string> = {}
): Record<string, string> => ({
  "content-type": "application/json",
  "sec-fetch-site": site,
  "tailscale-user-login": ALLOWED_LOGIN,
  ...extra,
});

test("mutating routes refuse cross-site and anonymous callers", async () => {
  // Every upstream records its calls; refused requests must not reach any.
  const upstream: string[] = [];
  const created: { metadata: { labels: Record<string, string> } }[] = [];
  const issueLabels: string[] = [];
  const gh = createServer((req, res) => {
    upstream.push(`gh ${req.method} ${req.url}`);
    const url = req.url ?? "";
    if (req.method === "GET" && url === `/repos/${REPO}/issues/7`) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          html_url: `https://github.com/${REPO}/issues/7`,
          labels: issueLabels.map((name) => ({ name })),
          number: 7,
          state: "open",
          title: "fixture",
        })
      );
      return;
    }
    if (req.method === "POST" && url.endsWith("/labels")) {
      issueLabels.push("factory/queued");
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const k8s = createServer((req, res) => {
    upstream.push(`k8s ${req.method} ${req.url}`);
    const url = req.url ?? "";
    if (req.method === "GET" && url.includes("/cronjobs/")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          spec: {
            jobTemplate: {
              spec: { template: { spec: { containers: [{ env: [] }] } } },
            },
          },
        })
      );
      return;
    }
    if (req.method === "POST" && url.endsWith("/jobs")) {
      let b = "";
      req.on("data", (chunk) => (b += chunk));
      req.on("end", () => {
        created.push(JSON.parse(b));
        res.writeHead(201, { "content-type": "application/json" }).end(b);
      });
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"items":[]}');
  });
  for (const server of [gh, k8s]) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  }

  const tailnetPort = await freePort();
  const panel = await startPanel({
    GH_API_BASE: `http://127.0.0.1:${portOf(gh)}`,
    GH_TOKEN: "test-token",
    KNOWLEDGE_API_BASE: "http://127.0.0.1:1",
    KNOWLEDGE_API_TOKEN: "knowledge-token",
    PANEL_K8S_BASE: `http://127.0.0.1:${portOf(k8s)}`,
    PANEL_TAILNET_PORT: String(tailnetPort),
  });
  try {
    const cluster = panel.base;
    const tailnet = `http://127.0.0.1:${tailnetPort}`;

    // A page on another origin posting text/plain (a CORS simple request).
    for (const m of MUTATIONS) {
      const status = await send(
        tailnet,
        m,
        browser("cross-site", {
          "content-type": "text/plain",
          origin: "https://evil.example",
        })
      );
      assert.equal(status, 403, `${m.method} ${m.route} cross-site`);
    }
    // Browsers without Fetch Metadata still send Origin on every mutation.
    for (const m of MUTATIONS) {
      const status = await send(tailnet, m, {
        "content-type": "text/plain",
        origin: "https://evil.example",
        "tailscale-user-login": ALLOWED_LOGIN,
      });
      assert.equal(status, 403, `${m.method} ${m.route} cross-origin`);
    }
    // No identity at all, on either listener.
    for (const base of [cluster, tailnet]) {
      for (const m of MUTATIONS) {
        const status = await send(base, m, {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
        });
        assert.equal(status, 401, `${m.method} ${m.route} anonymous`);
      }
    }
    assert.deepEqual(upstream, [], "refused requests reached an upstream");

    const patch = MUTATIONS.find((m) => m.method === "PATCH");
    assert.ok(patch);
    // The identity header counts only on the tailnet listener, which only
    // the Tailscale proxy can reach.
    assert.equal(await send(cluster, patch, browser("same-origin")), 401);
    assert.equal(
      await send(cluster, patch, {
        authorization: "Bearer not-a-token",
        "content-type": "application/json",
      }),
      401
    );
    assert.equal(
      await send(
        tailnet,
        patch,
        browser("same-origin", { "tailscale-user-login": "x@example.com" })
      ),
      403,
      "login outside the allowlist"
    );
    assert.equal(
      await send(tailnet, patch, {
        "content-type": "application/json",
        "tailscale-user-login": ALLOWED_LOGIN,
      }),
      403,
      "ambient identity without same-origin proof"
    );
    assert.equal(
      await send(
        tailnet,
        patch,
        browser("same-origin", { "content-type": "text/plain" })
      ),
      415
    );
    assert.deepEqual(upstream, [], "refused requests reached an upstream");

    // Accepted: the panel page (Fetch Metadata or a matching Origin), and a
    // machine caller with a bearer token.
    assert.equal(await send(tailnet, patch, browser("same-origin")), 200);
    assert.equal(
      await send(tailnet, patch, {
        "content-type": "application/json",
        origin: tailnet,
        "tailscale-user-login": ALLOWED_LOGIN,
      }),
      200
    );
    assert.equal(await send(cluster, patch, jsonAs()), 200);

    // "Requested by" is the caller's name from Secret panel-auth.
    const run = MUTATIONS.find((m) => m.route === "/api/factory/run");
    assert.ok(run);
    const queued = await fetch(`${tailnet}${run.route}`, {
      body: JSON.stringify(run.body),
      headers: browser("same-origin", {
        "x-factory-requested-by": "spoofed",
      }),
      method: "POST",
    });
    assert.equal(queued.status, 201);
    assert.equal(
      ((await queued.json()) as { requestedBy: string }).requestedBy,
      "operator"
    );
    assert.equal(
      created.at(-1)?.metadata.labels["factory.gwkline.io/requested-by"],
      "operator"
    );

    // Reads stay open.
    assert.equal((await fetch(`${cluster}/api/state`)).status, 200);
  } finally {
    panel.stop();
    gh.close();
    k8s.close();
  }
});
