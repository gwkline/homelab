import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { DevToolsK8s, ToolDef, ToolState } from "../server/devtools.ts";
import { DEV_TOOLS } from "../server/devtools.ts";
import type { K8sObject } from "../server/k8s.ts";

const root = path.join(import.meta.dirname, "..");

const notFound = (name: string) =>
  Object.assign(new Error(`services "${name}" not found`), { status: 404 });

// Shared mock fetch used by evaluateTools tests; resolved through a module-level
// handler so individual tests can swap behavior (see setFetchHandler).
type FetchHandler = (url: string) => { status: number };
let fetchHandler: FetchHandler = () => {
  throw new Error("fetch handler not set");
};
const fetchFn = ((url: string) => fetchHandler(url)) as unknown as typeof fetch;
const setFetchHandler = (fn: FetchHandler) => {
  fetchHandler = fn;
};

// Generic catalog schema — runs over every entry in DEV_TOOLS, so adding a
// tool needs only the config entry and this loop picks it up.
test("dev tools catalog entries are complete and policy-compliant", () => {
  const seen = new Set<string>();
  for (const t of DEV_TOOLS) {
    assert.ok(t.name, "tool has a name");
    assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
    seen.add(t.name);
    assert.ok(t.description, `${t.name}: description`);
    assert.ok(t.icon, `${t.name}: icon`);
    assert.ok(t.category, `${t.name}: category`);
    assert.ok(t.dependsOn, `${t.name}: required dependency declared`);
    // URLs are tailnet-relative templates — never hard-coded personal domains.
    assert.match(
      t.url,
      /^https:\/\/[a-z0-9-]+\.\{tailnet\}$/u,
      `${t.name}: url uses the {tailnet} placeholder`
    );
    assert.ok(
      !/\.[a-z.]*ts\.net/u.test(t.url),
      `${t.name}: no hard-coded tailnet suffix`
    );
    assert.equal(
      typeof t.noEmbed,
      "boolean",
      `${t.name}: framing policy declared`
    );
    assert.equal(
      typeof t.enabled,
      "boolean",
      `${t.name}: enabled flag declared`
    );
    if (t.enabled) {
      assert.ok(t.health, `${t.name}: enabled tools declare a health check`);
      if (t.health) {
        const { namespace, port, service, path: healthPath } = t.health;
        assert.ok(
          service && namespace,
          `${t.name}: health service + namespace`
        );
        assert.ok(healthPath.startsWith("/"), `${t.name}: health path`);
        assert.ok(
          Number.isInteger(port) && port >= 1 && port <= 65_535,
          `${t.name}: valid health port`
        );
      }
    }
  }
  // The issue's initial tool set is in the catalog.
  for (const expected of [
    "Grafana",
    "Headlamp",
    "CloudBeaver",
    "Executor",
    "Homepage",
    "T3 Code",
    "Knowledge",
  ]) {
    assert.ok(
      DEV_TOOLS.some((t) => t.name === expected),
      `${expected} present in catalog`
    );
  }
});

