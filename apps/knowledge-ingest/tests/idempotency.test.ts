import assert from "node:assert/strict";
import { test } from "node:test";

import { bearer, createHarness, getJson, makeIngestBody } from "./helpers.ts";

const postIngest = async (
  harness: ReturnType<typeof createHarness>,
  body: Record<string, unknown>
): Promise<Response> =>
  await harness.app.request("/v1/ingest", {
    body: JSON.stringify(body),
    headers: bearer(),
    method: "POST",
  });

const postSync = async (
  harness: ReturnType<typeof createHarness>,
  sourceId: string
): Promise<Response> =>
  await harness.app.request(`/v1/sources/${sourceId}/sync`, {
    headers: bearer(),
    method: "POST",
  });

test("duplicate ingest requests reuse one job (same derived key)", async () => {
  const harness = createHarness();
  const body = makeIngestBody();
  const first = await postIngest(harness, body);
  assert.equal(first.status, 202);
  const firstJob = await getJson(first);
  assert.equal(firstJob["status"], "pending");
  assert.notEqual(firstJob["duplicate"], true);

  const second = await postIngest(harness, body);
  assert.equal(second.status, 200, "duplicate returns the original job");
  const secondJob = await getJson(second);
  assert.equal(secondJob["duplicate"], true);
  assert.equal(secondJob["jobId"], firstJob["jobId"]);
  assert.equal(secondJob["idempotencyKey"], firstJob["idempotencyKey"]);
});

test("idempotency keys are scoped per source event: changed version or content is a new job", async () => {
  const harness = createHarness();
  const base = makeIngestBody();
  const original = await postIngest(harness, base);
  // Same source/namespace/externalId but a new version → new event.
  const newVersion = await postIngest(harness, {
    ...base,
    version: { commit: "def456", versionId: "v2" },
  });
  // Same version but different content → new event.
  const newContent = await postIngest(harness, {
    ...base,
    contentHash: "b".repeat(64),
  });
  const originalJob = await getJson(original);
  const newVersionJob = await getJson(newVersion);
  const newContentJob = await getJson(newContent);
  assert.notEqual(newVersionJob["jobId"], originalJob["jobId"]);
  assert.notEqual(newContentJob["jobId"], originalJob["jobId"]);
  assert.notEqual(newContentJob["jobId"], newVersionJob["jobId"]);
});

test("an explicit client idempotency key overrides the derived key", async () => {
  const harness = createHarness();
  const key = "client-event-2026-09-14";
  // Two different payloads under one client key → one job.
  const first = await postIngest(
    harness,
    makeIngestBody({ idempotencyKey: key, title: "First" })
  );
  const second = await postIngest(
    harness,
    makeIngestBody({ idempotencyKey: key, title: "Second" })
  );
  assert.equal(first.status, 202);
  assert.equal(
    second.status,
    200,
    "the client key rules, even across different payloads"
  );
  const firstJob = await getJson(first);
  const secondJob = await getJson(second);
  assert.equal(secondJob["jobId"], firstJob["jobId"]);
  assert.equal(secondJob["duplicate"], true);
});

test("the resolved #56 provenance block rides on the job record", async () => {
  const harness = createHarness();
  const res = await postIngest(
    harness,
    makeIngestBody({ provenance: { ingestedAt: "2026-09-12T08:30:00Z" } })
  );
  const job = await getJson(res);
  const provenance = job["provenance"] as Record<string, unknown>;
  assert.equal(provenance["ingestedAt"], "2026-09-12T08:30:00Z");
  assert.equal(provenance["ingestionEventId"], job["jobId"]);
});

test("source sync: unknown source 404s, known source 202s, active sync dedupes", async () => {
  const harness = createHarness();
  const missing = await postSync(harness, "homelab-docs");
  assert.equal(missing.status, 404);

  const ingest = await postIngest(harness, makeIngestBody());
  assert.equal(ingest.status, 202);

  const first = await postSync(harness, "homelab-docs");
  assert.equal(first.status, 202);
  const firstJob = await getJson(first);
  assert.equal(firstJob["status"], "pending");
  assert.equal(firstJob["kind"], "source_sync");

  const second = await postSync(harness, "homelab-docs");
  assert.equal(
    second.status,
    200,
    "active sync job is returned, not duplicated"
  );
  const secondJob = await getJson(second);
  assert.equal(secondJob["jobId"], firstJob["jobId"]);
  assert.equal(secondJob["duplicate"], true);

  // Finishing the sync frees the source for the next trigger.
  const jobId = String(firstJob["jobId"]);
  const foreign = await harness.store.complete("ghost-worker", jobId, {
    chunksIngested: 0,
    documentsIngested: 0,
  });
  assert.equal(foreign, false, "foreign worker cannot complete a claim");
  const job = await harness.store.getJob(jobId);
  assert.equal(job?.status, "pending");
  await harness.store.recoverStale(0);
  await harness.store.claim({ limit: 5, workerId: "w1" });
  await harness.store.complete("w1", jobId, {
    chunksIngested: 0,
    documentsIngested: 0,
  });
  const third = await postSync(harness, "homelab-docs");
  assert.equal(
    third.status,
    202,
    "a new sync job is enqueued after the last one finished"
  );
  const thirdJob = await getJson(third);
  assert.notEqual(thirdJob["jobId"], jobId);
});

test("sync job status endpoint serves the panel contract", async () => {
  const harness = createHarness();
  await postIngest(harness, makeIngestBody());
  const sync = await postSync(harness, "homelab-docs");
  const { jobId } = (await getJson(sync)) as { jobId: string };

  const status = await harness.app.request(`/v1/sync-jobs/${jobId}`, {
    headers: bearer(),
  });
  assert.equal(status.status, 200);
  const job = await getJson(status);
  assert.equal(job["jobId"], jobId);
  assert.equal(job["sourceId"], "homelab-docs");
  assert.equal(job["status"], "pending");
  assert.equal(job["attempts"], 0);
  assert.equal(job["error"], null);

  const missing = await harness.app.request("/v1/sync-jobs/job_missing", {
    headers: bearer(),
  });
  assert.equal(missing.status, 404);
});

test("source list reports counts, last sync, and active jobs", async () => {
  const harness = createHarness();
  const empty = await harness.app.request("/v1/sources", { headers: bearer() });
  assert.deepEqual(await getJson(empty), { sources: [] });

  await postIngest(harness, makeIngestBody());
  await harness.store.claim({ limit: 10, workerId: "w1" });
  const list = await harness.app.request("/v1/sources", { headers: bearer() });
  const parsed = (await getJson(list)) as {
    sources: Record<string, unknown>[];
  };
  const entry = parsed["sources"][0] as Record<string, unknown> | undefined;
  assert.ok(entry, "the source appears in the list after ingest");
  assert.equal(entry["sourceId"], "homelab-docs");
  assert.equal(entry["namespace"], "homelab-docs");
  assert.equal(entry["documentCount"], 0, "nothing published yet");
  assert.equal(entry["chunkCount"], 0);
  assert.equal(entry["lastSyncAt"], null);
  const currentJob = entry["currentJob"] as Record<string, unknown>;
  assert.equal(currentJob["status"], "running");
});
