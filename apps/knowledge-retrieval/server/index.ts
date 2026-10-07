import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createJsonLogger } from "./log.ts";
import { MemoryStore, memoryStoreFromSeedFile } from "./memory-store.ts";
import { PgRetrievalStore } from "./pg-store.ts";

const logger = createJsonLogger();

try {
  const config = configFromEnv(process.env);
  const { databaseUrl } = config;
  const pool =
    databaseUrl === undefined || databaseUrl === null
      ? null
      : await (async () => {
          const pg = await import("pg");
          return new pg.Pool({ connectionString: databaseUrl });
        })();
  let store;
  if (pool === null) {
    store = config.seedFile
      ? memoryStoreFromSeedFile(config.seedFile)
      : new MemoryStore({ documents: [] });
    logger.warn(
      "no database configured; running the in-memory store (results are NOT the durable corpus)",
      {}
    );
  } else {
    // knowledge-ingest owns migrations; the store answers 503 until the
    // schema version this build needs is in place.
    store = new PgRetrievalStore(pool, {});
    logger.info("store ready", { backend: "postgres" });
  }
  const app = createApp({ config, logger, store });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info("listening", { port: info.port });
  });
  const shutdown = (signal: string): void => {
    logger.info("shutdown", { signal });
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
