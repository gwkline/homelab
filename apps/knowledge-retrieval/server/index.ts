import { setTimeout as sleep } from "node:timers/promises";

import { serve } from "@hono/node-server";

import { embeddingProviderFromEnv } from "../../knowledge/src/embedder.ts";
import { createApp } from "./app.ts";
import { configFromEnv } from "./config.ts";
import { createJsonLogger } from "./log.ts";
import { MemoryStore, memoryStoreFromSeedFile } from "./memory-store.ts";
import { mismatchedChunks } from "./metrics.ts";
import { PgRetrievalStore } from "./pg-store.ts";

const logger = createJsonLogger();

const EMBEDDING_CHECK_RETRY_MS = 10_000;

/** Logs once whether stored vectors match the query model, after ingest migrates. */
const reportEmbeddingModels = async (
  store: PgRetrievalStore
): Promise<void> => {
  try {
    const report = await store.embeddingReport();
    const mismatched = mismatchedChunks(report);
    const fields = {
      configuredModel: report.configuredModel,
      mismatchedChunks: mismatched,
      storedModels: report.storedModels
        .map((stored) => `${stored.model}=${stored.chunks}`)
        .join(","),
    };
    if (mismatched > 0) {
      logger.warn(
        "stored vectors come from another embedding model; the vector channel ignores them until a re-embed",
        fields
      );
    } else {
      logger.info(
        "stored vectors match the configured embedding model",
        fields
      );
    }
  } catch {
    await sleep(EMBEDDING_CHECK_RETRY_MS);
    await reportEmbeddingModels(store);
  }
};

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
    const provider = embeddingProviderFromEnv(process.env);
    const pgStore = new PgRetrievalStore(pool, { provider });
    if (!pgStore.vectorSearch) {
      logger.warn(
        "no embedding provider configured; every search is served BM25-only",
        { model: provider.model, provider: provider.name }
      );
    }
    void reportEmbeddingModels(pgStore);
    store = pgStore;
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
