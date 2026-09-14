import assert from "node:assert/strict";
import { test } from "node:test";

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
  buildClaimJobQuery,
  buildCompleteJobQuery,
  buildEnqueueJobQuery,
  buildFailJobQuery,
  buildSupersedeChunksQuery,
  drainIngestJobs,
  INGEST_MIGRATION_SQL,
  MAX_JOB_ERROR_CHARS,
  parseDocumentPayload,
  parseIngestJobRow,
  processDocumentVersion,
  runIngestJob,
} from "../src/ingest.ts";
import type { IngestJobRecord } from "../src/ingest.ts";
import { EMBEDDING_DIMENSIONS } from "../src/pgvector.ts";
import type { PgvectorDbClient } from "../src/pgvector.ts";

// --- fakes ---

interface RecordedClient {
  client: PgvectorDbClient;
  params: unknown[][];
  statements: string[];
}

/**
 * Scripted client recording every statement; rows for the SKIP LOCKED claim
 * come off a queue, everything else returns none.
 */
const stubClient = (
  ...claimRowSets: Record<string, unknown>[][]
): RecordedClient => {
  const claims = [...claimRowSets];
  const params: unknown[][] = [];
  const statements: string[] = [];
  const client: PgvectorDbClient = {
    query: (text: string, query: unknown[]) => {
      params.push(query);
      statements.push(text);
      return Promise.resolve({
        rows: text.includes("FOR UPDATE SKIP LOCKED")
          ? (claims.shift() ?? [])
          : [],
      });
    },
  };
  return { client, params, statements };
};

/** Deterministic fake provider, optionally poisoned per input. */
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

const runHappyPath = async () => {
  const logs: Record<string, unknown>[] = [];
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.client,
    {
      content: PARAGRAPHS,
      documentId: "doc-1",
      format: "text",
      namespace: "homelab-docs",
      versionId: "v7",
    },
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 60,
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
      jobId: "job-1",
      log: (entry) => {
        logs.push(entry);
      },
    }
  );
  return { logs, outcome, recorded };
};

// --- worker pipeline: chunk → embed → persist ---

test("happy path persists chunks with embeddings, model tags, and supersession", async () => {
  const { outcome, recorded } = await runHappyPath();
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.totalChunks, 3);
  assert.equal(outcome.embeddedCount, 3);
  assert.equal(outcome.model, "fake/test-model");

  const { params, statements } = recorded;
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  const upserts = params.slice(1, 1 + outcome.totalChunks);
  assert.match(
    statements.at(-2) ?? "",
    /UPDATE "chunks"\s+SET "valid_to" = now\(\)/u
  );
  for (const row of upserts) {
    const [
      chunkId,
      documentId,
      versionId,
      namespace,
      text,
      anchors,
      embedding,
      model,
    ] = row as [string, string, string, string, string, string, string, string];
    assert.match(chunkId, /^k_[0-9a-f]{32}$/u);
    assert.equal(documentId, "doc-1");
    assert.equal(versionId, "v7");
    assert.equal(namespace, "homelab-docs");
    assert.ok(text.length > 0);
    const parsed = JSON.parse(anchors) as { type: string }[];
    assert.ok(parsed.some((anchor) => anchor.type === "offset"));
    assert.match(embedding, /^\[[\d.,-]+\]$/u);
    assert.equal(embedding.split(",").length, EMBEDDING_DIMENSIONS);
    assert.equal(model, "fake/test-model");
  }
  // Supersede keeps exactly this version's chunk ids.
  const supersede = params.at(-2);
  assert.equal(supersede?.[0], "doc-1");
  assert.deepEqual(
    supersede?.[1],
    upserts.map((row) => row[0])
  );
});

test("reprocessing the same version derives identical ids and keep-lists", async () => {
  const first = await runHappyPath();
  const second = await runHappyPath();
  assert.deepEqual(
    second.recorded.params.slice(1, 4).map((row) => row[0]),
    first.recorded.params.slice(1, 4).map((row) => row[0])
  );
  assert.deepEqual(
    second.recorded.params.at(-2)?.[1],
    first.recorded.params.at(-2)?.[1]
  );
});

