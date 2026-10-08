import assert from "node:assert/strict";
import { test } from "node:test";

import { createFixtureHandler } from "../server/fixture-worker.ts";
import { createMemoryIngestStore } from "../server/memory-store.ts";
import {
  COMPLETE_SQL,
  FAIL_SQL,
  PRUNE_FINISHED_SQL,
  RECOVER_STALE_SQL,
} from "../server/queue.ts";
import type { IngestStore } from "../server/store.ts";
import { runWorkerCycle, startWorker } from "../server/worker.ts";
import type { WorkerDeps } from "../server/worker.ts";
import {
  createTestClock,
  makeIngestInput,
  makeWorkerConfig,
  noopLogger,
} from "./helpers.ts";

const DAY_MS = 86_400_000;
const DROP_CONTENT = /payload #- '\{documentVersion,content\}'/u;

test("every terminal transition drops the job's document text; retries keep it", () => {
  assert.match(COMPLETE_SQL, DROP_CONTENT);
  for (const sql of [FAIL_SQL, RECOVER_STALE_SQL]) {
    assert.match(
      sql,
      /payload = CASE WHEN attempts >= max_attempts THEN payload #- '\{documentVersion,content\}' ELSE payload END/u
    );
  }
});

test("the prune deletes old finished jobs but spares each source's latest", () => {
  assert.match(
    PRUNE_FINISHED_SQL,
    /finished_at < now\(\) - make_interval\(days => \$1\)/u
  );
  assert.match(PRUNE_FINISHED_SQL, /DISTINCT ON \(source_id, status\)/u);
  assert.match(PRUNE_FINISHED_SQL, /WHERE status IN \('succeeded', 'dead'\)/u);
});

const input = (n: number) =>
  makeIngestInput({
    contentHash: `${n}`.padStart(64, "0"),
    externalId: `docs/${n}.md`,
  });

test("old finished jobs are pruned; the source keeps its last sync and last error", async () => {
  const clock = createTestClock();
  const store = createMemoryIngestStore({ maxAttempts: 1, now: clock.now });
  const deps: WorkerDeps = {
    config: makeWorkerConfig({ maxAttempts: 1 }),
    handler: createFixtureHandler(),
    logger: noopLogger,
    store,
  };
  const first = await store.enqueueIngest(input(1));
  const second = await store.enqueueIngest(input(2));
  await runWorkerCycle(deps);
  const failing = await store.enqueueIngest(input(3));
  await runWorkerCycle({
    ...deps,
    handler: () => Promise.reject(new Error("upstream gone")),
  });
  clock.advance(20 * DAY_MS);
  const recent = await store.enqueueIngest(input(4));
  await runWorkerCycle(deps);

  assert.equal(await store.pruneFinished(14), 2);
  assert.equal(await store.getJob(first.job.jobId), null);
  assert.equal(await store.getJob(second.job.jobId), null);
  assert.equal((await store.getJob(failing.job.jobId))?.status, "dead");
  assert.equal((await store.getJob(recent.job.jobId))?.status, "succeeded");
  const [source] = await store.listSources();
  assert.ok(source?.lastSyncAt);
  assert.equal(source?.lastError?.message, "upstream gone");
  assert.equal(await store.pruneFinished(14), 0, "a second prune is a no-op");
});

test("the worker prunes at most once per interval", async () => {
  const store = createMemoryIngestStore();
  const retentions: number[] = [];
  const counting: IngestStore = Object.assign(Object.create(store), {
    pruneFinished: (retentionDays: number) => {
      retentions.push(retentionDays);
      return store.pruneFinished(retentionDays);
    },
  });
  const worker = startWorker({
    config: makeWorkerConfig({ jobRetentionDays: 9, pollIntervalMs: 2 }),
    handler: createFixtureHandler(),
    logger: noopLogger,
    store: counting,
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  await worker.stop();
  assert.deepEqual(retentions, [9]);
});
