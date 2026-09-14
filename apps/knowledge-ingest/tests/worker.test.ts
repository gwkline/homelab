import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFixtureHandler,
  fixtureChunkCount,
} from "../server/fixture-worker.ts";
import { createMemoryIngestStore } from "../server/memory-store.ts";
import { STALE_RECOVERY_MESSAGE } from "../server/queue.ts";
import type { IngestStore } from "../server/store.ts";
import { runWorkerCycle, startWorker } from "../server/worker.ts";
import type { WorkerDeps } from "../server/worker.ts";
import {
  createTestClock,
  makeIngestInput,
  makeWorkerConfig,
  noopLogger,
} from "./helpers.ts";

interface Rig {
  clock: ReturnType<typeof createTestClock>;
  store: IngestStore;
  deps: (handler?: WorkerDeps["handler"]) => WorkerDeps;
}

const rig = (
  overrides: Partial<{
    claimBatchSize: number;
    heartbeatIntervalMs: number;
    leaseSeconds: number;
    maxAttempts: number;
    pollIntervalMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  }> = {}
): Rig => {
  const clock = createTestClock();
  const workerConfig = makeWorkerConfig(overrides);
  const store = createMemoryIngestStore({
    maxAttempts: workerConfig.maxAttempts,
    now: clock.now,
  });
  const deps = (handler?: WorkerDeps["handler"]): WorkerDeps => ({
    config: workerConfig,
    handler: handler ?? createFixtureHandler(),
    logger: noopLogger,
    store,
  });
  return { clock, deps, store };
};

test("fixture worker drains a document job: publish → succeeded → source counts", async () => {
  const { deps, store } = rig();
  const { job } = await store.enqueueIngest(makeIngestInput());
  const cycle = await runWorkerCycle(deps());
  assert.equal(cycle.claimed, 1);
  assert.equal(cycle.completed, 1);
  const done = await store.getJob(job.jobId);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.attempts, 1);
  assert.equal(done?.documentsIngested, 1);
  assert.equal(
    done?.chunksIngested,
    fixtureChunkCount(makeIngestInput().contentHash)
  );
  const sources = await store.listSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.documentCount, 1);
  assert.equal(
    sources[0]?.chunkCount,
    fixtureChunkCount(makeIngestInput().contentHash)
  );
  assert.ok(sources[0]?.lastSyncAt);
  assert.equal(sources[0]?.currentJob, null);
});

test("fixture chunk counts are deterministic per content hash", () => {
  assert.equal(fixtureChunkCount("0".repeat(64)), 1);
  assert.equal(fixtureChunkCount("f".repeat(64)), 4);
  assert.equal(fixtureChunkCount("ff".padEnd(64, "0")), 4);
});

const boom = (): Promise<never> =>
  Promise.reject(new Error("embedder exploded"));

test("failed attempts retry with backoff, then dead-letter after max attempts", async () => {
  const { clock, deps, store } = rig({ maxAttempts: 2, retryBaseMs: 1000 });
  const { job } = await store.enqueueIngest(makeIngestInput());

  const first = await runWorkerCycle(deps(boom));
  assert.equal(first.claimed, 1);
  assert.equal(first.completed, 0);
  assert.equal(first.failed, 1);
  const afterFirst = await store.getJob(job.jobId);
  assert.equal(afterFirst?.status, "retryable");
  assert.equal(afterFirst?.attempts, 1);
  assert.equal(afterFirst?.error, "embedder exploded");

  // Backoff not elapsed yet: nothing claimable.
  clock.advance(500);
  const idle = await runWorkerCycle(deps(boom));
  assert.equal(idle.claimed, 0);

  // Backoff elapsed: retry runs and exhausts → dead letter.
  clock.advance(500);
  const second = await runWorkerCycle(deps(boom));
  assert.equal(second.claimed, 1);
  assert.equal(second.failed, 1);
  const dead = await store.getJob(job.jobId);
  assert.equal(dead?.status, "dead");
  assert.equal(dead?.attempts, 2);
  assert.ok(dead?.finishedAt);
  assert.equal(dead?.error, "embedder exploded");
  const drained = await runWorkerCycle(deps(boom));
  assert.equal(drained.claimed, 0, "dead jobs are never claimed again");
});

