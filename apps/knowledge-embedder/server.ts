/**
 * Entry point: loads the local bge-small model, then serves the
 * OpenAI-compatible /embeddings surface on :8080 for the knowledge services.
 */

import { once } from "node:events";

import { serve } from "@hono/node-server";

import { createApp } from "./src/app.ts";
import { createEmbed } from "./src/embed.ts";
import { createJsonLogger } from "./src/log.ts";

const logger = createJsonLogger();

const intFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : Number.NaN;
};

// Kubernetes sends SIGKILL 30s after SIGTERM.
const SHUTDOWN_DEADLINE_MS = 25_000;

// Plain `PORT`, like the knowledge services: a Service named
// knowledge-embedder makes Kubernetes inject KNOWLEDGE_EMBEDDER_PORT=tcp://…
// into every agents pod (docker-link-style), which would never parse as a
// number. MAX_BATCH/MODEL/MODEL_DIR stay prefixed — no Service can collide
// with those names.
const port = intFromEnv(process.env.PORT, 8080);
const maxBatch = intFromEnv(process.env.KNOWLEDGE_EMBEDDER_MAX_BATCH, 64);
const model = process.env.KNOWLEDGE_EMBEDDER_MODEL ?? "BAAI/bge-small-en-v1.5";
const modelDir = process.env.KNOWLEDGE_EMBEDDER_MODEL_DIR ?? "/app/model";
// ORT thread pool size; must match the pod's CPU limit (see src/embed.ts).
const threads = intFromEnv(process.env.KNOWLEDGE_EMBEDDER_THREADS, 4);
if (Number.isNaN(port) || Number.isNaN(maxBatch) || Number.isNaN(threads)) {
  logger.error("invalid configuration", {
    maxBatch,
    port,
    threads,
  });
  process.exit(1);
}

let ready = false;
let embed: ((inputs: string[]) => Promise<number[][]>) | null = null;
void (async (): Promise<void> => {
  const started = Date.now();
  try {
    embed = await createEmbed(modelDir, { threads });
    ready = true;
    logger.info("model loaded", {
      dir: modelDir,
      ms: Date.now() - started,
      threads,
    });
  } catch (error) {
    // A pod that cannot load its model is useless; crash so the rollout
    // surfaces it instead of serving 503s forever.
    logger.error("model load failed", {
      dir: modelDir,
      reason: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
})();

const app = createApp({
  embed: (inputs) => {
    if (embed === null) {
      return Promise.reject(new Error("model is still loading"));
    }
    return embed(inputs);
  },
  isReady: () => ready,
  logger,
  maxBatch,
  model,
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info("listening", { model, port: info.port });
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
