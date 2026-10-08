import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp } from "../../server/retrieval/app.ts";
import { baseConfig } from "../../server/retrieval/config.ts";
import { MemoryStore } from "../../server/retrieval/memory-store.ts";
import type {
  MemoryDocumentInput,
  MemoryVersionInput,
} from "../../server/retrieval/memory-store.ts";
import type { RetrievalStore } from "../../server/retrieval/store.ts";

const TOKEN = "retrieval-test-token-1234567890";

const version = (
  overrides: Partial<MemoryVersionInput> = {}
): MemoryVersionInput => ({
  chunks: [
    {
      anchors: [{ end: 40, start: 0, type: "offset" }],
      chunkId: "chunk-ops-1",
      tags: [],
      text: "Restart the postgres primary by deleting the pod and waiting for the operator.",
    },
    {
      anchors: [{ end: 90, start: 41, type: "offset" }],
      chunkId: "chunk-ops-2",
      tags: [],
      text: "Backups run nightly via the restic CronJob in the backup namespace.",
    },
  ],
  provenance: { ingestedAt: "2026-10-01T00:00:00Z", ingestionEventId: "evt-1" },
  version: {
    commit: "abc123",
    createdAt: "2026-10-01T00:00:00Z",
    status: "current",
    versionId: "v1",
  },
  ...overrides,
});

const documents = (): MemoryDocumentInput[] => [
  {
    documentId: "doc-ops",
    namespace: "default",
    source: {
      kind: "github",
      path: "docs/runbook.md",
      sourceId: "homelab-docs",
      url: "https://github.com/gwkline/homelab/blob/abc123/docs/runbook.md",
    },
    title: "Runbook",
    versions: [version()],
  },
];

interface Harness {
  app: ReturnType<typeof createApp>;
}

const noopLogger = {
  debug: (): void => {},
  error: (): void => {},
  info: (): void => {},
  warn: (): void => {},
};

const harness = (
  overrides: { ingestBaseUrl?: string | null } = {}
): Harness => {
  const store = new MemoryStore({ documents: documents() });
  const app = createApp({
    config: baseConfig(
      TOKEN,
      overrides.ingestBaseUrl === undefined
        ? {}
        : { ingestBaseUrl: overrides.ingestBaseUrl }
    ),
    logger: noopLogger,
    store,
  });
  return { app };
};

const bearerFor = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const bearer = (): Record<string, string> => ({
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
});

const search = async (
  h: Harness,
  body: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; status: number }> => {
  const res = await h.app.request("/v1/search", {
    body: JSON.stringify(body),
    headers: bearer(),
    method: "POST",
  });
  return {
    body: (await res.json()) as Record<string, unknown>,
    status: res.status,
  };
};

