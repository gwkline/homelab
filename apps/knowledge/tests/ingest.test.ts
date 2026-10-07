import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256Hex } from "../src/chunk.ts";
import {
  createFakeEmbeddingProvider,
  createOpenAICompatibleProvider,
  EmbeddingProviderError,
  embeddingProviderFromEnv,
  embeddingVectorProblem,
  embedChunkTexts,
  embedWithRetries,
  isRetryableEmbeddingError,
  resolveEmbeddingWorkerConfig,
} from "../src/embedder.ts";
import type { EmbeddingProvider } from "../src/embedder.ts";
import {
  buildChunkUpsertQuery,
  buildDocumentCurrentVersionQuery,
  buildDocumentVersionIdQuery,
  buildSupersedeChunksQuery,
  processDocumentVersion,
} from "../src/ingest.ts";
import type { ChunkUpsertRow, IngestDocumentVersion } from "../src/ingest.ts";
import type { PgClient, PgPool } from "../src/pg-client.ts";
import { EMBEDDING_DIMENSIONS } from "../src/pgvector.ts";
import { fakePool } from "./fake-pool.ts";
import type { FakePool } from "./fake-pool.ts";

// --- fakes ---

interface RecordedClient {
  calls: FakePool["calls"];
  params: unknown[][];
  pool: PgPool;
  releases: FakePool["releases"];
  statements: string[];
}

interface ScriptedRows {
  rows: Record<string, unknown>[];
  text: string;
}

/**
 * Records every statement. Defaults mimic a fresh database; each scripted
 * entry (matched by substring) overrides one response, once.
 */
