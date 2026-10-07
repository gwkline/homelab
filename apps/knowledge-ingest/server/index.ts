import { once } from "node:events";

import { serve } from "@hono/node-server";

import { createPgPool } from "../../knowledge/src/pg-pool.ts";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  migrateKnowledgeSchema,
} from "../../knowledge/src/schema.ts";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createMemoryManifestStore } from "./git-sync.ts";
import { PgKnowledgeSink } from "./knowledge-sink.ts";
import { createJsonLogger } from "./log.ts";
import { createMemoryIngestStore } from "./memory-store.ts";
import { PgIngestStore } from "./pg-store.ts";
import {
  createMemoryPipelineSink,
  createPipelineHandler,
  pipelineConfigFromEnv,
} from "./pipeline-worker.ts";
import { startWorker } from "./worker.ts";

const logger = createJsonLogger();

// Kubernetes sends SIGKILL 30s after SIGTERM. A job still running at the
// deadline is abandoned; its lease expires and another worker retries it.
const SHUTDOWN_DEADLINE_MS = 25_000;

try {
  const config = configFromEnv(process.env);
  const pool = config.databaseUrl
    ? await createPgPool({
        applicationName: "knowledge-ingest",
        connectionString: config.databaseUrl,
        max: config.pool.max,
        onError: (error) => {
          logger.warn("idle postgres connection failed", {
            reason: error.message,
          });
        },
        statementTimeoutMs: config.pool.statementTimeoutMs,
      })
    : null;
  const store = pool
    ? new PgIngestStore(pool, {
        defaultMaxAttempts: config.worker.maxAttempts,
      })
    : createMemoryIngestStore({ maxAttempts: config.worker.maxAttempts });

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
      const applied = await migrateKnowledgeSchema(pool);
      logger.info("knowledge schema migrated", {
        applied: applied.join(","),
        version: KNOWLEDGE_SCHEMA_VERSION,
      });
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
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info("shutdown", { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_DEADLINE_MS).unref();
    try {
      server.close();
      await Promise.all([worker?.stop(), once(server, "close")]);
      await pool?.end();
      process.exit(0);
    } catch (error) {
      logger.error("shutdown failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
} catch (error) {
  logger.error("startup failed", {
    reason: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
