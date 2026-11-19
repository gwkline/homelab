import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmbed } from "../src/embed.ts";

/**
 * Opt-in smoke test against the real model on disk; skipped otherwise:
 *
 *   KNOWLEDGE_EMBEDDER_MODEL_DIR=./model npm test -w apps/knowledge-embedder
 *
 * Fetch the model with the command in the app README first. CI has no model
 * and stays on the app-level tests.
 */
const modelDir = process.env.KNOWLEDGE_EMBEDDER_MODEL_DIR;

const cosine = (a: number[], b: number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);

test(
  "smoke: bge-small-en-v1.5 embeds, normalizes, and truncates at 512 tokens",
  {
    skip:
      modelDir === undefined
        ? "opt-in: set KNOWLEDGE_EMBEDDER_MODEL_DIR to a local model checkout to run"
        : false,
  },
  async () => {
    const embed = await createEmbed(modelDir ?? "");
    const vectors = await embed([
      "A man is eating food.",
      "A person is consuming a meal.",
      "The stock market rallied today.",
    ]);
    assert.equal(vectors.length, 3);
    for (const vector of vectors) {
      assert.equal(vector.length, 384);
      const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0)
      );
      assert.ok(Math.abs(norm - 1) < 1e-3, `vector not normalized: ${norm}`);
    }
    const paraphrase = cosine(vectors[0] ?? [], vectors[1] ?? []);
    const unrelated = cosine(vectors[0] ?? [], vectors[2] ?? []);
    assert.ok(
      paraphrase > unrelated + 0.2,
      `paraphrase (${paraphrase}) should clearly beat unrelated (${unrelated})`
    );

    // Inputs past the tokenizer's 512-token limit are truncated, so the same
    // text repeated past the limit embeds identically.
    const truncated = await embed([
      "database ".repeat(600),
      "database ".repeat(1500),
    ]);
    const similarity = cosine(truncated[0] ?? [], truncated[1] ?? []);
    assert.ok(
      similarity > 0.999,
      `inputs past the token limit must truncate identically, got ${similarity}`
    );
  }
);