const stubClient = (script: ScriptedRows[] = []): RecordedClient => {
  const scripted = [...script];
  const params: unknown[][] = [];
  const statements: string[] = [];
  const client: PgClient = {
    query: (text: string, query: unknown[]) => {
      params.push(query);
      statements.push(text);
      const override = scripted.findIndex((entry) => text.includes(entry.text));
      if (override !== -1) {
        const [entry] = scripted.splice(override, 1);
        return Promise.resolve({ rows: entry?.rows ?? [] });
      }
      if (text.includes("ON CONFLICT (namespace, source, external_id)")) {
        return Promise.resolve({ rows: [{ id: query[0], version: 1 }] });
      }
      if (text.includes("INSERT INTO document_version")) {
        return Promise.resolve({ rows: [{ id: query[0] }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const { calls, pool, releases } = fakePool(client);
  return { calls, params, pool, releases, statements };
};

const fakeProvider = (
  poison?: (input: string) => number[] | null
): EmbeddingProvider => {
  const base = createFakeEmbeddingProvider("fake/test-model");
  if (poison === undefined) {
    return base;
  }
  return {
    ...base,
    embed: async (inputs, options) => {
      const vectors = await base.embed(inputs, options);
      return vectors.map(
        (vector, index) => poison(inputs[index] ?? "") ?? vector
      );
    },
  };
};

const PARAGRAPHS = [
  "first paragraph guards the distinctive S3cr3tBody token",
  "second paragraph is ordinary filler text here",
  "third paragraph adds more ordinary filler text",
].join("\n\n");

const baseDoc = (
  overrides: Partial<IngestDocumentVersion> = {}
): IngestDocumentVersion => ({
  content: PARAGRAPHS,
  documentId: "doc-1",
  externalId: "docs/readme.md",
  format: "text",
  namespace: "homelab-docs",
  source: "file",
  title: "Readme",
  url: null,
  versionId: "v7",
  ...overrides,
});

const chunkUpsertIndices = (recorded: RecordedClient): number[] =>
  recorded.statements
    .map((text, index) => (text.startsWith("INSERT INTO chunks") ? index : -1))
    .filter((index) => index >= 0);

const runHappyPath = async () => {
  const logs: Record<string, unknown>[] = [];
  const recorded = stubClient();
  const outcome = await processDocumentVersion(recorded.pool, baseDoc(), {
    config: resolveEmbeddingWorkerConfig({
      maxChars: 60,
      provider: createFakeEmbeddingProvider("fake/test-model"),
    }),
    jobId: "job-1",
    log: (entry) => {
      logs.push(entry);
    },
  });
  return { logs, outcome, recorded };
};

// --- worker pipeline: chunk → embed → persist ---

test("happy path writes the #56 document model before chunks", async () => {
  const { outcome, recorded } = await runHappyPath();
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.totalChunks, 3);
  assert.equal(outcome.embeddedCount, 3);
  assert.equal(outcome.model, "fake/test-model");
  assert.equal(outcome.documentId, "doc-1");
  assert.equal(outcome.versionId, "v7");

  const { calls, params, releases, statements } = recorded;
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  // One checkout carries the whole version swap and goes back clean.
  assert.ok(calls.every((call) => call.checkout === 1));
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
  // FK order: namespace → document → version → chunks → supersede.
  assert.match(statements[1] ?? "", /^INSERT INTO knowledge_namespace/u);
  assert.match(
    statements[2] ?? "",
    /ON CONFLICT \(namespace, source, external_id\) DO UPDATE/u
  );
  assert.match(statements[3] ?? "", /^INSERT INTO document_version/u);
  assert.match(
    statements.at(-2) ?? "",
    /^UPDATE chunks\s+SET valid_to = now\(\)/u
  );

  const [, namespace] = params;
  assert.deepEqual(namespace, ["homelab-docs", null]);

  const document = params.at(2);
  assert.deepEqual(document?.slice(0, 6), [
    "doc-1",
    "homelab-docs",
    "file",
    "docs/readme.md",
    "Readme",
    null,
  ]);
  assert.equal(document?.[6], sha256Hex(PARAGRAPHS));

  const version = params.at(3);
  assert.deepEqual(version, ["v7", "doc-1", 1, sha256Hex(PARAGRAPHS)]);
});

test("chunk upserts satisfy the #56 chunks contract and supersede keeps hashes", async () => {
  const { outcome, recorded } = await runHappyPath();
  const indices = chunkUpsertIndices(recorded);
  assert.equal(indices.length, outcome.totalChunks);

  const upsertText = recorded.statements[indices[0] ?? 0] ?? "";
  for (const column of [
    "chunk_id",
    "document_id",
    "version_id",
    "namespace",
    "idx",
    "text",
    "content_hash",
    "anchors",
    "embedding",
    "embedding_model",
    "chunker_version",
  ]) {
    assert.ok(upsertText.includes(column), `upsert must write ${column}`);
  }
  // Never a second row for the same text; the embedding pair moves as a pair.
  assert.match(
    upsertText,
    /ON CONFLICT \(document_id, content_hash\) DO UPDATE SET/u
  );
  assert.match(
    upsertText,
    /embedding = COALESCE\(EXCLUDED.embedding, chunks.embedding\)/u
  );
  assert.match(
    upsertText,
    /embedding_model = COALESCE\(EXCLUDED.embedding_model, chunks.embedding_model\)/u
  );

  const upserts = indices.map((index) => recorded.params[index] ?? []);
  for (const [position, row] of upserts.entries()) {
    const [
      chunkId,
      documentId,
      versionId,
      namespace,
      idx,
      text,
      contentHash,
      anchors,
      embedding,
      model,
      chunkerVersion,
    ] = row as [
      string,
      string,
      string,
      string,
      number,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    assert.match(chunkId, /^k_[0-9a-f]{32}$/u);
    assert.equal(documentId, "doc-1");
    assert.equal(versionId, "v7");
    assert.equal(namespace, "homelab-docs");
    assert.equal(idx, position, "idx is the 0-based chunk position");
    assert.ok(text.length > 0);
    assert.equal(contentHash, sha256Hex(text));
    const parsed = JSON.parse(anchors) as { type: string }[];
    assert.ok(parsed.some((anchor) => anchor.type === "offset"));
    assert.match(embedding, /^\[[\d.,-]+\]$/u);
    assert.equal(embedding.split(",").length, EMBEDDING_DIMENSIONS);
    assert.equal(model, "fake/test-model");
    assert.equal(chunkerVersion, "chunk-v1");
  }

  // Supersede keeps exactly this version's content hashes.
  const supersede = recorded.params.at(-2);
  assert.equal(supersede?.[0], "doc-1");
  assert.deepEqual(
    supersede?.[1],
    upserts.map((row) => row[6])
  );
});

test("reprocessing the same version derives identical chunk rows", async () => {
  const first = await runHappyPath();
  const second = await runHappyPath();
  const firstRows = chunkUpsertIndices(first.recorded).map(
    (index) => first.recorded.params[index]
  );
  const secondRows = chunkUpsertIndices(second.recorded).map(
    (index) => second.recorded.params[index]
  );
  assert.deepEqual(secondRows, firstRows);
  assert.deepEqual(
    second.recorded.params.at(-2)?.[1],
    first.recorded.params.at(-2)?.[1]
  );
});

test("unchanged content resolves the existing document and version rows", async () => {
  const recorded = stubClient([
    // The document upsert's DO UPDATE guard filters: content unchanged.
    { rows: [], text: "ON CONFLICT (namespace, source, external_id)" },
    {
      rows: [{ id: "doc-existing", version: 3 }],
      text: "SELECT id, version FROM document",
    },
    // History is never mutated: chunks must cite the existing version row.
    { rows: [], text: "INSERT INTO document_version" },
    {
      rows: [{ id: "v-existing" }],
      text: "SELECT id FROM document_version",
    },
  ]);
  const outcome = await processDocumentVersion(
    recorded.pool,
    baseDoc({ documentId: "doc-fresh", versionId: "v-fresh" }),
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 60,
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
    }
  );
  assert.equal(outcome.documentId, "doc-existing");
  assert.equal(outcome.versionId, "v-existing");
  for (const index of chunkUpsertIndices(recorded)) {
    const row = recorded.params[index] ?? [];
    assert.equal(row[1], "doc-existing");
    assert.equal(row[2], "v-existing");
  }
  assert.equal(recorded.params.at(-2)?.[0], "doc-existing");
  // The version append ran against the resolved document/version pair.
  assert.deepEqual(recorded.params[4], [
    "v-fresh",
    "doc-existing",
    3,
    sha256Hex(PARAGRAPHS),
  ]);
});

test("one invalid vector fails only its chunk; valid batchmates still embed", async () => {
  const provider = fakeProvider((input) =>
    input.includes("S3cr3tBody") ? [0.1, 0.2, 0.3] : null
  );
  const recorded = stubClient();
  const outcome = await processDocumentVersion(recorded.pool, baseDoc(), {
    config: resolveEmbeddingWorkerConfig({
      maxChars: 60,
      provider,
    }),
    jobId: "job-poison",
  });
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedChunks.length, 1);
  assert.match(
    outcome.failedChunks[0]?.reason ?? "",
    /3 dimensions, expected 384/u
  );
  assert.match(outcome.failedChunks[0]?.chunkId ?? "", /^k_[0-9a-f]{32}$/u);
  assert.equal(outcome.embeddedCount, 2);

  const upserts = chunkUpsertIndices(recorded).map(
    (index) => recorded.params[index] ?? []
  );
  const poisonedRow = upserts.find((row) =>
    (row[5] as string).includes("S3cr3tBody")
  );
  assert.ok(poisonedRow, "the failed chunk's text row is still persisted");
  assert.equal(poisonedRow[8], null, "no embedding for the invalid chunk");
  assert.equal(poisonedRow[9], null, "no model tag without an embedding");
  for (const row of upserts) {
    if (row !== poisonedRow) {
      assert.match(row[8] as string, /^\[/u);
      assert.equal(row[9], "fake/test-model");
    }
  }
});

test("logs carry job/document identifiers but never document bodies", async () => {
  const { logs, outcome } = await runHappyPath();
  const serialized = JSON.stringify(logs);
  assert.ok(logs.every((entry) => entry.jobId === "job-1"));
  assert.ok(serialized.includes("doc-1"));
  assert.ok(serialized.includes("v7"));
  assert.ok(
    !serialized.includes("S3cr3tBody"),
    "chunk text must never be logged"
  );
  assert.deepEqual(
    logs.map((entry) => entry.event),
    ["chunked", "embedded", "persisted"]
  );
  assert.equal(outcome.jobId, "job-1");
});

test("provider requests are batched and concurrency is capped", async () => {
  let inFlight = 0;
  let peak = 0;
  const sizes: number[] = [];
  const base = createFakeEmbeddingProvider("fake/test-model");
  const provider: EmbeddingProvider = {
    ...base,
    embed: async (inputs, options) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      sizes.push(inputs.length);
      try {
        return await base.embed(inputs, options);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.pool,
    baseDoc({
      content: ["aaaa", "bbbb", "cccc", "dddd", "eeee"].join("\n\n"),
      documentId: "doc-batches",
      versionId: "v1",
    }),
    {
      config: resolveEmbeddingWorkerConfig({
        batchSize: 2,
        concurrency: 2,
        maxChars: 5,
        provider,
      }),
    }
  );
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.totalChunks, 5);
  assert.deepEqual(sizes, [2, 2, 1], "batchSize bounds every provider request");
  assert.ok(peak <= 2, `concurrency must stay <= 2, peaked at ${peak}`);
});

test("retryable provider failures back off and recover", async () => {
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };
  const base = createFakeEmbeddingProvider("fake/test-model");
  let calls = 0;
  const flaky: EmbeddingProvider = {
    ...base,
    embed: (inputs, options) => {
      calls += 1;
      if (calls <= 2) {
        return Promise.reject(
          new EmbeddingProviderError("embedding provider returned HTTP 503", {
            retryable: true,
            status: 503,
          })
        );
      }
      return base.embed(inputs, options);
    },
  };
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.pool,
    baseDoc({ content: "retry me please", documentId: "doc-retry" }),
    {
      config: resolveEmbeddingWorkerConfig({
        baseDelayMs: 25,
        maxChars: 5,
        maxRetries: 3,
        provider: flaky,
      }),
      sleep,
    }
  );
  assert.equal(outcome.status, "ok");
  assert.equal(calls, 3, "two retries then success");
  assert.deepEqual(
    sleeps,
    [25, 50],
    "exponential backoff with injectable sleep"
  );
});

test("non-retryable 4xx fails fast; text rows still persist for BM25", async () => {
  const sleeps: number[] = [];
  const base = createFakeEmbeddingProvider("fake/test-model");
  let calls = 0;
  const stubborn: EmbeddingProvider = {
    ...base,
    embed: () => {
      calls += 1;
      return Promise.reject(
        new EmbeddingProviderError("embedding provider returned HTTP 400", {
          retryable: false,
          status: 400,
        })
      );
    },
  };
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.pool,
    baseDoc({ content: "doomed content", documentId: "doc-400" }),
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 100,
        maxRetries: 5,
        provider: stubborn,
      }),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }
  );
  assert.equal(calls, 1, "4xx must not be retried");
  assert.deepEqual(sleeps, []);
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedChunks.length, outcome.totalChunks);
  for (const index of chunkUpsertIndices(recorded)) {
    const row = recorded.params[index] ?? [];
    assert.equal(row[8], null, "no embedding for failed chunks");
    assert.equal(row[9], null, "no model tag without an embedding");
  }
});

