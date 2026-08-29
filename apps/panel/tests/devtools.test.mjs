import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Generic catalog schema — runs over every entry in DEV_TOOLS, so adding a
// tool needs only the config entry and this loop picks it up.
test("dev tools catalog entries are complete and policy-compliant", async () => {
  const { DEV_TOOLS } = await import(join(root, "dist", "devtools.js"));
  const seen = new Set();
  for (const t of DEV_TOOLS) {
    assert.ok(t.name, "tool has a name");
    assert.ok(!seen.has(t.name), `duplicate tool name: ${t.name}`);
    seen.add(t.name);
    assert.ok(t.description, `${t.name}: description`);
    assert.ok(t.icon, `${t.name}: icon`);
    assert.ok(t.category, `${t.name}: category`);
    assert.ok(t.dependsOn, `${t.name}: required dependency declared`);
    // URLs are tailnet-relative templates — never hard-coded personal domains.
    assert.match(t.url, /^https:\/\/[a-z0-9-]+\.\{tailnet\}$/, `${t.name}: url uses the {tailnet} placeholder`);
    assert.ok(!/\.[a-z.]*ts\.net/.test(t.url), `${t.name}: no hard-coded tailnet suffix`);
    assert.equal(typeof t.noEmbed, "boolean", `${t.name}: framing policy declared`);
    assert.equal(typeof t.enabled, "boolean", `${t.name}: enabled flag declared`);
    if (t.enabled) {
      assert.ok(t.health, `${t.name}: enabled tools declare a health check`);
      const { service, namespace, port, path } = t.health;
      assert.ok(service && namespace, `${t.name}: health service + namespace`);
      assert.ok(path.startsWith("/"), `${t.name}: health path`);
      assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, `${t.name}: valid health port`);
    }
  }
  // The issue's initial tool set is in the catalog.
  for (const expected of ["Grafana", "Headlamp", "CloudBeaver", "Executor", "Homepage", "T3 Code", "Knowledge"]) {
    assert.ok(DEV_TOOLS.some((t) => t.name === expected), `${expected} present in catalog`);
  }
});

