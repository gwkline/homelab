// Panel list-and-launch e2e driver (issue #27).
//
// Proves, against a real Kubernetes API, that a deployed panel — running
// with its production ServiceAccount and the cluster CA — lists sandbox
// state and creates locked-down Jobs that actually run to completion:
//   1. GET /api/state returns the seeded Job and CronJob
//   2. POST /api/jobs creates a sandbox Job carrying the requested command
//      and the locked-down container fields (non-root, caps dropped, no SA
//      token automount, RuntimeDefault seccomp)
//   3. the created Job reaches a terminal state in the disposable cluster
//   4. invalid command and issue inputs stay rejected (400)
//
// Host-side driver: talks to the panel over PANEL_E2E_URL (the smoke script
// sets up a port-forward into the panel pod) and reads live cluster state
// with kubectl. TLS trust and RBAC failures surface as non-200 responses;
// bodies are printed with targeted hints instead of being swallowed.
//
// Reusable standalone (see docs/panel-e2e.md):
//   PANEL_E2E_URL=http://127.0.0.1:3933 \
//     node --test apps/panel/tests/integration/panel-e2e.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

const base = process.env.PANEL_E2E_URL ?? "";
const ns = process.env.PANEL_E2E_NS ?? "sandbox";
const seedJob = process.env.PANEL_E2E_SEED_JOB ?? "panel-e2e-seed";
const seedCronJob = process.env.PANEL_E2E_CRONJOB ?? "loop-example";
const seedSchedule = process.env.PANEL_E2E_SCHEDULE ?? "0 9 * * *";
const command = process.env.PANEL_E2E_COMMAND ?? "echo panel-e2e-launch-ok";
const issue = process.env.PANEL_E2E_ISSUE ?? "27";
const jobWaitMs = Number(process.env.PANEL_E2E_JOB_WAIT ?? "300") * 1000;
// The smoke script reads the created Job's name from here for its preserved
// output and scoped cleanup; empty when run standalone.
const createdFile = process.env.PANEL_E2E_CREATED_FILE ?? "";

const skip =
  base === "" ? "PANEL_E2E_URL not set — run scripts/panel-e2e-smoke.sh" : false;

const kubectl = (...args) =>
  execFileSync("kubectl", args, { encoding: "utf8" });

// API calls keep the upstream error body visible: TLS trust and RBAC drift
// both reach the driver as panel 502s carrying the upstream message, and
// each shape gets a targeted hint so failures are diagnosable in one look.
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
        "hint: RBAC — check the panel ServiceAccount RoleBinding (deploy/panel/base/rbac.yaml, Role loop-manager in sandbox)"
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

const postJob = (payload) =>
  call("/api/jobs", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

let created = "";

test("GET /api/state returns the seeded Jobs and CronJobs", { skip }, async () => {
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
});

test("POST /api/jobs creates a locked-down Job with the expected command", { skip }, async () => {
  const res = await postJob({ command, issue });
  assert.equal(res.status, 201, `launch failed: ${res.body}`);
  const { name } = JSON.parse(res.body);
  assert.match(name, /^panel-[a-z0-9-]+$/u);

  // Assert on the live cluster object, not the panel's response: RBAC, the
  // sandbox namespace, and every locked-down field are proven end to end.
  const job = JSON.parse(kubectl("get", "job", name, "-n", ns, "-o", "json"));
  assert.equal(job.metadata.namespace, ns);
  assert.equal(job.metadata.labels["app.kubernetes.io/managed-by"], "panel");
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.restartPolicy, "Never");
  assert.equal(job.spec.template.spec.securityContext.seccompProfile.type, "RuntimeDefault");
  const [container] = job.spec.template.spec.containers;
  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
  assert.equal(env.LOOP_COMMAND, command);
  assert.equal(env.WATCHER_ISSUE, issue);
  assert.equal(container.securityContext.runAsUser, 1000);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);

  created = name;
  if (createdFile !== "") {
    writeFileSync(createdFile, `${name}\n`);
  }
});

test("the created Job reaches a terminal state", { skip }, async () => {
  assert.ok(created, "launch test did not create a Job");
  const deadline = Date.now() + jobWaitMs;
  let conditions = [];
  while (Date.now() < deadline) {
    const job = JSON.parse(kubectl("get", "job", created, "-n", ns, "-o", "json"));
    conditions = job.status?.conditions ?? [];
    const complete = conditions.some(
      (c) => c.type === "Complete" && c.status === "True"
    );
    if (complete) {
      const logs = kubectl("logs", `job/${created}`, "-n", ns);
      assert.ok(
        logs.includes(command),
        `Job pod logs missing the command output: ${logs}`
      );
      // The live API state must reflect the terminal status through the panel.
      const state = JSON.parse((await call("/api/state")).body);
      const view = state.jobs.find((j) => j.name === created);
      assert.equal(view?.status, "complete");
      return;
    }
    const failed = conditions.some(
      (c) => c.type === "Failed" && c.status === "True"
    );
    assert.ok(!failed, `Job ${created} went Failed: ${JSON.stringify(job.status)}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.fail(
    `Job ${created} not terminal within ${jobWaitMs / 1000}s: ${JSON.stringify(conditions)}`
  );
});

test("invalid command and issue inputs stay rejected", { skip }, async () => {
  const bad = [
    [{ command: "   " }, "blank command"],
    [{ issue: "27" }, "missing command"],
    [{ command, issue: "abc" }, "non-numeric issue"],
    [{ command, issue: "-3" }, "negative issue"],
    [{ command, issue: "12345678" }, "overlong issue"],
  ];
  for (const [payload, why] of bad) {
    const res = await postJob(payload);
    assert.equal(
      res.status,
      400,
      `${why}: expected 400, got ${res.status} ${res.body}`
    );
  }
  // None of the rejected launches may have created anything.
  const jobs = JSON.parse(kubectl("get", "jobs", "-n", ns, "-o", "json"));
  const launched = jobs.items.filter(
    (j) => j.metadata.labels?.["app.kubernetes.io/managed-by"] === "panel"
  );
  assert.equal(
    launched.length,
    created === "" ? 0 : 1,
    `rejected input created a Job (panel-launched jobs: ${launched.map((j) => j.metadata.name).join(", ")})`
  );
});