test("database failure rolls the whole version swap back", async () => {
  let queries = 0;
  const failing: PgClient = {
    query: (text) => {
      queries += 1;
      if (text.startsWith("INSERT INTO chunks")) {
        return Promise.reject(new Error('relation "chunks" does not exist'));
      }
      if (text.includes("ON CONFLICT (namespace, source, external_id)")) {
        return Promise.resolve({ rows: [{ id: "doc-db", version: 1 }] });
      }
      if (text.startsWith("INSERT INTO document_version")) {
        return Promise.resolve({ rows: [{ id: "v1" }] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  const { calls, pool, releases } = fakePool(failing);
  await assert.rejects(
    processDocumentVersion(pool, baseDoc({ content: "alpha beta" }), {
      config: resolveEmbeddingWorkerConfig({
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
    }),
    /does not exist/u
  );
  assert.ok(queries >= 2);
  assert.equal(calls.at(-1)?.text, "ROLLBACK");
  assert.ok(calls.every((call) => call.checkout === 1));
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
});

// --- dimension honesty ---

test("dimension mismatches are refused before any persistence", () => {
  assert.throws(
    () =>
      resolveEmbeddingWorkerConfig({
        provider: createFakeEmbeddingProvider("fake/wide-model", 768),
      }),
    /vector\(384\).*re-embed backfill/su
  );
  assert.throws(
    () =>
      resolveEmbeddingWorkerConfig({
        dbDimensions: 1024,
        provider: createFakeEmbeddingProvider("fake/mismatch", 384),
      }),
    /vector\(1024\)/u
  );
});

// --- embed engine units ---

test("embedChunkTexts isolates unusable inputs from usable ones", async () => {
  const config = resolveEmbeddingWorkerConfig({
    batchSize: 10,
    concurrency: 1,
    provider: createFakeEmbeddingProvider("fake/test-model"),
  });
  const { embeddings, failures } = await embedChunkTexts(
    ["", "   ", "real text here"],
    config
  );
  assert.equal(embeddings.size, 1);
  assert.ok(embeddings.has(2));
  assert.match(failures.get(0) ?? "", /empty/u);
  assert.match(failures.get(1) ?? "", /empty/u);
});

test("embedChunkTexts batches in order and caps in-flight requests", async () => {
  const batches: string[][] = [];
  const base = createFakeEmbeddingProvider("fake/test-model");
  let inFlight = 0;
  let peak = 0;
  const provider: EmbeddingProvider = {
    ...base,
    embed: async (inputs, options) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      batches.push(inputs);
      try {
        return await base.embed(inputs, options);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const config = resolveEmbeddingWorkerConfig({
    batchSize: 2,
    concurrency: 2,
    provider,
  });
  const { embeddings } = await embedChunkTexts(["a", "b", "c"], config);
  assert.deepEqual(
    batches,
    [["a", "b"], ["c"]],
    "inputs batch in order at batchSize"
  );
  assert.equal(embeddings.size, 3);
  assert.equal(embeddings.get(2)?.length, EMBEDDING_DIMENSIONS);
  assert.ok(peak <= 2);
});

test("embeddingVectorProblem rejects wrong dims, non-finite, and zero vectors", () => {
  const dims = 4;
  assert.match(embeddingVectorProblem("nope", dims) ?? "", /not an array/u);
  assert.match(
    embeddingVectorProblem([1, 2], dims) ?? "",
    /2 dimensions, expected 4/u
  );
  assert.match(
    embeddingVectorProblem([1, Number.NaN, 0, 0], dims) ?? "",
    /entry 1/u
  );
  assert.match(
    embeddingVectorProblem([1, Infinity, 0, 0], dims) ?? "",
    /entry 1/u
  );
  assert.match(
    embeddingVectorProblem([0, 0, 0, 0], dims) ?? "",
    /zero vector/u
  );
  assert.equal(embeddingVectorProblem([0.5, -0.5, 0.5, -0.5], dims), null);
});

const timeoutEmbed = (): Promise<number[][]> => {
  const error = new Error("aborted");
  error.name = "TimeoutError";
  return Promise.reject(error);
};

test("embedWithRetries backs off per attempt and gives up after maxRetries", async () => {
  const sleeps: number[] = [];
  await assert.rejects(
    embedWithRetries(
      { dimensions: 2, embed: timeoutEmbed, model: "m", name: "t" },
      ["x"],
      {
        baseDelayMs: 5,
        maxRetries: 2,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        timeoutMs: 10,
      }
    ),
    /aborted/u
  );
  assert.deepEqual(sleeps, [5, 10]);
});

test("isRetryableEmbeddingError classifies transport vs protocol failures", () => {
  assert.equal(
    isRetryableEmbeddingError(
      new EmbeddingProviderError("HTTP 503", { retryable: true })
    ),
    true
  );
  assert.equal(
    isRetryableEmbeddingError(
      new EmbeddingProviderError("HTTP 400", { retryable: false, status: 400 })
    ),
    false
  );
  const timeout = new Error("timed out");
  timeout.name = "TimeoutError";
  assert.equal(isRetryableEmbeddingError(timeout), true);
  assert.equal(isRetryableEmbeddingError(new Error("boom")), false);
  assert.equal(isRetryableEmbeddingError("nope"), false);
});

// --- openai-compatible provider against a real localhost server ---

test("openai-compatible provider batches inputs, maps data, classifies errors", async () => {
  const { createServer } = await import("node:http");
  const requests: { auth: string | undefined; body: string; path: string }[] =
    [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += String(chunk);
    });
    request.on("end", () => {
      requests.push({
        auth: request.headers.authorization,
        body,
        path: request.url ?? "",
      });
      if (request.url === "/v1/bad/embeddings") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (request.url === "/v1/auth/embeddings") {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "nope" }));
        return;
      }
      if (request.url === "/v1/short/embeddings") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [{ embedding: [1, 2], index: 0 }] })
        );
        return;
      }
      const parsed = JSON.parse(body) as { input: string[] };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: parsed.input.map((_, index) => ({
            embedding: [0.1 * (index + 1), -0.2, 0.3, 0.4],
            index,
          })),
        })
      );
    });
  });
  const { once } = await import("node:events");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  try {
    const provider = createOpenAICompatibleProvider({
      apiKey: "secret-token",
      baseUrl,
      dimensions: 4,
      model: "test-embed",
    });
    const vectors = await provider.embed(["first", "second"]);
    assert.equal(requests[0]?.path, "/v1/embeddings");
    assert.equal(requests[0]?.auth, "Bearer secret-token");
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), {
      input: ["first", "second"],
      model: "test-embed",
    });
    assert.equal(vectors.length, 2);
    assert.deepEqual(vectors[0], [0.1, -0.2, 0.3, 0.4]);
    assert.deepEqual(vectors[1], [0.2, -0.2, 0.3, 0.4]);

    await assert.rejects(
      createOpenAICompatibleProvider({
        baseUrl: `${baseUrl}/bad`,
        dimensions: 4,
        model: "m",
      }).embed(["x"]),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        error.retryable &&
        error.status === 500
    );
    await assert.rejects(
      createOpenAICompatibleProvider({
        apiKey: "k",
        baseUrl: `${baseUrl}/auth`,
        dimensions: 4,
        model: "m",
      }).embed(["x"]),
      (error: unknown) =>
        error instanceof EmbeddingProviderError &&
        !error.retryable &&
        error.status === 401
    );
    await assert.rejects(
      createOpenAICompatibleProvider({
        baseUrl: `${baseUrl}/short`,
        dimensions: 4,
        model: "m",
      }).embed(["x", "y"]),
      /1 vectors for 2 inputs/u
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});

