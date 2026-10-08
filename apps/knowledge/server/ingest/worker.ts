/**
 * Queue worker: claim, run the handler, then complete or fail. Claims are
 * leased via heartbeats; a dead worker's jobs are recovered by others, and
 * complete/fail are guarded on `worker_id` so a zombie cannot clobber the new
 * attempt. Handlers publish idempotently, so recovered re-runs are safe.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "../../src/log.ts";
import type { WorkerConfig } from "./config.ts";
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
    // Sequential on purpose: a batch is a lease-holding unit, not a fan-out.
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
 * Continuous worker: prune (hourly) → recover → claim → process, napping only
 * when a cycle found no work. `stop()` halts after the in-flight cycle settles.
 */
export const startWorker = (deps: WorkerDeps): RunningWorker => {
  const workerId = deps.workerId ?? `worker_${randomUUID()}`;
  let stopped = false;
  let settled: Promise<void> = Promise.resolve();
  let prunedAt = Number.NEGATIVE_INFINITY;
  const prune = async (): Promise<void> => {
    if (Date.now() - prunedAt < deps.config.pruneIntervalMs) {
      return;
    }
    prunedAt = Date.now();
    const pruned = await deps.store.pruneFinished(deps.config.jobRetentionDays);
    if (pruned > 0) {
      deps.logger.info("pruned finished jobs", {
        pruned,
        retentionDays: deps.config.jobRetentionDays,
      });
    }
  };
  const loop = async (): Promise<void> => {
    for (;;) {
      if (stopped) {
        return;
      }
      try {
        await prune();
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
