import assert from "node:assert/strict";
import { test } from "node:test";

import { createFakeEmbeddingProvider } from "../../knowledge/src/embedder.ts";
import { PgRetrievalStore } from "../server/pg-store.ts";
import type { SearchOptions } from "../server/store.ts";

/**
 * Fake pg pool: records every query and answers canned rows per statement
 * shape (BM25 scan, vector scan, citation join). Keeps the pg store's SQL
 * construction and mapping under test without a database.
 */
const fakePool = (rows: {
  bm25?: Record<string, unknown>[];
  metadata?: Record<string, unknown>[];
  vector?: Record<string, unknown>[];
}) => {
  const queries: { params: unknown[]; text: string }[] = [];
  return {
    queries,
    query: (
      text: string,
      params: unknown[]
    ): Promise<{ rows: Record<string, unknown>[] }> => {
      queries.push({ params, text });
      if (text.includes("to_bm25query")) {
        return Promise.resolve({ rows: rows.bm25 ?? [] });
      }
      if (text.includes("<=>")) {
        return Promise.resolve({ rows: rows.vector ?? [] });
      }
      if (text.includes("JOIN document")) {
        return Promise.resolve({ rows: rows.metadata ?? [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
};

type PoolLike = ConstructorParameters<typeof PgRetrievalStore>[0];

/** Build the fake pool + a store over it + the recorded query log. */
const rig = (rows: Parameters<typeof fakePool>[0]) => {
  const fake = fakePool(rows);
  const pool = fake as unknown as PoolLike;
  return {
    queries: fake.queries,
    store: new PgRetrievalStore(pool, {
      provider: createFakeEmbeddingProvider("fake/deterministic-v1", 384),
    }),
  };
};

const metadataRow = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  anchors: JSON.stringify([{ end: 40, start: 0, type: "offset" }]),
  chunk_id: "chunk-1",
  created_at: new Date("2026-10-01T00:00:00Z"),
  document_id: "doc-1",
  external_id: "docs/runbook.md",
  namespace: "default",
  source: "git",
  text: "Restart the postgres primary.",
  title: "runbook.md",
  url: "https://github.com/gwkline/homelab/blob/abc/docs/runbook.md",
  valid_to: null,
  version_row_id: "ver-1",
  ...overrides,
});

const searchOptions = (
  overrides: Partial<SearchOptions> = {}
): SearchOptions => ({
  filters: { includeSuperseded: false, sourceIds: [], tags: [] },
  limitPerChannel: 10,
  namespace: "default",
  query: "restart postgres",
  queryEmbedding: null,
  ...overrides,
});

test("bm25-only search: channel query + citation join, mapped candidates", async () => {
  const pool = rig({
    bm25: [
      {
        anchors: [],
        chunk_id: "chunk-1",
        document_id: "doc-1",
        namespace: "default",
        score: -3.5,
        text: "Restart the postgres primary.",
        version_id: "ver-1",
      },
    ],
    metadata: [metadataRow()],
  });
  const result = await pool.store.search(searchOptions());
  assert.equal(result.bm25.length, 1);
  const candidate = result.bm25[0] as NonNullable<(typeof result.bm25)[0]>;
  assert.equal(candidate.chunk.chunkId, "chunk-1");
  assert.equal(candidate.bm25Score, 3.5, "negative BM25 inverted to positive");
  assert.equal(candidate.chunk.title, "runbook.md");
  assert.equal(candidate.chunk.source.kind, "git", "git label maps onto git");
  assert.equal(candidate.chunk.source.sourceId, "doc-1");
  assert.equal(candidate.chunk.source.path, "docs/runbook.md");
  assert.equal(candidate.chunk.version.versionId, "ver-1");
  assert.equal(candidate.chunk.version.status, "current");
  assert.equal(candidate.chunk.provenance.ingestionEventId, "ver-1");
  assert.equal(candidate.vectorScore, null);
  assert.equal(result.vector.length, 0, "no embedding → no vector channel");
  const bm25Text = pool.queries[0]?.text;
  assert.match(bm25Text ?? "", /to_bm25query/u);
  assert.match(bm25Text ?? "", /AND "valid_to" IS NULL/u);
});

test("vector search runs when a query embedding is present", async () => {
  const pool = rig({
    metadata: [metadataRow()],
    vector: [
      {
        anchors: "[]",
        chunk_id: "chunk-1",
        distance: 0.25,
        document_id: "doc-1",
        namespace: "default",
        text: "Restart the postgres primary.",
        version_id: "ver-1",
      },
    ],
  });
  const embedding = Array.from({ length: 384 }, (_, i) => (i % 7) / 10 + 0.01);
  const result = await pool.store.search(
    searchOptions({ queryEmbedding: embedding })
  );
  assert.equal(result.vector.length, 1);
  const candidate = result.vector[0] as NonNullable<(typeof result.vector)[0]>;
  assert.ok(candidate.vectorScore !== null);
  assert.ok(
    Math.abs((candidate.vectorScore ?? 0) - 0.75) < 1e-9,
    "1 - distance"
  );

  const vectorQuery = pool.queries.find((q) => q.text.includes("<=>"));
  assert.ok(vectorQuery, "the pgvector query ran");
  assert.match(vectorQuery?.text ?? "", /"embedding_model" = \$3/u);
});

test("tombstoned documents drop out of both channels' candidates", async () => {
  const pool = rig({
    bm25: [
      {
        anchors: [],
        chunk_id: "chunk-1",
        document_id: "doc-1",
        namespace: "default",
        score: -3.5,
        text: "text",
        version_id: "ver-1",
      },
    ],
    metadata: [],
  });
  const result = await pool.store.search(searchOptions());
  assert.equal(
    result.bm25.length,
    0,
    "the citation join returned no live document row"
  );
  const join = pool.queries.find((q) => q.text.includes("deleted_at IS NULL"));
  assert.ok(join, "the D8 live-join predicate is in the SQL");
});

test("sourceId filters and superseded status map through the join", async () => {
  const pool = rig({
    bm25: [
      {
        anchors: [],
        chunk_id: "chunk-2",
        document_id: "doc-1",
        namespace: "default",
        score: -2,
        text: "text",
        version_id: "ver-1",
      },
    ],
    metadata: [
      metadataRow({ chunk_id: "chunk-2", valid_to: "2026-10-02T00:00:00Z" }),
    ],
  });
  const result = await pool.store.search(
    searchOptions({
      filters: { includeSuperseded: true, sourceIds: ["doc-1"], tags: [] },
    })
  );
  assert.equal(result.bm25.length, 1);
  const candidate = result.bm25[0] as NonNullable<(typeof result.bm25)[0]>;
  assert.equal(candidate.chunk.version.status, "superseded");
  const bm25Text = pool.queries[0]?.text;
  assert.doesNotMatch(
    bm25Text ?? "",
    /valid_to/u,
    "includeSuperseded drops the active-only predicate"
  );
  const join = pool.queries.find((q) => q.text.includes("JOIN document"));
  assert.deepEqual(join?.params?.[1], ["doc-1"], "sourceIds reach the join");
});

test("tag filters return an honest empty (no tag column in #56)", async () => {
  const pool = rig({});
  const result = await pool.store.search(
    searchOptions({
      filters: { includeSuperseded: false, sourceIds: [], tags: ["ops"] },
    })
  );
  assert.deepEqual(result, { bm25: [], vector: [] });
  assert.equal(pool.queries.length, 0, "no SQL ran at all");
});

test("title falls back to the external id when the document has none", async () => {
  const pool = rig({
    bm25: [
      {
        anchors: [],
        chunk_id: "chunk-1",
        document_id: "doc-1",
        namespace: "default",
        score: -1,
        text: "text",
        version_id: "ver-1",
      },
    ],
    metadata: [metadataRow({ title: null })],
  });
  const result = await pool.store.search(searchOptions());
  const candidate = result.bm25[0] as NonNullable<(typeof result.bm25)[0]>;
  assert.equal(candidate.chunk.title, "docs/runbook.md");
});

test("database failures surface as StoreUnavailableError", async () => {
  const pool = {
    query: (): Promise<{ rows: Record<string, unknown>[] }> =>
      Promise.reject(new Error("connection refused")),
  } as unknown as ConstructorParameters<typeof PgRetrievalStore>[0];
  await assert.rejects(
    new PgRetrievalStore(pool, {
      provider: createFakeEmbeddingProvider("fake/deterministic-v1", 384),
    }).search(searchOptions()),
    /retrieval store unavailable/u
  );
});

test("embedQuery returns a validated vector or null on failure", async () => {
  const { store: s } = rig({});
  const vector = await s.embedQuery("restart the primary");
  assert.ok(Array.isArray(vector));
  assert.equal(vector?.length, 384);
  const broken = new PgRetrievalStore({} as never, {
    provider: {
      dimensions: 384,
      embed: () => {
        throw new Error("provider down");
      },
      model: "broken",
      name: "broken",
    },
  });
  assert.equal(await broken.embedQuery("restart"), null);
});
