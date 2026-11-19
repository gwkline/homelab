/**
 * OpenAI-compatible `/embeddings` surface for the knowledge services. The
 * caller is `src/embedder.ts` in apps/knowledge (`createOpenAICompatibleProvider`),
 * so the response contract is exactly what that provider parses: a `data`
 * array with one `embedding` per input, in order. No auth — ingress is
 * NetworkPolicy-gated to the knowledge-ingest and knowledge-retrieval pods,
 * and the sidecar holds no state worth protecting with a token it would have
 * to share with its only two callers anyway.
 */

import { Hono } from "hono";

import type { Logger } from "./log.ts";

export interface EmbedderDeps {
  /** One vector per input, in order. */
  embed: (inputs: string[]) => Promise<number[][]>;
  /** /readyz answers 503 until the model has loaded. */
  isReady: () => boolean;
  logger: Logger;
  /** The model string callers must send; stored on every chunk they embed. */
  model: string;
  /** Refused before any inference; the knowledge engine batches at most 32. */
  maxBatch: number;
}

interface ErrorBody {
  error: { code: string; message: string };
}

const errorResponse = (
  code: string,
  message: string,
  status: number
): { body: ErrorBody; status: number } => ({
  body: { error: { code, message } },
  status,
});

/** OpenAI accepts one string or an array; the provider always sends arrays. */
const readInput = (value: unknown): string[] | null => {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : null;
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  ) {
    return value;
  }
  return null;
};

// ~4 characters per token; only the caller's usage display ever reads it.
const estimateTokens = (inputs: string[]): number =>
  inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0);

export const createApp = (deps: EmbedderDeps): Hono => {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/readyz", (c) =>
    deps.isReady()
      ? c.json({ status: "ok" })
      : c.json({ status: "loading" }, 503)
  );

  app.post("/embeddings", async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(
        errorResponse("invalid_json", "request body is not valid JSON", 400)
          .body,
        400
      );
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return c.json(
        errorResponse(
          "invalid_request",
          "request body must be a JSON object",
          400
        ).body,
        400
      );
    }
    const { input, model } = payload as { input?: unknown; model?: unknown };
    const inputs = readInput(input);
    if (inputs === null) {
      return c.json(
        errorResponse(
          "invalid_input",
          "input must be a non-empty string or an array of non-empty strings",
          400
        ).body,
        400
      );
    }
    if (model !== deps.model) {
      return c.json(
        errorResponse(
          "unknown_model",
          `model must be "${deps.model}", got ${JSON.stringify(model)}`,
          400
        ).body,
        400
      );
    }
    if (inputs.length > deps.maxBatch) {
      return c.json(
        errorResponse(
          "batch_too_large",
          `input has ${inputs.length} entries; the limit is ${deps.maxBatch}`,
          400
        ).body,
        400
      );
    }

    const started = Date.now();
    let vectors: number[][];
    try {
      vectors = await deps.embed(inputs);
    } catch (error) {
      // The reason stays in the server log; callers get a stable message.
      deps.logger.error("embedding failed", {
        count: inputs.length,
        ms: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      });
      return c.json(
        errorResponse(
          "embed_failed",
          "the embedding model failed; see the server logs",
          500
        ).body,
        500
      );
    }
    const data = vectors.map((embedding, index) => ({ embedding, index }));
    deps.logger.info("embedded", {
      count: inputs.length,
      dims: (vectors[0] ?? []).length,
      ms: Date.now() - started,
    });
    return c.json({
      data,
      model: deps.model,
      usage: {
        prompt_tokens: estimateTokens(inputs),
        total_tokens: estimateTokens(inputs),
      },
    });
  });

  return app;
};
