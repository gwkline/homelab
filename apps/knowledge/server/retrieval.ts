import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { serve } from "@hono/node-server";

import { embeddingProviderFromEnv } from "../src/embedder.ts";
import { createJsonLogger } from "../src/log.ts";
import { createPgPool } from "../src/pg-pool.ts";
import { createApp } from "./retrieval/app.ts";
import { configFromEnv } from "./retrieval/config.ts";
import {
  MemoryStore,
  memoryStoreFromSeedFile,
} from "./retrieval/memory-store.ts";
import { mismatchedChunks } from "./retrieval/metrics.ts";
import { PgRetrievalStore } from "./retrieval/pg-store.ts";

const logger = createJsonLogger();

const EMBEDDING_CHECK_RETRY_MS = 10_000;

// Kubernetes sends SIGKILL 30s after SIGTERM.
const SHUTDOWN_DEADLINE_MS = 25_000;

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
  const pool =
    config.databaseUrl === null
      ? null
      : await createPgPool({
          applicationName: "knowledge-retrieval",
          connectionString: config.databaseUrl,
          max: config.poolMax,
          onError: (error) => {
            logger.warn("idle postgres connection failed", {
              reason: error.message,
            });
          },
          statementTimeoutMs: config.requestTimeoutMs,
        });
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
      await once(server, "close");
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
