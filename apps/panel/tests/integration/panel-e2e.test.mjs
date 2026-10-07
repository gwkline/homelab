// Panel e2e driver. Against a real Kubernetes API, checks that a deployed
// panel lists sandbox state and that its remaining write routes work as the
// production ServiceAccount:
//   1. GET /api/state returns the seeded Job and CronJob
//   2. PATCH /api/cronjobs/:name suspends and resumes the seeded CronJob
//   3. DELETE /api/jobs/:name removes the seeded Job
//   4. POST /api/jobs no longer exists and creates nothing
//
// Talks to the panel over PANEL_E2E_URL and reads live state with kubectl.
// Standalone usage (see docs/panel-e2e.md):
//   PANEL_E2E_URL=http://127.0.0.1:3933 \
//     node --test apps/panel/tests/integration/panel-e2e.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const base = process.env.PANEL_E2E_URL ?? "";
const ns = process.env.PANEL_E2E_NS ?? "sandbox";
const seedJob = process.env.PANEL_E2E_SEED_JOB ?? "panel-e2e-seed";
// Seeded by scripts/panel-e2e-smoke.sh; never a production object.
const seedCronJob = process.env.PANEL_E2E_CRONJOB ?? "panel-e2e-seed-cronjob";
const seedSchedule = process.env.PANEL_E2E_SCHEDULE ?? "0 9 * * *";
const skip =
  base === ""
    ? "PANEL_E2E_URL not set — run scripts/panel-e2e-smoke.sh"
    : false;

const kubectl = (...args) =>
  execFileSync("kubectl", args, { encoding: "utf-8" });

// TLS trust and RBAC failures both arrive as panel 502s; print the upstream
// body with a targeted hint.
const call = async (path, init) => {
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (error) {
    assert.fail(`panel unreachable at ${base}${path}: ${error.cause ?? error}`);
  }
  const body = await res.text();
  if (!res.ok) {
    console.error(`panel ${res.status} on ${path}: ${body}`);
    if (/forbidden|cannot /iu.test(body)) {
      console.error(
        "hint: RBAC — check the panel ServiceAccount RoleBindings (deploy/panel/base/rbac.yaml, Roles panel-sandbox-runs in sandbox + panel-agents-viewer in agents)"
      );
    }
    if (/certificate|tls|ssl|self-signed/iu.test(body)) {
      console.error(
        "hint: TLS trust — the panel pod must mount the cluster CA (/var/run/secrets/kubernetes.io/serviceaccount/ca.crt via its ServiceAccount token)"
      );
    }
  }
  return { body, status: res.status };
};

const sendJson = (path, method, payload) =>
  call(path, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method,
  });

const kubectlJson = (...args) => JSON.parse(kubectl(...args, "-o", "json"));

test(
  "GET /api/state returns the seeded Jobs and CronJobs",
  { skip },
  async () => {
    const { body, status } = await call("/api/state");
    assert.equal(status, 200, `/api/state failed: ${body}`);
    const state = JSON.parse(body);
    const names = state.jobs.map((j) => j.name);
    assert.ok(
      names.includes(seedJob),
      `seeded Job ${seedJob} missing from /api/state (got: ${names.join(", ")})`
    );
    const cronjob = state.cronjobs.find((cj) => cj.name === seedCronJob);
    assert.ok(
      cronjob,
      `seeded CronJob ${seedCronJob} missing from /api/state (got: ${state.cronjobs.map((cj) => cj.name).join(", ")})`
    );
    assert.equal(cronjob.schedule, seedSchedule);
    assert.equal(cronjob.suspended, true);
  }
);

test(
  "PATCH /api/cronjobs/:name toggles suspend on the live CronJob",
  { skip },
  async () => {
    const path = `/api/cronjobs/${encodeURIComponent(seedCronJob)}`;
    // Resume then re-suspend: the seed schedule fires once a day, so the
    // resumed window cannot start a run.
    for (const suspended of [false, true]) {
      const res = await sendJson(path, "PATCH", { suspended });
      assert.equal(res.status, 200, `patch failed: ${res.body}`);
      const live = kubectlJson("get", "cronjob", seedCronJob, "-n", ns);
      assert.equal(live.spec.suspend, suspended);
    }
  }
);

test("DELETE /api/jobs/:name removes the live Job", { skip }, async () => {
  const res = await call(`/api/jobs/${encodeURIComponent(seedJob)}`, {
    method: "DELETE",
  });
  assert.equal(res.status, 200, `delete failed: ${res.body}`);
  // Garbage collection finalizes the delete asynchronously.
  const deadline = Date.now() + 60_000;
  let left = [];
  while (Date.now() < deadline) {
    left = kubectlJson("get", "jobs", "-n", ns).items.map(
      (j) => j.metadata.name
    );
    if (!left.includes(seedJob)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail(`${seedJob} still present after delete: ${left.join(", ")}`);
});

test("POST /api/jobs is gone and creates nothing", { skip }, async () => {
  const before = kubectlJson("get", "jobs", "-n", ns).items.length;
  const res = await sendJson("/api/jobs", "POST", { command: "echo hi" });
  assert.equal(res.status, 404, `expected 404, got ${res.status} ${res.body}`);
  const after = kubectlJson("get", "jobs", "-n", ns).items.length;
  assert.equal(after, before, "POST /api/jobs created a Job");
});