test("evaluateTools distinguishes healthy, unhealthy, unconfigured, and disabled", async () => {
  const { evaluateTools } = await import(
    path.join(root, "dist", "devtools.js")
  );

  const defs: ToolDef[] = [
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: {
        namespace: "agents",
        path: "/healthz",
        port: 80,
        service: "ok",
      },
      icon: "Wrench",
      name: "Ok",
      noEmbed: true,
      url: "https://ok.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: { namespace: "agents", path: "/", port: 80, service: "blocked" },
      icon: "Wrench",
      name: "Blocked",
      noEmbed: true,
      url: "https://blocked.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: {
        namespace: "agents",
        path: "/healthz",
        port: 80,
        service: "sick",
      },
      icon: "Wrench",
      name: "SickEndpoint",
      noEmbed: true,
      url: "https://sick.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: { namespace: "agents", path: "/", port: 80, service: "notready" },
      icon: "Wrench",
      name: "NotReady",
      noEmbed: true,
      url: "https://notready.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: { namespace: "agents", path: "/", port: 80, service: "ghost" },
      icon: "Wrench",
      name: "Ghost",
      noEmbed: true,
      url: "https://ghost.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: { namespace: "agents", path: "/", port: 9999, service: "wrong" },
      icon: "Wrench",
      name: "WrongPort",
      noEmbed: true,
      url: "https://wrong.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: true,
      health: { namespace: "agents", path: "/", port: 80, service: "missing" },
      icon: "Wrench",
      name: "Missing",
      noEmbed: true,
      url: "https://missing.{tailnet}",
    },
    {
      category: "test",
      dependsOn: "t",
      description: "",
      enabled: false,
      health: null,
      icon: "Wrench",
      name: "Off",
      noEmbed: true,
      url: "https://off.{tailnet}",
    },
  ];

  const services: Record<string, unknown> = {
    "agents/blocked": {
      spec: { ports: [{ port: 80 }], selector: { app: "blocked" } },
    },
    "agents/ghost": {
      spec: { ports: [{ port: 80 }], selector: { app: "ghost" } },
    },
    "agents/notready": {
      spec: { ports: [{ port: 80 }], selector: { app: "notready" } },
    },
    "agents/ok": { spec: { ports: [{ port: 80 }], selector: { app: "ok" } } },
    "agents/sick": {
      spec: { ports: [{ port: 80 }], selector: { app: "sick" } },
    },
    "agents/wrong": {
      spec: { ports: [{ port: 80 }], selector: { app: "wrong" } },
    },
  };
  const k8s = {
    getService: (name: string, ns: string): Promise<K8sObject> => {
      const svc = services[`${ns}/${name}`];
      if (!svc) {
        throw notFound(name);
      }
      return Promise.resolve(svc as K8sObject);
    },
    listPodsAll: (): Promise<{ items?: K8sObject[] }> =>
      Promise.resolve({
        items: [
          {
            metadata: { labels: { app: "ok" }, namespace: "agents" },
            status: { conditions: [{ status: "True", type: "Ready" }] },
          },
          {
            metadata: { labels: { app: "blocked" }, namespace: "agents" },
            status: { conditions: [{ status: "True", type: "Ready" }] },
          },
          {
            metadata: { labels: { app: "sick" }, namespace: "agents" },
            status: { conditions: [{ status: "True", type: "Ready" }] },
          },
          {
            metadata: { labels: { app: "notready" }, namespace: "agents" },
            status: { conditions: [{ status: "False", type: "Ready" }] },
          },
        ],
      }),
  } satisfies DevToolsK8s;
  setFetchHandler((url) => {
    if (url.startsWith("http://ok.agents")) {
      return { status: 200 };
    }
    if (url.startsWith("http://sick.agents")) {
      return { status: 503 };
    }
    throw new Error("connect ECONNREFUSED");
  });

  const states = await evaluateTools(defs, k8s, "tailtest.example", {
    fetchFn,
  });
  const byName = Object.fromEntries(
    states.map((s: ToolState) => [s.name, s] as const)
  ) as Record<string, ToolState>;
  // Test fixtures guarantee every expected name; non-null assertions local to
  // this lookup table keep the assertions readable.
  const tool = (name: string): ToolState => {
    const state = byName[name];
    assert.ok(state, `tool state missing: ${name}`);
    return state;
  };

  assert.equal(tool("Ok").status, "healthy");
  assert.equal(tool("Ok").url, "https://ok.tailtest.example");
  assert.ok(tool("Ok").detail?.includes("200"));

  // Netpol-style drop: pods Ready wins, probe reported as not performed.
  assert.equal(tool("Blocked").status, "healthy");
  assert.ok(tool("Blocked").detail?.includes("not probed"));

  assert.equal(tool("SickEndpoint").status, "unhealthy");
  assert.ok(tool("SickEndpoint").detail?.includes("503"));

  assert.equal(tool("NotReady").status, "unhealthy");
  assert.ok(tool("NotReady").detail?.includes("0/1 pods ready"));

  assert.equal(tool("Ghost").status, "unhealthy");
  assert.ok(tool("Ghost").detail?.includes("no pods match"));

  // Valid Service ports: an undeclared catalog port is unconfigured, never probed.
  assert.equal(tool("WrongPort").status, "unconfigured");
  assert.ok(tool("WrongPort").detail?.includes("9999 is not declared"));

  assert.equal(tool("Missing").status, "unconfigured");
  assert.ok(tool("Missing").detail?.includes("not deployed"));

  assert.equal(tool("Off").status, "disabled");

  // Unknown tailnet suffix → no link, unconfigured.
  const [noTailnet] = await evaluateTools([defs[0] as ToolDef], k8s, null, {
    fetchFn,
  });
  assert.equal(noTailnet.status, "unconfigured");
  assert.equal(noTailnet.url, null);
  assert.ok(noTailnet.detail?.includes("PANEL_TAILNET_NAME"));
});

