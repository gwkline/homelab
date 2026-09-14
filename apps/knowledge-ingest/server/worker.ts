/**
 * Queue worker (#58): claims jobs with `FOR UPDATE SKIP LOCKED` semantics via
 * the store, runs the handler, then completes or fails the claim. Handlers
 * publish idempotently (document versions are unique on their identity), so a
 * claim recovered after a crash re-runs the handler without double-publishing.
 *
 * Lease discipline: a claim is owned until `heartbeat_at` + leaseSeconds. The
 * worker heartbeats in-flight jobs every `heartbeatIntervalMs`; a worker that
 * dies stops heartbeating, and another worker's `recoverStale` returns the job
 * to `pending` (or `dead` once attempts are exhausted). Completing or failing
 * a job is guarded on `worker_id` + `status = 'running'`, so a zombie worker
 * that wakes up after losing its claim can never clobber the new attempt.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { WorkerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { retryDelaySeconds } from "./queue.ts";
import type { ClaimedJob, IngestStore, JobOutcome } from "./store.ts";

export interface JobHandlerContext {
  store: IngestStore;
}

export type JobHandler = (
  job: ClaimedJob,
  context: JobHandlerContext
) => Promise<JobOutcome>;

export interface WorkerDeps {
  config: WorkerConfig;
  handler: JobHandler;
  logger: Logger;
  store: IngestStore;
  workerId?: string;
}

export interface CycleResult {
  claimed: number;
  completed: number;
  failed: number;
  lost: number;
  recovered: number;
}

const processJob = async (
  deps: WorkerDeps,
  workerId: string,
  job: ClaimedJob
): Promise<"completed" | "failed" | "lost"> => {
  const heartbeatTimer = setInterval(() => {
    void (async (): Promise<void> => {
      try {
        await deps.store.heartbeat(workerId, [job.jobId]);
      } catch (error) {
        deps.logger.warn("heartbeat failed", {
          jobId: job.jobId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, deps.config.heartbeatIntervalMs);
  heartbeatTimer.unref();
  try {
    const outcome = await deps.handler(job, { store: deps.store });
    const kept = await deps.store.complete(workerId, job.jobId, outcome);
    return kept ? "completed" : "lost";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const delaySeconds = retryDelaySeconds(
      job.attempts,
      deps.config.retryBaseMs,
      deps.config.retryMaxMs
    );
    const state = await deps.store.fail(
      workerId,
      job.jobId,
      message,
      delaySeconds
    );
    deps.logger.warn("job attempt failed", {
      attempt: job.attempts,
      jobId: job.jobId,
      kind: job.kind,
      next: state ?? "claim-lost",
      reason: message,
    });
    return "failed";
  } finally {
    clearInterval(heartbeatTimer);
  }
};

export const runWorkerCycle = async (
  deps: WorkerDeps
): Promise<CycleResult> => {
  const workerId = deps.workerId ?? `worker_${randomUUID()}`;
  const recovered = await deps.store.recoverStale(deps.config.leaseSeconds);
  const jobs = await deps.store.claim({
    limit: deps.config.claimBatchSize,
    workerId,
  });
  const results: ("completed" | "failed" | "lost")[] = [];
  for (const job of jobs) {
    // Jobs are processed one at a time on purpose: a batch is a lease-holding
    // unit of work, not a fan-out (handlers publish sequentially for the same
    // reason the queue orders claims deterministically).
    const outcome = await processJob(deps, workerId, job);
    results.push(outcome);
  }
  return {
    claimed: jobs.length,
    completed: results.filter((outcome) => outcome === "completed").length,
    failed: results.filter((outcome) => outcome === "failed").length,
    lost: results.filter((outcome) => outcome === "lost").length,
    recovered,
  };
};

export interface RunningWorker {
  stop: () => Promise<void>;
  workerId: string;
}

/**
 * Continuous worker: recover → claim → process, napping only when a cycle
 * found no work. `stop()` halts after the in-flight cycle settles.
 */
export const startWorker = (deps: WorkerDeps): RunningWorker => {
  const workerId = deps.workerId ?? `worker_${randomUUID()}`;
  let stopped = false;
  let settled: Promise<void> = Promise.resolve();
  const loop = async (): Promise<void> => {
    for (;;) {
      if (stopped) {
        return;
      }
      try {
        const cycle = await runWorkerCycle({ ...deps, workerId });
        if (cycle.recovered > 0) {
          deps.logger.info("recovered stale claims", {
            recovered: cycle.recovered,
            workerId,
          });
        }
        if (cycle.claimed === 0) {
          await sleep(deps.config.pollIntervalMs);
        }
      } catch (error) {
        deps.logger.error("worker cycle failed", {
          reason: error instanceof Error ? error.message : String(error),
          workerId,
        });
        await sleep(deps.config.pollIntervalMs);
      }
    }
  };
  settled = loop();
  return {
    stop: async () => {
      stopped = true;
      await settled;
    },
    workerId,
  };
};
