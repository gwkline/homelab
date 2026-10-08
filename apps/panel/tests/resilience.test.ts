// Hung upstreams, request logging, and SIGTERM draining.
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { listen, startPanel } from "./helpers.ts";

// Accepts connections and never answers.
const blackHole = async () =>
  await listen(() => {
    // never respond
  });

const timed = async (url: string): Promise<{ ms: number; status: number }> => {
  const started = performance.now();
  const res = await fetch(url);
  await res.text();
  return { ms: performance.now() - started, status: res.status };
};

test("a never-responding upstream fails the request with 504 and is logged", async () => {
  const k8s = await blackHole();
  const gh = await blackHole();
  const panel = await startPanel({
    GH_API_BASE: gh.url,
    GH_TOKEN: "test-token",
    PANEL_K8S_BASE: k8s.url,
    PANEL_UPSTREAM_TIMEOUT_MS: "300",
  });
  try {
    for (const route of [
      "/api/state",
      "/api/factory/prs?repo=gwkline/homelab",
    ]) {
      const { ms, status } = await timed(`${panel.base}${route}`);
      assert.equal(status, 504, route);
      assert.ok(ms < 2000, `${route} took ${Math.round(ms)}ms`);
    }

    const requests = panel.lines.filter((l) => l.msg === "request");
    const state = requests.find((l) => l.path === "/api/state");
    assert.equal(state?.method, "GET");
    assert.equal(state?.route, "/api/state");
    assert.equal(state?.status, 504);
    assert.equal(typeof state?.durationMs, "number");
    const upstream = panel.lines.filter((l) => l.msg === "upstream error");
    assert.ok(
      upstream.some((l) => l.upstream === "kubernetes" && l.status === 504),
      JSON.stringify(upstream)
    );
    assert.ok(
      upstream.some((l) => l.upstream === "github" && l.status === 504),
      JSON.stringify(upstream)
    );
  } finally {
    panel.stop();
    for (const { server } of [k8s, gh]) {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("a request that outlives the request budget gets 504", async () => {
  const k8s = await blackHole();
  const panel = await startPanel({
    PANEL_K8S_BASE: k8s.url,
    PANEL_REQUEST_TIMEOUT_MS: "300",
    PANEL_UPSTREAM_TIMEOUT_MS: "60000",
  });
  try {
    const { ms, status } = await timed(`${panel.base}/api/state`);
    assert.equal(status, 504);
    assert.ok(ms < 2000, `took ${Math.round(ms)}ms`);
  } finally {
    panel.stop();
    k8s.server.closeAllConnections();
    k8s.server.close();
  }
});

test("SIGTERM drains in-flight requests, refuses new ones, then exits", async () => {
  // Kubernetes answers after a pause, long enough to signal mid-request.
  const k8s = await listen((_req, res) => {
    setTimeout(() => {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"items":[]}');
    }, 500);
  });
  const panel = await startPanel({ PANEL_K8S_BASE: k8s.url });
  try {
    const inFlight = timed(`${panel.base}/api/state`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const exited = once(panel.child, "exit");
    panel.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));

    await assert.rejects(fetch(`${panel.base}/api/state`));
    assert.equal((await inFlight).status, 200);
    const [code] = await exited;
    assert.equal(code, 0);
    assert.ok(panel.lines.some((l) => l.msg === "stopped"));
  } finally {
    panel.stop();
    k8s.server.close();
  }
});