test("a recovered attempt succeeds and is not double-published", async () => {
  const { clock, deps, store } = rig({ leaseSeconds: 60 });
  const { job } = await store.enqueueIngest(makeIngestInput());

  // A worker claims and publishes, then "crashes" before completing.
  const [claimed] = await store.claim({ limit: 1, workerId: "worker-crashy" });
  assert.ok(claimed);
  if (claimed.payload.kind !== "document") {
    throw new Error("expected a document payload");
  }
  const publishedDuringCrash = await store.publishDocumentVersion(
    claimed.payload.document,
    3
  );
  assert.ok(publishedDuringCrash, "first attempt published the version");

  // Lease expires; recovery re-queues the claim.
  clock.advance(61_000);
  const recovered = await store.recoverStale(60);
  assert.equal(recovered, 1);
  const reset = await store.getJob(job.jobId);
  assert.equal(reset?.status, "pending");
  assert.equal(reset?.error, STALE_RECOVERY_MESSAGE);

  // The replacement worker re-runs the job: publish is a no-op on identity.
  const cycle = await runWorkerCycle({ ...deps(), workerId: "worker-clean" });
  assert.equal(cycle.completed, 1);
  const done = await store.getJob(job.jobId);
  assert.equal(done?.status, "succeeded");
  assert.equal(
    done?.documentsIngested,
    0,
    "second attempt published nothing new"
  );
  const sources = await store.listSources();
  assert.equal(
    sources[0]?.documentCount,
    1,
    "exactly one document version exists after crash recovery"
  );
});

test("exhausted crash loops dead-letter without double-publishing", async () => {
  const { clock, store } = rig({ leaseSeconds: 60, maxAttempts: 2 });
  const { job } = await store.enqueueIngest(makeIngestInput());
  for (let round = 0; round < 2; round += 1) {
    const [claimed] = await store.claim({
      limit: 1,
      workerId: `crash-${round}`,
    });
    assert.ok(claimed, `round ${round} claims the recovered job`);
    clock.advance(61_000);
    await store.recoverStale(60);
  }
  const dead = await store.getJob(job.jobId);
  assert.equal(dead?.status, "dead", "crash loop dead-letters at max attempts");
  assert.equal(dead?.error, STALE_RECOVERY_MESSAGE);
  const late = await store.claim({ limit: 5, workerId: "late" });
  assert.equal(late.length, 0, "the dead-lettered job is never claimed again");
  const sources = await store.listSources();
  assert.equal(sources[0]?.documentCount, 0, "the job never completed");
});

test("concurrent workers never claim the same job and publish once", async () => {
  const { deps, store } = rig({ claimBatchSize: 7 });
  const enqueued = [];
  for (let i = 0; i < 25; i += 1) {
    enqueued.push(i);
  }
  const jobs = await Promise.all(
    enqueued.map((i) =>
      store.enqueueIngest(
        makeIngestInput({
          contentHash: `${i}`.padStart(64, "0"),
          externalId: `docs/page-${i}.md`,
          version: { commit: `c${i}`, versionId: `v${i}` },
        })
      )
    )
  );
  const workers = ["w1", "w2", "w3", "w4"];
  const cycles = await Promise.all(
    workers.map((workerId) => runWorkerCycle({ ...deps(), workerId }))
  );
  const claimed = cycles.reduce((sum, cycle) => sum + cycle.claimed, 0);
  assert.equal(
    claimed,
    25,
    "every job was claimed exactly once across workers"
  );
  assert.equal(
    cycles.reduce((sum, cycle) => sum + cycle.completed, 0),
    25
  );
  assert.equal(
    cycles.reduce((sum, cycle) => sum + cycle.lost + cycle.failed, 0),
    0
  );
  const finished = await Promise.all(
    jobs.map(({ job }) => store.getJob(job.jobId))
  );
  for (const done of finished) {
    assert.equal(done?.status, "succeeded");
    assert.equal(done?.documentsIngested, 1);
  }
  const sources = await store.listSources();
  assert.equal(sources[0]?.documentCount, 25);
});