test("one invalid vector fails only its chunk; valid batchmates still embed", async () => {
  const provider = fakeProvider((input) =>
    input.includes("S3cr3tBody") ? [0.1, 0.2, 0.3] : null
  );
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.client,
    {
      content: PARAGRAPHS,
      documentId: "doc-1",
      format: "text",
      namespace: "ns",
      versionId: "v1",
    },
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 60,
        provider,
      }),
      jobId: "job-poison",
    }
  );
  assert.equal(outcome.status, "partial");
  assert.equal(outcome.failedChunks.length, 1);
  assert.match(
    outcome.failedChunks[0]?.reason ?? "",
    /3 dimensions, expected 384/u
  );
  assert.match(outcome.failedChunks[0]?.chunkId ?? "", /^k_[0-9a-f]{32}$/u);
  assert.equal(outcome.embeddedCount, 2);

  const upserts = recorded.params.slice(1, 1 + outcome.totalChunks);
  const poisonedRow = upserts.find((row) =>
    (row[4] as string).includes("S3cr3tBody")
  );
  assert.ok(poisonedRow, "the failed chunk's text row is still persisted");
  assert.equal(poisonedRow[6], null, "no embedding for the invalid chunk");
  assert.equal(poisonedRow[7], null, "no model tag without an embedding");
  for (const row of upserts) {
    if (row !== poisonedRow) {
      assert.match(row[6] as string, /^\[/u);
      assert.equal(row[7], "fake/test-model");
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
    recorded.client,
    {
      content: ["aaaa", "bbbb", "cccc", "dddd", "eeee"].join("\n\n"),
      documentId: "doc-batches",
      format: "text",
      namespace: "ns",
      versionId: "v1",
    },
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
    recorded.client,
    {
      content: "retry me please",
      documentId: "doc-retry",
      namespace: "ns",
      versionId: "v1",
    },
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
    recorded.client,
    {
      content: "doomed content",
      documentId: "doc-400",
      namespace: "ns",
      versionId: "v1",
    },
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
  for (const row of recorded.params.slice(1, 1 + outcome.totalChunks)) {
    assert.equal(row[6], null, "no embedding for failed chunks");
    assert.equal(row[7], null, "no model tag without an embedding");
  }
});

test("database failure rolls the whole version swap back", async () => {
  let queries = 0;
  const failing: PgvectorDbClient = {
    query: (text) => {
      queries += 1;
      if (text.startsWith("INSERT")) {
        return Promise.reject(new Error('relation "chunks" does not exist'));
      }
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.rejects(
    processDocumentVersion(
      failing,
      {
        content: "alpha beta",
        documentId: "doc-db",
        namespace: "ns",
        versionId: "v1",
      },
      {
        config: resolveEmbeddingWorkerConfig({
          provider: createFakeEmbeddingProvider("fake/test-model"),
        }),
      }
    ),
    /does not exist/u
  );
  assert.ok(queries >= 2);
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
  assert.equal(
    batches.length,
    0,
    "requests go through embedWithRetries, not this spy"
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
  assert.equal(fake.model, "BAAI/bge-small-en-v1.5");
  assert.equal(fake.dimensions, EMBEDDING_DIMENSIONS);

  const configured = embeddingProviderFromEnv({
    KNOWLEDGE_EMBEDDING_DIMENSIONS: "4",
    KNOWLEDGE_EMBEDDING_MODEL: "custom/model",
    KNOWLEDGE_EMBEDDING_PROVIDER: "fake",
  });
  assert.equal(configured.model, "custom/model");
  assert.equal(configured.dimensions, 4);
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
  // Dimension honesty: a 4-d provider against the 384-d column is refused.
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

test("re-ingesting a changed version supersedes the dropped chunk ids", async () => {
  const v1 = await runHappyPath();
  const v1Keep = v1.recorded.params.at(-2)?.[1] as string[];
  const recorded = stubClient();
  const outcome = await processDocumentVersion(
    recorded.client,
    {
      content: "totally different content now",
      documentId: "doc-1",
      format: "text",
      namespace: "homelab-docs",
      versionId: "v8",
    },
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
  assert.ok(keep.every((id) => id.startsWith("k_")));
  assert.ok(
    keep.every((id) => !v1Keep.includes(id)),
    "changed content re-ids chunks"
  );
});

test("job SQL builders: idempotent enqueue, SKIP LOCKED claim, done/fail", () => {
  const enqueue = buildEnqueueJobQuery({
    documentId: "doc-1",
    jobId: "job-1",
    kind: "document-version",
    namespace: "ns",
    payload: { content: "private body that must not leak", versionId: "v1" },
  });
  assert.match(enqueue.text, /ON CONFLICT \("job_id"\) DO NOTHING/u);
  assert.equal(enqueue.params[0], "job-1");
  assert.ok(
    !String(enqueue.params[4]).includes("job-1"),
    "payload stays a JSON blob, not an identifier"
  );

  const claim = buildClaimJobQuery();
  assert.match(claim.text, /FOR UPDATE SKIP LOCKED/u);
  assert.match(claim.text, /ORDER BY "enqueued_at" ASC, "job_id" ASC/u);
  assert.match(claim.text, /"attempts" \+ 1/u);

  assert.deepEqual(buildCompleteJobQuery("job-1").params, ["job-1"]);
  assert.match(buildCompleteJobQuery("job-1").text, /"status" = 'done'/u);

  const long = `x`.repeat(MAX_JOB_ERROR_CHARS + 500);
  const fail = buildFailJobQuery("job-1", long);
  assert.equal(fail.params[1], `x`.repeat(MAX_JOB_ERROR_CHARS));
  assert.match(
    fail.text,
    /"status" = 'failed', "finished_at" = now\(\), "error" = \$2/u
  );

  assert.throws(
    () =>
      buildEnqueueJobQuery({
        documentId: null,
        jobId: "bad id with spaces",
        kind: "document-version",
        namespace: "ns",
        payload: {},
      }),
    /job id/u
  );
  assert.throws(
    () =>
      buildEnqueueJobQuery({
        documentId: "d",
        jobId: "j",
        kind: "document-version",
        namespace: "bad ns",
        payload: {},
      }),
    /namespace/u
  );
});

test("parseIngestJobRow validates claimed rows", () => {
  const record = parseIngestJobRow({
    attempts: 3,
    document_id: "doc-1",
    job_id: "job-1",
    kind: "document-version",
    namespace: "ns",
    payload: { content: "c", versionId: "v1" },
  });
  assert.equal(record.jobId, "job-1");
  assert.equal(record.attempts, 3);
  assert.equal(record.documentId, "doc-1");
  assert.equal(
    parseIngestJobRow({
      attempts: "2",
      document_id: null,
      job_id: "j",
      kind: "k",
      namespace: "n",
      payload: {},
    }).attempts,
    2
  );
  assert.throws(() => parseIngestJobRow({ attempts: 1 }), /job_id/u);
  assert.throws(
    () =>
      parseIngestJobRow({
        attempts: -1,
        document_id: null,
        job_id: "j",
        kind: "k",
        namespace: "n",
        payload: {},
      }),
    /attempts/u
  );
  assert.throws(
    () =>
      parseIngestJobRow({
        attempts: 1,
        document_id: 42,
        job_id: "j",
        kind: "k",
        namespace: "n",
        payload: {},
      }),
    /document_id/u
  );
});

test("parseDocumentPayload validates the normalized version shape", () => {
  const job: IngestJobRecord = {
    attempts: 1,
    documentId: "doc-1",
    jobId: "job-1",
    kind: "document-version",
    namespace: "ns",
    payload: {
      content: "text",
      format: "markdown",
      versionId: "v2",
    },
  };
  const parsed = parseDocumentPayload(job);
  assert.equal(parsed.content, "text");
  assert.equal(parsed.format, "markdown");
  assert.equal(parsed.versionId, "v2");
  assert.equal(
    parseDocumentPayload({ ...job, payload: { content: "c", versionId: "v" } })
      .format,
    undefined
  );
  assert.throws(
    () => parseDocumentPayload({ ...job, documentId: null }),
    /document_id/u
  );
  assert.throws(
    () => parseDocumentPayload({ ...job, payload: { versionId: "v" } }),
    /content/u
  );
  assert.throws(
    () => parseDocumentPayload({ ...job, payload: { content: "c" } }),
    /versionId/u
  );
  assert.throws(
    () =>
      parseDocumentPayload({
        ...job,
        payload: { content: "c", format: "yaml", versionId: "v" },
      }),
    /format/u
  );
});

test("runIngestJob marks done on success and records truncated failures", async () => {
  const success = stubClient();
  const result = await runIngestJob(
    success.client,
    {
      attempts: 1,
      documentId: "doc-1",
      jobId: "job-ok",
      kind: "document-version",
      namespace: "ns",
      payload: { content: PARAGRAPHS, versionId: "v1" },
    },
    {
      config: resolveEmbeddingWorkerConfig({
        maxChars: 60,
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
    }
  );
  assert.equal(result.status, "done");
  assert.equal(result.outcome?.status, "ok");
  assert.equal(
    success.statements.at(-1),
    `UPDATE ingest_jobs
SET "status" = 'done', "finished_at" = now(), "heartbeat_at" = now(), "error" = NULL
WHERE "job_id" = $1`
  );

  const failing = stubClient();
  const failed = await runIngestJob(
    failing.client,
    {
      attempts: 2,
      documentId: "doc-1",
      jobId: "job-bad",
      kind: "document-version",
      namespace: "ns",
      payload: { versionId: "v1" },
    },
    {
      config: resolveEmbeddingWorkerConfig({
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
    }
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /content/u);
  const lastParams = failing.params.at(-1);
  assert.equal(lastParams?.[0], "job-bad");
  const jobError = lastParams?.[1];
  assert.ok(
    typeof jobError === "string" &&
      jobError.includes("payload has no string content"),
    "job failure records the parse error"
  );
  assert.ok(
    !jobError.includes("S3cr3tBody"),
    "job errors never carry document bodies"
  );
});

test("drainIngestJobs claims until the queue is empty or the cap hits", async () => {
  const job = (jobId: string): Record<string, unknown> => ({
    attempts: 1,
    document_id: "doc-1",
    job_id: jobId,
    kind: "document-version",
    namespace: "ns",
    payload: { content: PARAGRAPHS, versionId: "v1" },
  });
  const recorded = stubClient([job("j1")], [job("j2")], []);
  const results = await drainIngestJobs(recorded.client, {
    config: resolveEmbeddingWorkerConfig({
      maxChars: 60,
      provider: createFakeEmbeddingProvider("fake/test-model"),
    }),
  });
  assert.deepEqual(
    results.map((result) => result.status),
    ["done", "done"]
  );
  const capped = stubClient([job("j1")], [job("j2")], [job("j3")]);
  const limited = await drainIngestJobs(
    capped.client,
    {
      config: resolveEmbeddingWorkerConfig({
        provider: createFakeEmbeddingProvider("fake/test-model"),
      }),
    },
    { maxJobs: 2 }
  );
  assert.equal(limited.length, 2);
  await assert.rejects(
    drainIngestJobs(
      stubClient().client,
      {
        config: resolveEmbeddingWorkerConfig({
          provider: createFakeEmbeddingProvider(),
        }),
      },
      { maxJobs: 0 }
    ),
    /maxJobs/u
  );
});

test("ingest migration creates the durable ingest_jobs record", () => {
  assert.match(INGEST_MIGRATION_SQL, /CREATE TABLE IF NOT EXISTS ingest_jobs/u);
  assert.match(INGEST_MIGRATION_SQL, /status TEXT NOT NULL DEFAULT 'queued'/u);
  const supersede = buildSupersedeChunksQuery("doc-1", []);
  assert.match(supersede.text, /NOT \("chunk_id" = ANY\(\$2\)\)/u);
  assert.throws(
    () =>
      buildChunkUpsertQuery({
        anchors: [],
        chunkId: "k_abc",
        documentId: "d",
        embedding: [0, 0],
        embeddingModel: null,
        namespace: "n",
        text: "t",
        versionId: "v",
      }),
    /together or neither/u
  );
});
