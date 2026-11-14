// Standalone browser regression suite for the built SPA. No cluster writes.
// npm run build -w apps/panel
// Install Playwright in a scratch prefix (no repository dependency changes),
// install its Chromium, then set PANEL_PLAYWRIGHT_MODULE to playwright/index.mjs:
// PANEL_PLAYWRIGHT_MODULE=/absolute/scratch/node_modules/playwright/index.mjs \
//   node --test apps/panel/tests/integration/dashboard-browser.test.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../../web/dist");
const modulePath = process.env.PANEL_PLAYWRIGHT_MODULE;

// Fixtures follow GET /api/cluster, /api/cluster/pods and /api/state in
// server/index.ts and ToolState in server/devtools.ts. These are explicitly
// test data, not a claimed snapshot of the production cluster.
const node = {
  age: null,
  arch: "amd64",
  capacity: { cpu: "8", memory: "16374884Ki" },
  internalIP: "192.0.2.10",
  name: "test-node",
  os: "Test OS",
  pods: 4,
  roles: ["control-plane"],
  status: "Ready",
  version: "v1.36.3",
};
const pods = ["Running", "Succeeded", "Pending", "Failed"].map((phase) => ({
  name: `test-${phase.toLowerCase()}`,
  node: node.name,
  ns: "sandbox",
  phase,
  restarts: 0,
}));
const tool = {
  category: "observability",
  dependsOn: "deploy/grafana/base",
  description: "Cluster metrics, logs, and alerting dashboards.",
  detail: "pods ready · /api/health not probed (test network unavailable)",
  enabled: true,
  icon: "Gauge",
  name: "Test Grafana",
  noEmbed: true,
  status: "healthy",
  url: "https://grafana.example.invalid",
};
const state = {
  cronjobs: [
    {
      active: 0,
      lastScheduled: null,
      name: "test-schedule",
      schedule: "0 9 * * *",
      suspended: true,
    },
  ],
  jobs: ["running", "complete"].map((status) => ({
    age: "1m",
    created: "2026-01-01T00:00:00Z",
    issue: null,
    kind: "factory/worker",
    name: `test-${status}`,
    repo: "gwkline/launchpad",
    status,
  })),
};

const stats = {
  autonomous: { additions: 3, commits: 1, deletions: 0 },
  ci: { green: 0, total: 0 },
  merge: { merged: 0, total: 0 },
  queue: { draftPr: 0, inProgress: 0, queued: 0 },
  repo: "gwkline/launchpad",
  review: { approved: 0, total: 0 },
  weeklyMerges: [],
};

