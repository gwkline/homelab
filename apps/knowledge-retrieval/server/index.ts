import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { configFromEnv } from "./config.js";
import { createJsonLogger } from "./log.js";
import { MemoryStore, memoryStoreFromSeedFile } from "./memory-store.js";

const logger = createJsonLogger();

try {
  const config = configFromEnv(process.env);
  const store = config.seedFile
    ? memoryStoreFromSeedFile(config.seedFile)
    : new MemoryStore({ documents: [] });
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