test("evaluateTools distinguishes healthy, unhealthy, unconfigured, and disabled", async () => {
  const { evaluateTools } = await import(join(root, "dist", "devtools.js"));

  const defs = [
    { name: "Ok", description: "", icon: "Wrench", category: "test", url: "https://ok.{tailnet}",
      health: { service: "ok", namespace: "agents", port: 80, path: "/healthz" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "Blocked", description: "", icon: "Wrench", category: "test", url: "https://blocked.{tailnet}",
      health: { service: "blocked", namespace: "agents", port: 80, path: "/" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "SickEndpoint", description: "", icon: "Wrench", category: "test", url: "https://sick.{tailnet}",
      health: { service: "sick", namespace: "agents", port: 80, path: "/healthz" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "NotReady", description: "", icon: "Wrench", category: "test", url: "https://notready.{tailnet}",
      health: { service: "notready", namespace: "agents", port: 80, path: "/" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "Ghost", description: "", icon: "Wrench", category: "test", url: "https://ghost.{tailnet}",
      health: { service: "ghost", namespace: "agents", port: 80, path: "/" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "WrongPort", description: "", icon: "Wrench", category: "test", url: "https://wrong.{tailnet}",
      health: { service: "wrong", namespace: "agents", port: 9999, path: "/" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "Missing", description: "", icon: "Wrench", category: "test", url: "https://missing.{tailnet}",
      health: { service: "missing", namespace: "agents", port: 80, path: "/" }, dependsOn: "t", enabled: true, noEmbed: true },
    { name: "Off", description: "", icon: "Wrench", category: "test", url: "https://off.{tailnet}",
      health: null, dependsOn: "t", enabled: false, noEmbed: true },
  ];

  const services = {
    "agents/ok": { spec: { ports: [{ port: 80 }], selector: { app: "ok" } } },
    "agents/blocked": { spec: { ports: [{ port: 80 }], selector: { app: "blocked" } } },
    "agents/sick": { spec: { ports: [{ port: 80 }], selector: { app: "sick" } } },
    "agents/notready": { spec: { ports: [{ port: 80 }], selector: { app: "notready" } } },
    "agents/wrong": { spec: { ports: [{ port: 80 }], selector: { app: "wrong" } } },
    "agents/ghost": { spec: { ports: [{ port: 80 }], selector: { app: "ghost" } } },
  };
  const notFound = (name) => Object.assign(new Error(`services "${name}" not found`), { status: 404 });
  const k8s = {
    getService: async (name, ns) => {
      const svc = services[`${ns}/${name}`];
      if (!svc) throw notFound(name);
      return svc;
    },
    listPodsAll: async () => ({
      items: [
        { metadata: { namespace: "agents", labels: { app: "ok" } }, status: { conditions: [{ type: "Ready", status: "True" }] } },
        { metadata: { namespace: "agents", labels: { app: "blocked" } }, status: { conditions: [{ type: "Ready", status: "True" }] } },
        { metadata: { namespace: "agents", labels: { app: "sick" } }, status: { conditions: [{ type: "Ready", status: "True" }] } },
        { metadata: { namespace: "agents", labels: { app: "notready" } }, status: { conditions: [{ type: "Ready", status: "False" }] } },
      ],
    }),
  };
  const fetchFn = async (url) => {
    if (url.startsWith("http://ok.agents")) return { status: 200 };
    if (url.startsWith("http://sick.agents")) return { status: 503 };
    throw new Error("connect ECONNREFUSED");
  };

  const states = await evaluateTools(defs, k8s, "tailtest.example", { fetchFn });
  const byName = Object.fromEntries(states.map((s) => [s.name, s]));

  assert.equal(byName.Ok.status, "healthy");
  assert.equal(byName.Ok.url, "https://ok.tailtest.example");
  assert.ok(byName.Ok.detail.includes("200"));

  // Netpol-style drop: pods Ready wins, probe reported as not performed.
  assert.equal(byName.Blocked.status, "healthy");
  assert.ok(byName.Blocked.detail.includes("not probed"));

  assert.equal(byName.SickEndpoint.status, "unhealthy");
  assert.ok(byName.SickEndpoint.detail.includes("503"));

  assert.equal(byName.NotReady.status, "unhealthy");
  assert.ok(byName.NotReady.detail.includes("0/1 pods ready"));

  assert.equal(byName.Ghost.status, "unhealthy");
  assert.ok(byName.Ghost.detail.includes("no pods match"));

  // Valid Service ports: an undeclared catalog port is unconfigured, never probed.
  assert.equal(byName.WrongPort.status, "unconfigured");
  assert.ok(byName.WrongPort.detail.includes("9999 is not declared"));

  assert.equal(byName.Missing.status, "unconfigured");
  assert.ok(byName.Missing.detail.includes("not deployed"));

  assert.equal(byName.Off.status, "disabled");

  // Unknown tailnet suffix → no link, unconfigured.
  const [noTailnet] = await evaluateTools([defs[0]], k8s, null, { fetchFn });
  assert.equal(noTailnet.status, "unconfigured");
  assert.equal(noTailnet.url, null);
  assert.ok(noTailnet.detail.includes("PANEL_TAILNET_NAME"));
});

test("GET /api/devtools discovers the tailnet and reports catalog states", async () => {
  const mock = createServer((req, res) => {
    if (req.url === "/api/v1/namespaces/agents/services/panel") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        metadata: { name: "panel" },
        status: { loadBalancer: { ingress: [{ hostname: "panel.tailtest.example" }] } },
      }));
      return;
    }
    if (req.url === "/api/v1/namespaces/agents/services/homepage") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        metadata: { name: "homepage" },
        spec: { ports: [{ port: 443 }], selector: { app: "homepage" } },
      }));
      return;
    }
    if (req.url?.startsWith("/api/v1/namespaces/")) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"message":"services \\"x\\" not found"}');
      return;
    }
    if (req.url === "/api/v1/pods") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        items: [{
          metadata: { namespace: "agents", labels: { app: "homepage" } },
          status: { conditions: [{ type: "Ready", status: "True" }] },
        }],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"items":[]}');
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockPort = mock.address().port;

  const stage = mkdtempSync(join(tmpdir(), "panel-devtools-"));
  mkdirSync(join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) copyFileSync(join(root, "dist", f), join(stage, f));
  copyFileSync(join(root, "web", "dist", "index.html"), join(stage, "web", "dist", "index.html"));

  const port = 3961;
  const child = spawn(process.execPath, [join(stage, "index.js")], {
    env: { ...process.env, PORT: String(port), PANEL_ROOT: stage, PANEL_K8S_BASE: `http://127.0.0.1:${mockPort}`, PANEL_K8S_TOKEN: "test-token" },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not start")), 5000);
      child.stdout.on("data", (d) => d.toString().includes("listening") && (clearTimeout(t), resolve()));
    });

    const r = await fetch(`http://127.0.0.1:${port}/api/devtools`);
    assert.equal(r.status, 200);
    const body = await r.json();

    assert.equal(body.tailnet.configured, true);
    assert.equal(body.tailnet.name, "tailtest.example");
    assert.ok(Array.isArray(body.tools) && body.tools.length >= 7);

    const byName = Object.fromEntries(body.tools.map((t) => [t.name, t]));
    // Deployed tool: healthy, link built from the discovered tailnet suffix.
    assert.equal(byName.Homepage.status, "healthy");
    assert.equal(byName.Homepage.url, "https://homepage.tailtest.example");
    // The in-cluster probe cannot resolve the service DNS in this mock —
    // a network-level failure must NOT flip the card to unhealthy.
    assert.ok(byName.Homepage.detail.includes("not probed"));
    // Not-yet-deployed tools are unconfigured, disabled one stays disabled.
    assert.equal(byName.Grafana.status, "unconfigured");
    assert.equal(byName.Knowledge.status, "disabled");
    // Cards carry the full declarative metadata.
    assert.equal(byName.Grafana.category, "observability");
    assert.equal(byName.Grafana.dependsOn, "deploy/grafana/base");
    assert.equal(byName.Homepage.noEmbed, true);
  } finally {
    child.kill();
    mock.close();
  }
});