test(
  "built dashboard browser regressions",
  {
    skip:
      !modulePath && "Set PANEL_PLAYWRIGHT_MODULE to run Chromium regressions",
  },
  async (t) => {
    const { chromium } = await import(pathToFileURL(modulePath).href);
    const browser = await chromium.launch({ headless: true });
    const server = createServer(async (req, res) => {
      try {
        const { pathname } = new URL(req.url, "http://localhost");
        const file = path.resolve(
          root,
          `.${pathname === "/" ? "/index.html" : pathname}`
        );
        assert.ok(file.startsWith(`${root}${path.sep}`));
        const body = await readFile(file);
        const types = {
          ".css": "text/css",
          ".html": "text/html",
          ".js": "text/javascript",
        };
        res.setHeader(
          "content-type",
          types[path.extname(file)] ?? "application/octet-stream"
        );
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage({
      viewport: { height: 1000, width: 1440 },
    });
    const errors = [];
    const writes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let failed = false;
    let empty = false;
    let delay = false;
    let release;
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const { pathname } = new URL(req.url());
      if (req.method() !== "GET") {
        writes.push({
          headers: req.headers(),
          method: req.method(),
          path: pathname,
        });
        await route.fulfill({
          contentType: "application/json",
          json: { error: "test: authentication required" },
          status: 401,
        });
        return;
      }
      if (delay && pathname === "/api/cluster") {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      if (
        failed &&
        ["/api/cluster/pods", "/api/devtools", "/api/state"].includes(pathname)
      ) {
        await route.fulfill({
          contentType: "application/json",
          json: { error: "test upstream unavailable" },
          status: 502,
        });
        return;
      }
      const responses = {
        "/api/cluster": {
          nodes: empty ? [] : [node],
          podCount: pods.length,
          podsByNs: { sandbox: pods.length },
        },
        "/api/cluster/pods": { pods: empty ? [] : pods },
        "/api/devtools": {
          tailnet: {
            configured: !empty,
            name: empty ? null : "example.invalid",
          },
          tools: [
            tool,
            { ...tool, name: "Disabled tool", status: "disabled" },
            {
              ...tool,
              detail: "hostname not discovered",
              name: "No hostname",
              status: "unconfigured",
              url: null,
            },
          ],
        },
        "/api/factory/all-issues": {
          repos: [{ issues: [], repo: "gwkline/launchpad" }],
        },
        "/api/factory/prs": { prs: [] },
        "/api/factory/stats": stats,
        "/api/knowledge/sources": { configured: true, sources: [] },
        "/api/state": state,
      };
      assert.ok(pathname in responses, `unexpected GET ${pathname}`);
      await route.fulfill({
        contentType: "application/json",
        json: responses[pathname],
      });
    });
    try {
      await t.test(
        "loading does not masquerade as a healthy empty cluster",
        async () => {
          delay = true;
          await page.goto(base);
          await page.getByText("Loading cluster…", { exact: true }).waitFor();
          assert.equal(await page.getByText("No nodes reported.").count(), 0);
          assert.equal(
            await page.getByText("Ready nodes", { exact: true }).count(),
            0
          );
          delay = false;
          release();
        }
      );
      await t.test(
        "overview renders real-schema counts, launch links and node drill-down",
        async () => {
          await page.getByText("Ready nodes", { exact: true }).waitFor();
          const summary = page.locator('[aria-label="Cluster summary"]');
          assert.match(await summary.textContent(), /Ready nodes\s*1\/1/u);
          assert.match(await summary.textContent(), /Running pods\s*1/u);
          assert.match(await summary.textContent(), /Other pod phases\s*2/u);
          assert.match(await summary.textContent(), /Completed pods\s*1/u);
          assert.match(await summary.textContent(), /not container readiness/u);
          const link = page.getByRole("link", { name: /Test Grafana/u });
          assert.equal(await link.getAttribute("href"), tool.url);
          assert.equal(await link.getAttribute("target"), "_blank");
          assert.equal(await link.getAttribute("rel"), "noreferrer");
          assert.match(await link.textContent(), /not probed/u);
          assert.equal(
            await page
              .getByRole("link", { name: /Disabled tool|No hostname/u })
              .count(),
            0
          );
          const expand = page.getByRole("button", { name: /test-node/u });
          await expand.focus();
          await page.keyboard.press("Enter");
          assert.equal(await expand.getAttribute("aria-expanded"), "true");
          assert.match(
            await page.locator("#pods-test-node").textContent(),
            /test-pending/u
          );
          assert.doesNotMatch(
            await page.locator("body").textContent(),
            /NaN|GiGi/u
          );
          await page.keyboard.press("Enter");
          assert.equal(await expand.getAttribute("aria-expanded"), "false");
        }
      );
      await t.test(
        "factory, jobs, schedules and knowledge remain reachable",
        async () => {
          await page
            .getByRole("button", { name: "Open factory", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "jobs", exact: true })
            .waitFor();
          const filter = page.getByPlaceholder(
            "filter by kind, repo, issue, status…"
          );
          await filter.fill("test-complete");
          assert.equal(await page.locator("tbody tr").count(), 1);
          assert.match(
            await page.locator("tbody").textContent(),
            /test-complete/u
          );
          await filter.fill("");
          assert.equal(await page.locator("tbody tr").count(), 2);
          await page
            .getByRole("button", { name: "resume", exact: true })
            .click();
          assert.equal(writes.at(-1).method, "PATCH");
          assert.equal(
            writes.at(-1).headers["content-type"],
            "application/json"
          );
          await page
            .getByText("test: authentication required", { exact: true })
            .waitFor();
          await page
            .getByRole("button", { name: "Knowledge", exact: true })
            .click();
          await page.getByPlaceholder("search the knowledge base…").waitFor();
          await page
            .getByRole("button", { name: "Overview", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Search knowledge", exact: true })
            .click();
          await page.getByPlaceholder("search the knowledge base…").waitFor();
        }
      );
      await t.test(
        "partial upstream failures hide stale counts and recover on refresh",
        async () => {
          failed = true;
          await page
            .getByRole("button", { name: "Overview", exact: true })
            .click();
          await page
            .getByText(
              "Service catalog unavailable: test upstream unavailable",
              { exact: true }
            )
            .waitFor();
          await page
            .getByText("Workload status unavailable", { exact: true })
            .waitFor();
          assert.equal(
            await page.locator('[aria-label="Cluster summary"]').count(),
            0
          );
          assert.equal(
            await page.getByRole("link", { name: /Test Grafana/u }).count(),
            0
          );
          failed = false;
          await page
            .getByRole("button", { name: "Refresh", exact: true })
            .click();
          await page.getByText("Ready nodes", { exact: true }).waitFor();
          await page.getByRole("link", { name: /Test Grafana/u }).waitFor();
          assert.equal(await page.getByRole("alert").count(), 0);
        }
      );
      await t.test("empty state and absent tailnet stay explicit", async () => {
        empty = true;
        await page
          .getByRole("button", { name: "Refresh", exact: true })
          .click();
        await page.getByText("No nodes reported.", { exact: true }).waitFor();
        await page.getByText(/Tailnet hostname not discovered/u).waitFor();
        empty = false;
      });
      await t.test(
        "all views fit mobile widths and keyboard navigation is visible",
        async () => {
          await page.goto(base);
          await page.keyboard.press("Tab");
          assert.equal(
            await page.locator(":focus").textContent(),
            "Skip to content"
          );
          const outline = await page
            .locator(":focus")
            .evaluate((el) => getComputedStyle(el).outlineStyle);
          assert.equal(outline, "solid");
          for (const width of [320, 390, 768]) {
            await page.setViewportSize({ height: 900, width });
            for (const view of ["Overview", "Factory", "Knowledge"]) {
              await page
                .getByRole("button", { name: view, exact: true })
                .click();
              await page.getByRole("heading").first().waitFor();
              assert.ok(
                await page.evaluate(
                  () => document.documentElement.scrollWidth <= innerWidth
                ),
                `${view} overflows at ${width}px`
              );
            }
          }
          assert.deepEqual(errors, []);
        }
      );
    } finally {
      await page.close();
      await browser.close();
      server.close();
      await once(server, "close");
    }
  }
);
