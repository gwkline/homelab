import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Pool } from "pg";

import { createFixtureHandler } from "../server/fixture-worker.ts";
import { PgIngestStore, createPgPool } from "../server/pg-store.ts";
import type { QueueDbClient } from "../server/pg-store.ts";
import { INGEST_SCHEMA_VERSION } from "../server/queue.ts";
import { runWorkerCycle } from "../server/worker.ts";
import { makeIngestInput, makeWorkerConfig, noopLogger } from "./helpers.ts";
/**
 * Live-DB integration for the durable queue (#58): runs only when
 * DATABASE_URL points at a Postgres (the knowledge CNPG cluster in CI/dev).
 * Proves the properties the in-memory suite can only mirror:
 *   - concurrent claims from independent connections never overlap
 *     (`FOR UPDATE SKIP LOCKED`),
 *   - duplicate enqueues collapse to one row under the UNIQUE constraint,
 *   - failed attempts retry and dead-letter through real SQL transitions,
 *   - a crashed claim is recovered and re-run without double-publishing the
 *     document version.
 * Everything is namespaced per run and cleaned up afterwards.
 */

const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

const wrapClient = (pool: Pool): QueueDbClient => ({
  query: async (text, params) => {
    const result = await pool.query(text, params);
    return { rows: (result.rows ?? []) as Record<string, unknown>[] };
  },
});

const testInput = (run: string, index: number) =>
  makeIngestInput({
    contentHash: randomUUID().replaceAll("-", ""),
    externalId: `docs/it-${index}.md`,
    idempotencyKey: `${run}-evt-${index}`,
    namespace: `it-${run}`,
    source: {
      kind: "github",
      path: `docs/it-${index}.md`,
      ref: "main",
      repo: "gwkline/homelab",
      sourceId: `${run}-source`,
      url: "https://github.com/gwkline/homelab",
    },
    version: { commit: `c${index}`, versionId: `v${index}` },
  });

const cleanupRun = async (pool: Pool, run: string): Promise<void> => {
  const prefix = `${run}-%`;
  await pool.query("DELETE FROM ingest_job WHERE source_id LIKE $1", [
    `${prefix}%`,
  ]);
  await pool.query("DELETE FROM document WHERE source_id LIKE $1", [
    `${prefix}%`,
  ]);
  await pool.query("DELETE FROM ingest_source WHERE source_id LIKE $1", [
    `${prefix}%`,
  ]);
};

/** Drain-claim loop for one racer: claim until the queue is empty. */
const claimLoop = async (
  store: PgIngestStore,
  workerId: string
): Promise<string[]> => {
  const claimed: string[] = [];
  for (;;) {
    const jobs = await store.claim({ limit: 2, workerId });
    if (jobs.length === 0) {
      break;
    }
    claimed.push(...jobs.map((job) => job.jobId));
  }
  return claimed;
};

test(
  "live postgres: schema applies and the store pings",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool));
      await store.applySchema();
      await store.ping();
      assert.ok(INGEST_SCHEMA_VERSION.length > 0);
    } finally {
      await pool.end();
    }
  }
);

test(
  "live postgres: concurrent claims never hand one job to two workers",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const run = randomUUID().slice(0, 8);
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool));
      await store.applySchema();
      for (let i = 0; i < 12; i += 1) {
        await store.enqueueIngest(testInput(run, i));
      }
      // Three independent connections race for the same rows.
      const pools = [
        await createPgPool(databaseUrl),
        await createPgPool(databaseUrl),
        await createPgPool(databaseUrl),
      ];
      const racers = pools.map((p, index) =>
        claimLoop(new PgIngestStore(wrapClient(p)), `race-worker-${index}`)
      );
      const results = await Promise.all(racers);
      const all = results.flat().toSorted();
      assert.equal(all.length, 12, "every job claimed exactly once in total");
      assert.equal(
        new Set(all).size,
        12,
        "no job was claimed by two workers (FOR UPDATE SKIP LOCKED)"
      );
      for (const p of pools) {
        await p.end();
      }
    } finally {
      await cleanupRun(pool, run);
      await pool.end();
    }
  }
);

test(
  "live postgres: duplicate requests collapse to one job row",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const run = randomUUID().slice(0, 8);
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool));
      await store.applySchema();
      const input = testInput(run, 0);
      const sequential = await store.enqueueIngest(input);
      const duplicate = await store.enqueueIngest(input);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job.jobId, sequential.job.jobId);
      // Concurrent duplicate enqueues race the UNIQUE constraint.
      const [a, b] = await Promise.all([
        store.enqueueIngest(input),
        store.enqueueIngest(input),
      ]);
      assert.equal(a.job.jobId, sequential.job.jobId);
      assert.equal(b.job.jobId, sequential.job.jobId);
      const counted = await pool.query(
        "SELECT COUNT(*)::int AS n FROM ingest_job WHERE idempotency_key = $1",
        [a.job.idempotencyKey]
      );
      assert.equal(counted.rows[0]?.["n"], 1);
    } finally {
      await cleanupRun(pool, run);
      await pool.end();
    }
  }
);