// --- config + env selection ---

test("embedding worker config validates every explicit limit", () => {
  const provider = createFakeEmbeddingProvider("fake/ok");
  const config = resolveEmbeddingWorkerConfig({
    baseDelayMs: 5,
    batchSize: 7,
    concurrency: 3,
    maxRetries: 1,
    provider,
    timeoutMs: 250,
  });
  assert.deepEqual(
    [
      config.batchSize,
      config.concurrency,
      config.timeoutMs,
      config.maxRetries,
      config.baseDelayMs,
      config.dbDimensions,
    ],
    [7, 3, 250, 1, 5, EMBEDDING_DIMENSIONS]
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ batchSize: 0, provider }),
    /batchSize/u
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ concurrency: 0, provider }),
    /concurrency/u
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ provider, timeoutMs: 0 }),
    /timeoutMs/u
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ maxRetries: -1, provider }),
    /maxRetries/u
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ baseDelayMs: -1, provider }),
    /baseDelayMs/u
  );
  assert.throws(
    () => resolveEmbeddingWorkerConfig({ maxChars: 0, provider }),
    /maxChars/u
  );
});

test("provider, model, and dimensions come from configuration", () => {
  const fake = embeddingProviderFromEnv({});
  assert.equal(fake.name, "fake");
  assert.equal(fake.model, "fake/384", "fake vectors carry a fake tag");
  assert.equal(fake.dimensions, EMBEDDING_DIMENSIONS);

  const configured = embeddingProviderFromEnv({
    KNOWLEDGE_EMBEDDING_DIMENSIONS: "4",
    KNOWLEDGE_EMBEDDING_MODEL: "BAAI/bge-small-en-v1.5",
    KNOWLEDGE_EMBEDDING_PROVIDER: "fake",
  });
  assert.equal(
    configured.model,
    "fake/4",
    "a configured model name never lands on fake vectors"
  );
  assert.equal(configured.dimensions, 4);
  assert.throws(
    () => createFakeEmbeddingProvider("BAAI/bge-small-en-v1.5"),
    /must start with fake\//u
  );
  assert.throws(
    () => embeddingProviderFromEnv({ KNOWLEDGE_EMBEDDING_PROVIDER: "quantum" }),
    /unknown KNOWLEDGE_EMBEDDING_PROVIDER/u
  );
  assert.throws(
    () => embeddingProviderFromEnv({ KNOWLEDGE_EMBEDDING_PROVIDER: "openai" }),
    /KNOWLEDGE_EMBEDDING_BASE_URL/u
  );
  const openai = embeddingProviderFromEnv({
    KNOWLEDGE_EMBEDDING_BASE_URL: "http://embeddings.svc:80/v1",
    KNOWLEDGE_EMBEDDING_PROVIDER: "openai",
  });
  assert.equal(openai.name, "openai-compatible");
  assert.equal(openai.model, "BAAI/bge-small-en-v1.5");
  assert.throws(
    () =>
      resolveEmbeddingWorkerConfig({
        provider: embeddingProviderFromEnv({
          KNOWLEDGE_EMBEDDING_DIMENSIONS: "4",
          KNOWLEDGE_EMBEDDING_PROVIDER: "fake",
        }),
      }),
    /vector\(384\)/u
  );
});

