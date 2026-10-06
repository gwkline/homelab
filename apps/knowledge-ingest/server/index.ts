import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createMemoryManifestStore } from "./git-sync.ts";
import { PgKnowledgeSink, sinkClientFromPool } from "./knowledge-sink.ts";
import { createJsonLogger } from "./log.ts";
import { createMemoryIngestStore } from "./memory-store.ts";
import { PgIngestStore, createPgPool } from "./pg-store.ts";
import type { QueueDbClient } from "./pg-store.ts";
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
  const client: QueueDbClient | null = config.databaseUrl
    ? await createPgPool(config.databaseUrl)
    : null;
  const store = client
    ? new PgIngestStore(client, {
        defaultMaxAttempts: config.worker.maxAttempts,
      })
    : createMemoryIngestStore({ maxAttempts: config.worker.maxAttempts });

  // The queue's schema must land BEFORE the #56 knowledge schema: both are
  // CREATE TABLE IF NOT EXISTS, and the #56 base migration also names an
  // `ingest_job` (the library's minimal queue) that this service's richer
  // queue table must win. See server/queue.ts for the shared-database layout.
  const sink =
    client === null
      ? createMemoryPipelineSink()
      : new PgKnowledgeSink(sinkClientFromPool(client), {
          log: (entry) => logger.info("sink", entry),
        });
  const manifests =
    client === null ? createMemoryManifestStore() : (sink as PgKnowledgeSink);

  if (config.applySchemaOnBoot) {
    if (client === null) {
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