test("GET /api/devtools discovers the tailnet and reports catalog states", async () => {
  const mock = createServer((req, res) => {
    if (req.url === "/api/v1/namespaces/agents/services/panel") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          metadata: { name: "panel" },
          status: {
            loadBalancer: { ingress: [{ hostname: "panel.tailtest.example" }] },
          },
        })
      );
      return;
    }
    if (req.url === "/api/v1/namespaces/agents/services/homepage") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          metadata: { name: "homepage" },
          spec: { ports: [{ port: 443 }], selector: { app: "homepage" } },
        })
      );
      return;
    }
    if (req.url?.startsWith("/api/v1/namespaces/")) {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end('{"message":"services \\\\"x\\\\" not found"}');
      return;
    }
    if (req.url === "/api/v1/pods") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          items: [
            {
              metadata: { labels: { app: "homepage" }, namespace: "agents" },
              status: { conditions: [{ status: "True", type: "Ready" }] },
            },
          ],
        })
      );
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end('{"items":[]}');
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = (mock.address() as AddressInfo).port;

  const stage = mkdtempSync(path.join(tmpdir(), "panel-devtools-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) {
    copyFileSync(path.join(root, "dist", f), path.join(stage, f));
  }
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );

  const port = 3961;
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
      ) as unknown as ReturnType<typeof setTimeout>;
      child.stdout.on(
        "data",
        (d) =>
          d.toString().includes("listening") && (clearTimeout(t), resolve())
      );
    });

    const r = await fetch(`http://127.0.0.1:${port}/api/devtools`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as {
      tailnet: { configured: boolean; name: string | null };
      tools: {
        name: string;
        status: string;
        url: string | null;
        detail: string;
        category: string;
        dependsOn: string;
        noEmbed: boolean;
      }[];
    };

    assert.equal(body.tailnet.configured, true);
    assert.equal(body.tailnet.name, "tailtest.example");
    assert.ok(Array.isArray(body.tools) && body.tools.length >= 7);

    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]));
    const card = (name: string) => {
      const state = byName[name];
      assert.ok(state, `tool card missing: ${name}`);
      return state;
    };
    // Deployed tool: healthy, link built from the discovered tailnet suffix.
    assert.equal(card("Homepage").status, "healthy");
    assert.equal(card("Homepage").url, "https://homepage.tailtest.example");
    // The in-cluster probe cannot resolve the service DNS in this mock —
    // a network-level failure must NOT flip the card to unhealthy.
    assert.ok(card("Homepage").detail.includes("not probed"));
    // Not-yet-deployed tools are unconfigured, disabled one stays disabled.
    assert.equal(card("Grafana").status, "unconfigured");
    assert.equal(card("Knowledge").status, "disabled");
    // Cards carry the full declarative metadata.
    assert.equal(card("Grafana").category, "observability");
    assert.equal(card("Grafana").dependsOn, "deploy/grafana/base");
    assert.equal(card("Homepage").noEmbed, true);
  } finally {
    child.kill();
    mock.close();
  }
});
