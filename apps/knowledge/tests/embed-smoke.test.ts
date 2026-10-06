import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOpenAICompatibleProvider,
  embedWithRetries,
} from "../src/embedder.ts";

/**
 * Opt-in smoke test against the real selected provider (#57). Everything
 * else in this package runs on deterministic fakes; this test is skipped
 * unless explicitly pointed at a live, self-hosted embeddings endpoint:
 *
 *   KNOWLEDGE_EMBEDDING_SMOKE_URL=http://tei.home.svc:80/v1 \
 *   KNOWLEDGE_EMBEDDING_SMOKE_MODEL=BAAI/bge-small-en-v1.5 \
 *   npm test
 *
 * It exercises the same contract the worker relies on: batched inputs,
 * explicit timeout/retry limits, and vectors that match the configured
 * dimension — never a silently wrong shape.
 */

const smokeUrl = process.env.KNOWLEDGE_EMBEDDING_SMOKE_URL;

test(
  "smoke: the real selected provider embeds a small batch",
  {
    skip:
      smokeUrl === undefined
        ? "opt-in: set KNOWLEDGE_EMBEDDING_SMOKE_URL (and optionally _MODEL/_DIMENSIONS/_API_KEY) to run"
        : false,
  },
  async () => {
    const model = process.env.KNOWLEDGE_EMBEDDING_SMOKE_MODEL ?? "default";
    const dimensions = Number(
      process.env.KNOWLEDGE_EMBEDDING_SMOKE_DIMENSIONS ?? "384"
    );
    assert.ok(
      Number.isInteger(dimensions) && dimensions > 0,
      "KNOWLEDGE_EMBEDDING_SMOKE_DIMENSIONS must be a positive integer"
    );
    const apiKey = process.env.KNOWLEDGE_EMBEDDING_SMOKE_API_KEY;
    const baseUrl = smokeUrl ?? "";
    const provider = createOpenAICompatibleProvider({
      baseUrl,
      dimensions,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    const inputs = ["citation anchor smoke test", "second deterministic probe"];
    const vectors = await embedWithRetries(provider, inputs, {
      maxRetries: 2,
      timeoutMs: 10_000,
    });
    assert.equal(vectors.length, inputs.length);
    for (const vector of vectors) {
      assert.equal(vector.length, dimensions, "dimension must match config");
      let sumOfSquares = 0;
      for (const value of vector) {
        assert.ok(Number.isFinite(value));
        sumOfSquares += value * value;
      }
      assert.ok(sumOfSquares > 0, "provider must not return a zero vector");
    }
    // Same text, same model → the same vector (within float tolerance).
    const repeat = await provider.embed([inputs[0] ?? ""]);
    const first = vectors[0] ?? [];
    const repeated = repeat[0] ?? [];
    assert.equal(repeated.length, dimensions);
    const maxDelta = Math.max(
      ...repeated.map((value, index) => Math.abs(value - (first[index] ?? 0)))
    );
    assert.ok(
      maxDelta <= 1e-6,
      `provider is not deterministic: max delta ${String(maxDelta)}`
    );
  }
);
