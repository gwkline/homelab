import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createFixtureHandler } from "./fixture-worker.ts";
import { createJsonLogger } from "./log.ts";
import { createMemoryIngestStore } from "./memory-store.ts";
import { PgIngestStore, createPgPool } from "./pg-store.ts";
import { INGEST_SCHEMA_VERSION } from "./queue.ts";
import { startWorker } from "./worker.ts";

const logger = createJsonLogger();

try {
  const config = configFromEnv(process.env);
  const store = config.databaseUrl
    ? new PgIngestStore(await createPgPool(config.databaseUrl), {
        defaultMaxAttempts: config.worker.maxAttempts,
      })
    : createMemoryIngestStore({ maxAttempts: config.worker.maxAttempts });

  if (config.databaseUrl && config.applySchemaOnBoot) {
    await store.applySchema();
    logger.info("schema applied", { version: INGEST_SCHEMA_VERSION });
  }
  if (!config.databaseUrl) {
    logger.warn(
      "no database configured; running the in-memory queue (jobs are NOT durable)",
      {}
    );
  }

  const worker = config.workerEnabled
    ? startWorker({
        config: config.worker,
        handler: createFixtureHandler(),
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