// --- version swap + supersession semantics ---

test("re-ingesting a changed version supersedes the dropped content hashes", async () => {
  const v1 = await runHappyPath();
  const v1Keep = v1.recorded.params.at(-2)?.[1] as string[];
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.pool,
    baseDoc({
      content: "totally different content now",
      versionId: "v8",
    }),
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 500,
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
      jobId: "job-2",
    }
  );
  assert.equal(outcome.versionId, "v8");
  assert.ok(outcome.totalChunks >= 1);
  const supersede = recorded.params.at(-2);
  assert.equal(supersede?.[0], "doc-1");
  const keep = supersede?.[1] as string[];
  assert.equal(keep.length, outcome.totalChunks);
  assert.ok(keep.every((hash) => /^[0-9a-f]{64}$/u.test(hash)));
  assert.ok(
    keep.every((hash) => !v1Keep.includes(hash)),
    "changed content re-hashes every chunk"
  );
});

test("chunk upsert and supersede builders validate their inputs", () => {
  const valid: ChunkUpsertRow = {
    anchors: [],
    chunkId: "k_abc",
    chunkerVersion: "chunk-v1",
    contentHash: "a".repeat(64),
    documentId: "d",
    embedding: null,
    embeddingModel: null,
    idx: 0,
    namespace: "n",
    text: "t",
    versionId: "v",
  };
  assert.throws(
    () => buildChunkUpsertQuery({ ...valid, embedding: [0, 0] }),
    /together or neither/u
  );
  assert.throws(
    () => buildChunkUpsertQuery({ ...valid, embeddingModel: "m" }),
    /together or neither/u
  );
  assert.throws(
    () => buildChunkUpsertQuery({ ...valid, chunkerVersion: "" }),
    /chunkerVersion/u
  );
  assert.throws(
    () => buildChunkUpsertQuery({ ...valid, contentHash: "nope" }),
    /contentHash/u
  );
  assert.throws(() => buildChunkUpsertQuery({ ...valid, idx: -1 }), /idx/u);
  assert.throws(() => buildChunkUpsertQuery({ ...valid, text: "" }), /text/u);
  assert.throws(
    () => buildChunkUpsertQuery({ ...valid, namespace: "bad ns" }),
    /namespace/u
  );

  const supersede = buildSupersedeChunksQuery("doc-1", ["b".repeat(64)]);
  assert.match(supersede.text, /NOT \(content_hash = ANY\(\$2\)\)/u);
  assert.deepEqual(supersede.params, ["doc-1", ["b".repeat(64)]]);
  assert.throws(
    () => buildSupersedeChunksQuery("doc-1", ["not-a-hash"]),
    /sha256/u
  );
  assert.throws(() => buildSupersedeChunksQuery("", []), /documentId/u);

  const current = buildDocumentCurrentVersionQuery("ns", "file", "a.md");
  assert.deepEqual(current.params, ["ns", "file", "a.md"]);
  assert.match(
    current.text,
    /SELECT id, version FROM document\s+WHERE namespace = \$1 AND source = \$2 AND external_id = \$3/u
  );
  assert.throws(
    () => buildDocumentCurrentVersionQuery("bad ns!", "file", "a.md"),
    /namespace/u
  );

  const versionId = buildDocumentVersionIdQuery("doc-1", 3);
  assert.deepEqual(versionId.params, ["doc-1", 3]);
  assert.match(
    versionId.text,
    /SELECT id FROM document_version\s+WHERE document_id = \$1 AND version = \$2/u
  );
  assert.throws(() => buildDocumentVersionIdQuery("doc-1", 0), /version/u);
});