test(
  "live postgres: failed attempts retry with backoff and dead-letter",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const run = randomUUID().slice(0, 8);
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool), {
        defaultMaxAttempts: 2,
      });
      await store.applySchema();
      const { job } = await store.enqueueIngest(testInput(run, 0));

      const [claimed] = await store.claim({ limit: 1, workerId: "w1" });
      assert.equal(claimed?.jobId, job.jobId);
      assert.equal(
        await store.fail("w1", job.jobId, "boom-1", 0),
        "retryable",
        "attempt 1 with zero backoff is immediately claimable"
      );
      const [second] = await store.claim({ limit: 1, workerId: "w2" });
      assert.equal(second?.attempts, 2);
      assert.equal(
        await store.fail("w2", job.jobId, "boom-2", 0),
        "dead",
        "attempts exhausted dead-letters the job"
      );
      const dead = await store.getJob(job.jobId);
      assert.equal(dead?.status, "dead");
      assert.equal(dead?.error, "boom-2");
      assert.equal(
        (await store.claim({ limit: 5, workerId: "w3" })).length,
        0,
        "dead jobs are not claimable"
      );
      assert.equal(
        await store.complete("w2", job.jobId, {
          chunksIngested: 1,
          documentsIngested: 1,
        }),
        false,
        "a dead job cannot be completed"
      );
    } finally {
      await cleanupRun(pool, run);
      await pool.end();
    }
  }
);

test(
  "live postgres: crash recovery re-runs the job without double-publishing",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const run = randomUUID().slice(0, 8);
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool));
      await store.applySchema();
      const input = testInput(run, 0);
      const { job } = await store.enqueueIngest(input);

      // Worker A claims and publishes, then crashes before completing.
      const [claimed] = await store.claim({ limit: 1, workerId: "crashy" });
      assert.equal(claimed?.jobId, job.jobId);
      assert.equal(claimed?.payload.kind, "document");
      if (claimed?.payload.kind !== "document") {
        throw new Error("expected a document payload");
      }
      assert.equal(
        await store.publishDocumentVersion(claimed.payload.document, 3),
        true
      );
      // Simulate the crash: no heartbeat, no completion.
      await pool.query(
        "UPDATE ingest_job SET heartbeat_at = now() - interval '2 hours' WHERE id = $1",
        [job.jobId]
      );
      assert.equal(await store.recoverStale(3600), 1);
      const reset = await store.getJob(job.jobId);
      assert.equal(reset?.status, "pending");

      // The replacement worker re-runs the fixture handler to completion.
      const cycle = await runWorkerCycle({
        config: makeWorkerConfig({ claimBatchSize: 1, leaseSeconds: 3600 }),
        handler: createFixtureHandler(),
        logger: noopLogger,
        store,
        workerId: "replacement",
      });
      assert.equal(cycle.completed, 1);
      const done = await store.getJob(job.jobId);
      assert.equal(done?.status, "succeeded");
      assert.equal(
        done?.documentsIngested,
        0,
        "the re-run published nothing new (idempotent version identity)"
      );
      const published = await pool.query(
        "SELECT COUNT(*)::int AS n FROM document WHERE source_id = $1",
        [input.source.sourceId]
      );
      assert.equal(
        published.rows[0]?.["n"],
        1,
        "exactly one document version exists after crash recovery"
      );
    } finally {
      await cleanupRun(pool, run);
      await pool.end();
    }
  }
);

test(
  "live postgres: the fixture worker drains jobs end to end",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set" },
  async () => {
    const databaseUrl = process.env["DATABASE_URL"] ?? "";
    const run = randomUUID().slice(0, 8);
    const pool = await createPgPool(databaseUrl);
    try {
      const store = new PgIngestStore(wrapClient(pool));
      await store.applySchema();
      for (let i = 0; i < 4; i += 1) {
        await store.enqueueIngest(testInput(run, i));
      }
      const cycle = await runWorkerCycle({
        config: makeWorkerConfig({ claimBatchSize: 10, leaseSeconds: 3600 }),
        handler: createFixtureHandler(),
        logger: noopLogger,
        store,
        workerId: "fixture-e2e",
      });
      assert.equal(cycle.claimed, 4);
      assert.equal(cycle.completed, 4);
      const sources = await store.listSources();
      const entry = sources.find((s) => s.sourceId === `${run}-source`);
      assert.ok(entry);
      assert.equal(entry.documentCount, 4);
      assert.ok((entry.chunkCount ?? 0) >= 4);
      assert.ok(entry.lastSyncAt !== null);
    } finally {
      await cleanupRun(pool, run);
      await pool.end();
    }
  }
);