test("healthz answers without auth", async () => {
  const { app } = harness();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("v1 routes reject missing or invalid bearer tokens", async () => {
  const { app } = harness();
  const noAuth = await app.request("/v1/search", {
    body: JSON.stringify({ query: "restart postgres" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(noAuth.status, 401);
  const badAuth = await app.request("/v1/search", {
    body: JSON.stringify({ query: "restart postgres" }),
    headers: {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    },
    method: "POST",
  });
  assert.equal(badAuth.status, 401);
  const sources = await app.request("/v1/sources");
  assert.equal(sources.status, 401, "the passthrough routes are guarded too");
});

test("hybrid search returns cited, ranked results", async () => {
  const h = harness();
  const { status, body } = await search(h, {
    query: "restart postgres primary",
  });
  assert.equal(status, 200);
  assert.equal(body["mode"], "hybrid");
  assert.equal(body["namespace"], "default");
  const results = body["results"] as Record<string, unknown>[];
  assert.ok(results.length >= 1, "the matching chunk is found");
  const top = results[0] as Record<string, unknown>;
  assert.equal(top["chunkId"], "chunk-ops-1");
  assert.equal(top["title"], "Runbook");
  const source = top["source"] as Record<string, unknown>;
  assert.equal(source["sourceId"], "homelab-docs");
  const version_ = top["version"] as Record<string, unknown>;
  assert.equal(version_["versionId"], "v1");
  assert.equal(version_["status"], "current");
  const anchors = top["anchors"] as unknown[];
  assert.ok(anchors.length >= 1, "every result carries citation anchors");
  const provenance = top["provenance"] as Record<string, unknown>;
  assert.equal(provenance["ingestionEventId"], "evt-1");
});

test("bm25 mode ranks without embeddings and validates input", async () => {
  const h = harness();
  const ok = await search(h, {
    mode: "bm25",
    query: "restic backups",
    topK: 1,
  });
  assert.equal(ok.status, 200);
  const results = ok.body["results"] as Record<string, unknown>[];
  assert.equal(results.length, 1);
  assert.equal(results[0]?.["chunkId"], "chunk-ops-2");

  const blank = await search(h, { query: "   " });
  assert.equal(blank.status, 422);
  const oversized = await search(h, { query: "x".repeat(2001) });
  assert.equal(oversized.status, 422);
  const badTopK = await search(h, { query: "x", topK: 9999 });
  assert.equal(badTopK.status, 422);
  const badMode = await search(h, { mode: "graph", query: "x" });
  assert.equal(badMode.status, 422);
  const badNamespace = await search(h, { namespace: "Bad NS!", query: "x" });
  assert.equal(badNamespace.status, 422);
});

test("unanswerable queries return an empty result, never fabricated hits", async () => {
  const h = harness();
  const { status, body } = await search(h, { query: "quantum chromodynamics" });
  assert.equal(status, 200);
  assert.equal((body["results"] as unknown[]).length, 0);
});

test("sources passthrough answers 503 when the ingest API is unset", async () => {
  const h = harness();
  const sources = await h.app.request("/v1/sources", { headers: bearer() });
  assert.equal(sources.status, 503);
  const sync = await h.app.request("/v1/sources/homelab-docs/sync", {
    headers: bearer(),
    method: "POST",
  });
  assert.equal(sync.status, 503);
  const job = await h.app.request("/v1/sync-jobs/job_1", { headers: bearer() });
  assert.equal(job.status, 503);
});

test("sources and sync-jobs passthrough proxies the ingest API verbatim", async () => {
  const seen: { auth: string | undefined; path: string }[] = [];
  const stub = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, path: req.url ?? "" });
    if (req.url === "/v1/sources") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ sources: [{ sourceId: "homelab-docs" }] }));
      return;
    }
    if (req.url === "/v1/sources/homelab-docs/sync") {
      res
        .writeHead(202, { "content-type": "application/json" })
        .end(JSON.stringify({ jobId: "job_1", status: "pending" }));
      return;
    }
    if (req.url === "/v1/sync-jobs/job_1") {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jobId: "job_1", status: "succeeded" }));
      return;
    }
    res
      .writeHead(404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { code: "not_found" } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address() as AddressInfo;
  try {
    const h = harness({ ingestBaseUrl: `http://127.0.0.1:${port}` });
    const sources = await h.app.request("/v1/sources", { headers: bearer() });
    assert.equal(sources.status, 200);
    assert.deepEqual(await sources.json(), {
      sources: [{ sourceId: "homelab-docs" }],
    });

    const sync = await h.app.request("/v1/sources/homelab-docs/sync", {
      headers: bearer(),
      method: "POST",
    });
    assert.equal(sync.status, 202, "upstream status codes pass through");
    assert.deepEqual(await sync.json(), { jobId: "job_1", status: "pending" });

    const job = await h.app.request("/v1/sync-jobs/job_1", {
      headers: bearer(),
    });
    assert.equal(job.status, 200);

    const missing = await h.app.request("/v1/sync-jobs/job_missing", {
      headers: bearer(),
    });
    assert.equal(missing.status, 404);

    // The proxy authenticates with its own configured ingest token, never
    // the caller's retrieval token.
    assert.equal(seen[0]?.auth, `Bearer ${TOKEN}`);
    assert.ok(seen.every((entry) => entry.auth === `Bearer ${TOKEN}`));
  } finally {
    stub.close();
  }
});

test("passthrough ids are validated before proxying", async () => {
  const h = harness({ ingestBaseUrl: "http://127.0.0.1:1" });
  const badSync = await h.app.request("/v1/sources/..%2Fetc/sync", {
    headers: bearer(),
    method: "POST",
  });
  assert.equal(badSync.status, 422);
  const badJob = await h.app.request("/v1/sync-jobs/bad job id", {
    headers: bearer(),
  });
  assert.equal(badJob.status, 422);
});

