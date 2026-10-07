// Hung upstreams, request logging, and SIGTERM draining.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");

// Accepts connections and never answers.
const blackHole = async (): Promise<Server> => {
  const server = createServer(() => {
    // never respond
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
};

const urlOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Panel {
  base: string;
  child: ChildProcessWithoutNullStreams;
  lines: Record<string, unknown>[];
}

const startPanel = async (
  port: number,
  env: Record<string, string>
): Promise<Panel> => {
  const stage = mkdtempSync(path.join(tmpdir(), "panel-resilience-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  copyFileSync(
    path.join(root, "dist", "index.js"),
    path.join(stage, "index.js")
  );
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: { ...process.env, PANEL_ROOT: stage, PORT: String(port), ...env },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const lines: Record<string, unknown>[] = [];
  let buffered = "";
  const listening = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.on("data", (d: Buffer) => {
      buffered += d.toString();
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) {
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        if (String(line.msg).startsWith("listening")) {
          clearTimeout(t);
          resolve();
        }
      }
    });
  });
  await listening;
  return { base: `http://127.0.0.1:${port}`, child, lines };
};

const timed = async (url: string): Promise<{ ms: number; status: number }> => {
  const started = performance.now();
  const res = await fetch(url);
  await res.text();
  return { ms: performance.now() - started, status: res.status };
};

test("a never-responding upstream fails the request with 504 and is logged", async () => {
  const k8s = await blackHole();
  const gh = await blackHole();
  const panel = await startPanel(3991, {
    GH_API_BASE: urlOf(gh),
    GH_TOKEN: "test-token",
    PANEL_K8S_BASE: urlOf(k8s),
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
    panel.child.kill();
    for (const server of [k8s, gh]) {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("a request that outlives the request budget gets 504", async () => {
  const k8s = await blackHole();
  const panel = await startPanel(3992, {
    PANEL_K8S_BASE: urlOf(k8s),
    PANEL_REQUEST_TIMEOUT_MS: "300",
    PANEL_UPSTREAM_TIMEOUT_MS: "60000",
  });
  try {
    const { ms, status } = await timed(`${panel.base}/api/state`);
    assert.equal(status, 504);
    assert.ok(ms < 2000, `took ${Math.round(ms)}ms`);
  } finally {
    panel.child.kill();
    k8s.closeAllConnections();
    k8s.close();
  }
});

test("SIGTERM drains in-flight requests, refuses new ones, then exits", async () => {
  // Kubernetes answers after a pause, long enough to signal mid-request.
  const k8s = createServer((_req, res) => {
    setTimeout(() => {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"items":[]}');
    }, 500);
  });
  k8s.listen(0, "127.0.0.1");
  await once(k8s, "listening");
  const panel = await startPanel(3993, { PANEL_K8S_BASE: urlOf(k8s) });
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
    panel.child.kill();
    k8s.close();
  }
});
