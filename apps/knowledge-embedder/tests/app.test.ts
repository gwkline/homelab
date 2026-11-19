import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.ts";
import type { Logger } from "../src/log.ts";

const noop = (): void => {};

const logger: Logger = {
  error: noop,
  info: noop,
  warn: noop,
};

const dims = 4;

const fakeEmbed = (inputs: string[]): Promise<number[][]> =>
  Promise.resolve(
    inputs.map((input, index) => {
      const seed = input.length + index;
      return Array.from({ length: dims }, (_, i) => (seed + i) / 100);
    })
  );

const buildApp = (overrides: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({
    embed: fakeEmbed,
    isReady: () => true,
    logger,
    maxBatch: 3,
    model: "BAAI/bge-small-en-v1.5",
    ...overrides,
  });

const post = async (
  app: ReturnType<typeof createApp>,
  body: string
): Promise<Response> =>
  app.request("/embeddings", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

test("valid batch: one data entry per input, in order", async () => {
  const res = await post(
    buildApp(),
    JSON.stringify({
      input: ["alpha", "beta", "gamma"],
      model: "BAAI/bge-small-en-v1.5",
    })
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  };
  assert.equal(payload.data.length, 3);
  for (const [i, entry] of payload.data.entries()) {
    assert.equal(entry.index, i);
    assert.equal(entry.embedding.length, dims);
  }
  assert.equal(payload.model, "BAAI/bge-small-en-v1.5");
  assert.ok(payload.usage.prompt_tokens > 0);
});

test("a single string input is accepted like the OpenAI API does", async () => {
  const res = await post(
    buildApp(),
    JSON.stringify({ input: "alpha", model: "BAAI/bge-small-en-v1.5" })
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { data: unknown[] };
  assert.equal(payload.data.length, 1);
});

test("readiness gates /readyz", async () => {
  const app = buildApp({ isReady: () => false });
  const notReady = await app.request("/readyz");
  assert.equal(notReady.status, 503);
  assert.equal(
    ((await notReady.json()) as { status: string }).status,
    "loading"
  );
  const ready = await buildApp({ isReady: () => true }).request("/readyz");
  assert.equal(ready.status, 200);
});

test("/healthz answers unconditionally", async () => {
  const res = await buildApp({ isReady: () => false }).request("/healthz");
  assert.equal(res.status, 200);
});

const expectBadRequest = async (body: string, code: string): Promise<void> => {
  const res = await post(buildApp(), body);
  assert.equal(res.status, 400);
  const payload = (await res.json()) as { error: { code: string } };
  assert.equal(payload.error.code, code);
};

test("invalid JSON body is a 400", async () => {
  const res = await post(buildApp(), "{not json");
  assert.equal(res.status, 400);
  const payload = (await res.json()) as { error: { code: string } };
  assert.equal(payload.error.code, "invalid_json");
});

test("an array body is a 400", async () => {
  await expectBadRequest(JSON.stringify(["alpha"]), "invalid_request");
});

test("empty or non-string input is a 400", async () => {
  await expectBadRequest(
    JSON.stringify({ input: [], model: "BAAI/bge-small-en-v1.5" }),
    "invalid_input"
  );
  await expectBadRequest(
    JSON.stringify({ input: "", model: "BAAI/bge-small-en-v1.5" }),
    "invalid_input"
  );
  await expectBadRequest(
    JSON.stringify({ input: ["ok", 7], model: "BAAI/bge-small-en-v1.5" }),
    "invalid_input"
  );
  await expectBadRequest(
    JSON.stringify({ model: "BAAI/bge-small-en-v1.5" }),
    "invalid_input"
  );
});

test("a model string that is not the served one is a 400", async () => {
  await expectBadRequest(
    JSON.stringify({ input: ["alpha"], model: "other/model" }),
    "unknown_model"
  );
});

test("batches beyond maxBatch are refused before inference", async () => {
  await expectBadRequest(
    JSON.stringify({
      input: ["a", "b", "c", "d"],
      model: "BAAI/bge-small-en-v1.5",
    }),
    "batch_too_large"
  );
});

test("an embed failure is a stable 500 without internals", async () => {
  const app = buildApp({
    embed: () => Promise.reject(new Error("secret ONNX detail")),
  });
  const res = await post(
    app,
    JSON.stringify({ input: ["alpha"], model: "BAAI/bge-small-en-v1.5" })
  );
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.equal(
    (JSON.parse(text) as { error: { code: string } }).error.code,
    "embed_failed"
  );
  assert.ok(!text.includes("ONNX"));
});