test("without a real embedding model every search is BM25 and says so", async () => {
  const memory = new MemoryStore({ documents: documents() });
  let embedded = 0;
  const store: RetrievalStore = {
    embedQuery: (query) => {
      embedded += 1;
      return memory.embedQuery(query);
    },
    embeddingReport: () =>
      Promise.resolve({
        configuredModel: "fake/384",
        storedModels: [
          { chunks: 3, model: "BAAI/bge-small-en-v1.5" },
          { chunks: 2, model: "fake/384" },
        ],
      }),
    search: (options) => memory.search(options),
    vectorSearch: false,
  };
  const h: Harness = {
    app: createApp({ config: baseConfig(TOKEN), logger: noopLogger, store }),
  };
  for (const mode of [undefined, "hybrid", "vector"]) {
    const { status, body } = await search(h, {
      query: "restart postgres primary",
      ...(mode === undefined ? {} : { mode }),
    });
    assert.equal(status, 200);
    assert.equal(body["mode"], "bm25", `requested ${String(mode)}`);
    const results = body["results"] as { scores: { vector: unknown } }[];
    assert.ok(results.length >= 1);
    assert.ok(results.every((result) => result.scores.vector === null));
  }
  assert.equal(embedded, 0, "no query is embedded for a disabled channel");

  const metrics = await h.app.request("/metrics");
  assert.equal(metrics.status, 200);
  const text = await metrics.text();
  assert.match(text, /^knowledge_vector_search_enabled 0$/mu);
  assert.match(
    text,
    /^knowledge_embedding_model_mismatch_chunks\{configured_model="fake\/384"\} 3$/mu
  );
});

test("metrics report an enabled vector channel and answer 503 when the store fails", async () => {
  const { app } = harness();
  const enabled = await (await app.request("/metrics")).text();
  assert.match(enabled, /^knowledge_vector_search_enabled 1$/mu);
  assert.doesNotMatch(enabled, /mismatch/u, "the memory store has no report");

  const failing: RetrievalStore = {
    embeddingReport: () => Promise.reject(new Error("database down")),
    search: () => Promise.resolve({ bm25: [], vector: [] }),
  };
  const down = createApp({
    config: baseConfig(TOKEN),
    logger: noopLogger,
    store: failing,
  });
  assert.equal((await down.request("/metrics")).status, 503);
});

test("readyz follows the store's database check; healthz never does", async () => {
  let healthy = true;
  const store: RetrievalStore = {
    ping: () =>
      healthy
        ? Promise.resolve()
        : Promise.reject(new Error("connect ECONNREFUSED")),
    search: () => Promise.resolve({ bm25: [], vector: [] }),
  };
  const app = createApp({
    config: baseConfig(TOKEN),
    logger: noopLogger,
    store,
  });
  assert.equal((await app.request("/readyz")).status, 200);
  healthy = false;
  const down = await app.request("/readyz");
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { status: "unavailable" });
  assert.equal((await app.request("/healthz")).status, 200);
});

test("the search token searches, but every ingest route answers 403", async () => {
  const searchToken = "retrieval-search-token-0987654321";
  const app = createApp({
    config: baseConfig(TOKEN, { searchToken }),
    logger: noopLogger,
    store: new MemoryStore({ documents: documents() }),
  });
  const searched = await app.request("/v1/search", {
    body: JSON.stringify({ query: "restart postgres" }),
    headers: bearerFor(searchToken),
    method: "POST",
  });
  assert.equal(searched.status, 200);
  const ingestRoutes: [string, string][] = [
    ["GET", "/v1/sources"],
    ["POST", "/v1/sources/homelab-docs/sync"],
    ["GET", "/v1/sync-jobs/job-1"],
    ["GET", "/v1/anything-added-later"],
  ];
  for (const [method, path] of ingestRoutes) {
    const res = await app.request(path, {
      headers: bearerFor(searchToken),
      method,
    });
    assert.equal(res.status, 403, `${method} ${path}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "forbidden");
    // The admin token gets past auth (503: no ingest API in this test).
    const admin = await app.request(path, {
      headers: bearerFor(TOKEN),
      method,
    });
    assert.notEqual(admin.status, 401);
    assert.notEqual(admin.status, 403);
  }
  const stranger = await app.request("/v1/search", {
    body: JSON.stringify({ query: "restart postgres" }),
    headers: bearerFor("not-a-real-token-at-all"),
    method: "POST",
  });
  assert.equal(stranger.status, 401);
});
