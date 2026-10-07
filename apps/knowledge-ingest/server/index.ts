import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createMemoryManifestStore } from "./git-sync.ts";
import { PgKnowledgeSink } from "./knowledge-sink.ts";
import { createJsonLogger } from "./log.ts";
import { createMemoryIngestStore } from "./memory-store.ts";
import { PgIngestStore, createPgPool } from "./pg-store.ts";
import {
  createMemoryPipelineSink,
  createPipelineHandler,
  pipelineConfigFromEnv,
} from "./pipeline-worker.ts";
import { INGEST_SCHEMA_VERSION } from "./queue.ts";
import { startWorker } from "./worker.ts";

const logger = createJsonLogger();

try {
  const config = configFromEnv(process.env);
  const pool = config.databaseUrl
    ? await createPgPool(config.databaseUrl)
    : null;
  const store = pool
    ? new PgIngestStore(pool, {
        defaultMaxAttempts: config.worker.maxAttempts,
      })
    : createMemoryIngestStore({ maxAttempts: config.worker.maxAttempts });

  // The queue schema must apply before the knowledge schema: both create
  // `ingest_job` IF NOT EXISTS, and this service's richer table must win.
  const sink =
    pool === null
      ? createMemoryPipelineSink()
      : new PgKnowledgeSink(pool, {
          log: (entry) => logger.info("sink", entry),
        });
  const manifests =
    pool === null ? createMemoryManifestStore() : (sink as PgKnowledgeSink);

  if (config.applySchemaOnBoot) {
    if (pool === null) {
      logger.warn(
        "no database configured; running the in-memory queue and sink (jobs are NOT durable)",
        {}
      );
    } else {
      await store.applySchema();
      logger.info("queue schema applied", { version: INGEST_SCHEMA_VERSION });
      await (sink as PgKnowledgeSink).applySchema();
      logger.info("knowledge schema applied", {});
    }
  }

  const worker = config.workerEnabled
    ? startWorker({
        config: config.worker,
        handler: createPipelineHandler({
          config: pipelineConfigFromEnv(process.env),
          logger,
          manifests,
          sink,
          store,
        }),
        logger,
        store,
      })
    : null;

  const app = createApp({ config, logger, store });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("listening", {
      backend: store.backend,
      port: info.port,
      worker: worker === null ? "disabled" : worker.workerId,
    });
  });
  const shutdown = (signal: string): void => {
    logger.info("shutdown", { signal });
    void worker?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (error) {
  logger.error("startup failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