test("interleaved claims between workers never overlap", async () => {
  const { store } = rig();
  const indexes = [0, 1, 2, 3, 4, 5];
  await Promise.all(
    indexes.map((i) =>
      store.enqueueIngest(
        makeIngestInput({
          contentHash: `${i}`.padStart(64, "0"),
          externalId: `doc-${i}`,
        })
      )
    )
  );
  const seen = new Map<string, string>();
  for (const workerId of ["wa", "wb"]) {
    const claimed = await store.claim({ limit: 10, workerId });
    for (const job of claimed) {
      const previous = seen.get(job.jobId);
      assert.equal(
        previous,
        undefined,
        `job ${job.jobId} claimed by both ${previous} and ${workerId}`
      );
      seen.set(job.jobId, workerId);
    }
  }
  assert.equal(seen.size, 6);
});

test("heartbeats keep the lease alive against recovery", async () => {
  const { clock, store } = rig({ leaseSeconds: 60 });
  await store.enqueueIngest(makeIngestInput());
  const [claimed] = await store.claim({ limit: 1, workerId: "w" });
  assert.ok(claimed);
  clock.advance(30_000);
  await store.heartbeat("w", [claimed.jobId]);
  clock.advance(30_000);
  assert.equal(
    await store.recoverStale(60),
    0,
    "heartbeat at t+30s keeps the lease alive through t+60s"
  );
  const still = await store.getJob(claimed.jobId);
  assert.equal(still?.status, "running");
  clock.advance(31_000);
  assert.equal(
    await store.recoverStale(60),
    1,
    "60s after the last heartbeat the lease expires"
  );
});

test("zombie completions after recovery are rejected", async () => {
  const { clock, store } = rig({ leaseSeconds: 60 });
  const { job } = await store.enqueueIngest(makeIngestInput());
  await store.claim({ limit: 1, workerId: "zombie" });
  clock.advance(61_000);
  await store.recoverStale(60);
  await store.claim({ limit: 1, workerId: "fresh" });
  const stolen = await store.complete("zombie", job.jobId, {
    chunksIngested: 1,
    documentsIngested: 1,
  });
  assert.equal(stolen, false, "the old worker lost its claim");
  const failed = await store.fail("zombie", job.jobId, "late failure", 1);
  assert.equal(failed, null);
  const done = await store.complete("fresh", job.jobId, {
    chunksIngested: 1,
    documentsIngested: 1,
  });
  assert.equal(done, true);
});

test("long-running workers: continuous loop drains and stops cleanly", async () => {
  const { deps, store } = rig({ pollIntervalMs: 5 });
  const indexes = Array.from({ length: 12 }, (_, i) => i);
  await Promise.all(
    indexes.map((i) =>
      store.enqueueIngest(
        makeIngestInput({
          contentHash: `${i}`.padStart(64, "0"),
          externalId: `doc-${i}`,
        })
      )
    )
  );
  const worker = startWorker({ ...deps(), workerId: "loop-1" });
  const deadline = Date.now() + 5000;
  let drained = false;
  while (Date.now() < deadline) {
    const sources = await store.listSources();
    const documentCount = sources[0]?.documentCount ?? 0;
    if (documentCount === 12) {
      drained = true;
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  await worker.stop();
  assert.ok(drained, "the worker loop drained every job before stopping");
  const sources = await store.listSources();
  assert.equal(sources[0]?.documentCount, 12);
  assert.equal(sources[0]?.currentJob, null);
});
