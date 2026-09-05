import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBackfillCountQuery,
  buildEfSearchStatement,
  buildPgvectorSearchQuery,
  countChunksNeedingBackfill,
  DEFAULT_EF_SEARCH,
  DEFAULT_VECTOR_LIMIT,
  DISTANCE_OPERATOR,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  ensurePgvectorSchema,
  hnswRecall,
  parseAnchors,
  parseBackfillCounts,
  parsePgvectorRows,
  PGVECTOR_EXACT_SCAN_GUARD,
  PGVECTOR_MIGRATION_SQL,
  searchPgvector,
  searchPgvectorExact,
  toPgvectorLiteral,
  validateQueryEmbedding,
  withPgvectorClientFromEnv,
} from "../src/pgvector.ts";
import type { PgvectorDbClient } from "../src/pgvector.ts";

interface RecordedClient {
  client: PgvectorDbClient;
  params: unknown[][];
  statements: string[];
}

/** Scripted client recording every statement in order. */
const stubClient = (responses: Record<string, unknown>[][]): RecordedClient => {
  const params: unknown[][] = [];
  const statements: string[] = [];
  let call = 0;
  const client: PgvectorDbClient = {
    query: (text: string, query: unknown[]) => {
      params.push(query);
      statements.push(text);
      const rows = responses[Math.min(call, responses.length - 1)] ?? [];
      call += 1;
      return Promise.resolve({ rows });
    },
  };
  return { client, params, statements };
};

const vectorAt = (index: number): number[] => {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[index] = 1;
  return vector;
};

test("builder binds embedding/namespace/model/limit, ranks with cosine distance", () => {
  const embedding = vectorAt(0);
  const built = buildPgvectorSearchQuery(embedding, {
    limit: 5,
    namespace: "homelab-docs",
  });

  assert.deepEqual(built.params, [
    toPgvectorLiteral(embedding),
    "homelab-docs",
    EMBEDDING_MODEL,
    5,
  ]);
  assert.ok(
    built.text.includes(
      `("embedding" ${DISTANCE_OPERATOR} $1::vector) AS distance`
    ),
    `must rank with cosine distance: ${built.text}`
  );
  assert.ok(
    built.text.includes(
      `ORDER BY "embedding" ${DISTANCE_OPERATOR} $1::vector ASC`
    ),
    "cosine distance sorts ascending (lower = better)"
  );
  assert.ok(built.text.includes("LIMIT $4"), "candidate count must bind");
  // Namespace + active-version predicates are bound/parameterized, and the
  // model generation filter keeps other models' chunks out of the results.
  assert.ok(built.text.includes('"namespace" = $2'));
  assert.ok(built.text.includes('"embedding_model" = $3'));
  assert.ok(built.text.includes('"embedding" IS NOT NULL'));
  assert.ok(built.text.includes('"valid_to" IS NULL'));
});

test("builder defaults: namespace default, live chunks only, limit 10", () => {
  const built = buildPgvectorSearchQuery(vectorAt(1));
  assert.deepEqual(built.params, [
    toPgvectorLiteral(vectorAt(1)),
    "default",
    EMBEDDING_MODEL,
    DEFAULT_VECTOR_LIMIT,
  ]);
  assert.ok(built.text.includes('"valid_to" IS NULL'));
});

test("builder includeSuperseded drops the active-version predicate", () => {
  const built = buildPgvectorSearchQuery(vectorAt(1), {
    includeSuperseded: true,
  });
  assert.ok(!built.text.includes('"valid_to" IS NULL'));
});

test("builder rejects bad embeddings, namespaces, models, limits before any SQL", () => {
  assert.throws(() => buildPgvectorSearchQuery([]), /required/u);
  assert.throws(
    () => buildPgvectorSearchQuery([1, 2, 3]),
    /3 dimensions, expected 384/u
  );
  assert.throws(
    () => buildPgvectorSearchQuery(Array.from({ length: 384 }, () => 0)),
    /zero vector/u
  );
  assert.throws(
    () =>
      buildPgvectorSearchQuery(
        vectorAt(0).map((v, i) => (i === 7 ? Number.NaN : v))
      ),
    /not a finite number/u
  );
  assert.throws(
    () =>
      buildPgvectorSearchQuery(vectorAt(0), { namespace: "bad namespace!" }),
    /invalid namespace/u
  );
  assert.throws(
    () => buildPgvectorSearchQuery(vectorAt(0), { embeddingModel: "a b" }),
    /invalid embedding model/u
  );
  for (const bad of [0, -3, 2.5, Number.NaN]) {
    assert.throws(
      () => buildPgvectorSearchQuery(vectorAt(0), { limit: bad }),
      /limit must be an integer >= 1/u
    );
  }
});

test("validateQueryEmbedding names model and dimension on mismatch", () => {
  assert.throws(
    () => validateQueryEmbedding(Array.from({ length: 768 }, () => 0.1)),
    /768 dimensions, expected 384 \(BAAI\/bge-small-en-v1\.5\); re-embed/u
  );
  assert.throws(() => validateQueryEmbedding(null), /required/u);
  assert.throws(() => validateQueryEmbedding([]), /required/u);
  assert.throws(
    () =>
      validateQueryEmbedding(vectorAt(0).map((v, i) => (i === 1 ? "x" : v))),
    /entry 1 is not a finite number/u
  );
  assert.throws(
    () =>
      validateQueryEmbedding(
        vectorAt(0).map((v, i) => (i === 1 ? Infinity : v))
      ),
    /entry 1 is not a finite number/u
  );
  assert.throws(
    () => validateQueryEmbedding(Array.from({ length: 384 }, () => 0)),
    /zero vector/u
  );
});

test("toPgvectorLiteral serializes pgvector text format", () => {
  assert.equal(toPgvectorLiteral([1, 0.5, -0.25]), "[1,0.5,-0.25]");
});

test("ef_search statement is validated and inlined (SET cannot bind)", () => {
  assert.equal(buildEfSearchStatement(80), "SET LOCAL hnsw.ef_search = 80");
  assert.equal(
    buildEfSearchStatement(DEFAULT_EF_SEARCH),
    "SET LOCAL hnsw.ef_search = 40"
  );
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => buildEfSearchStatement(bad),
      /efSearch must be an integer >= 1/u
    );
  }
});

test("searchPgvector runs ef_search + SELECT in one transaction, maps hits", async () => {
  const embedding = vectorAt(0);
  const recorded = stubClient([
    [],
    [],
    [
      {
        anchors: [
          { end: 9, start: 0, type: "offset" },
          { type: "heading", value: "Setup" },
        ],
        chunk_id: "chunk-1",
        distance: 0.1,
        document_id: "doc-1",
        namespace: "default",
        text: "first",
        version_id: "v1",
      },
      {
        anchors: [],
        chunk_id: "chunk-2",
        distance: 0.4,
        document_id: "doc-1",
        namespace: "default",
        text: "second",
        version_id: "v1",
      },
    ],
    [],
  ]);

  const hits = await searchPgvector(recorded.client, embedding, {
    efSearch: 80,
    limit: 2,
    namespace: "default",
  });

  assert.deepEqual(recorded.statements, [
    "BEGIN",
    "SET LOCAL hnsw.ef_search = 80",
    buildPgvectorSearchQuery(embedding, { efSearch: 80, limit: 2 }).text,
    "COMMIT",
  ]);
  assert.deepEqual(recorded.params[2], [
    toPgvectorLiteral(embedding),
    "default",
    EMBEDDING_MODEL,
    2,
  ]);
  assert.deepEqual(hits, [
    {
      anchors: [
        { end: 9, start: 0, type: "offset" },
        { type: "heading", value: "Setup" },
      ],
      chunkId: "chunk-1",
      distance: 0.1,
      documentId: "doc-1",
      namespace: "default",
      rank: 1,
      text: "first",
      versionId: "v1",
    },
    {
      anchors: [],
      chunkId: "chunk-2",
      distance: 0.4,
      documentId: "doc-1",
      namespace: "default",
      rank: 2,
      text: "second",
      versionId: "v1",
    },
  ]);
});

test("searchPgvectorExact forces a sequential scan and never sets ef_search", async () => {
  const embedding = vectorAt(2);
  const recorded = stubClient([[], [], [], []]);

  const hits = await searchPgvectorExact(recorded.client, embedding, {
    efSearch: 5,
    limit: 3,
  });

  assert.deepEqual(recorded.statements, [
    "BEGIN",
    PGVECTOR_EXACT_SCAN_GUARD,
    buildPgvectorSearchQuery(embedding, { limit: 3 }).text,
    "COMMIT",
  ]);
  assert.ok(
    !recorded.statements.some((statement) => statement.includes("ef_search")),
    "exact path must not touch ef_search"
  );
  assert.deepEqual(hits, []);
});

test("searchPgvectorExact rolls back and rethrows on failure", async () => {
  const client: PgvectorDbClient = {
    query: (text: string) => {
      if (text.startsWith("SELECT")) {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.rejects(() => searchPgvectorExact(client, vectorAt(0)), /boom/u);
});

test("searchPgvector validates before opening a transaction", async () => {
  let calls = 0;
  const client: PgvectorDbClient = {
    query: () => {
      calls += 1;
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.rejects(() => searchPgvector(client, [1, 2]), /dimensions/u);
  await assert.rejects(
    () => searchPgvector(client, vectorAt(0), { efSearch: 0 }),
    /efSearch/u
  );
  await assert.rejects(
    () => searchPgvector(client, vectorAt(0), { limit: 0 }),
    /limit/u
  );
  assert.equal(calls, 0);
});

const validRow = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  anchors: [],
  chunk_id: "a",
  distance: 0.2,
  document_id: "d",
  namespace: "n",
  text: "t",
  version_id: "v",
  ...overrides,
});

test("parsePgvectorRows rejects malformed rows and broken anchors", () => {
  assert.throws(
    () => parsePgvectorRows([validRow({ chunk_id: undefined })]),
    /no string chunk_id/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ document_id: null })]),
    /no string document_id/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ version_id: 9 })]),
    /no string version_id/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ namespace: "" })]),
    /no string namespace/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ distance: "far" })]),
    /no numeric distance/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ anchors: undefined })]),
    /anchors must be a JSON array/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ anchors: [{ type: "banana" }] })]),
    /anchor type must be/u
  );
  assert.throws(
    () =>
      parsePgvectorRows([
        validRow({ anchors: [{ start: -1, type: "offset" }] }),
      ]),
    /anchor start must be/u
  );
  assert.throws(
    () => parsePgvectorRows([validRow({ anchors: "not json{{{" })]),
    /not valid JSON/u
  );
  assert.throws(() => parseAnchors("not json{{{", "ctx"), /not valid JSON/u);
});

test("parsePgvectorRows coerces missing text, parses JSON-string anchors", () => {
  const hits = parsePgvectorRows([
    {
      anchors: '[{"type":"heading","value":"Intro"}]',
      chunk_id: "a",
      distance: 0.5,
      document_id: "d",
      namespace: "n",
      version_id: "v",
    },
  ]);
  assert.deepEqual(hits[0], {
    anchors: [{ type: "heading", value: "Intro" }],
    chunkId: "a",
    distance: 0.5,
    documentId: "d",
    namespace: "n",
    rank: 1,
    text: "",
    versionId: "v",
  });
});

test("ensurePgvectorSchema runs the migration: extension, table, hnsw index", async () => {
  const recorded = stubClient([[]]);
  await ensurePgvectorSchema(recorded.client);
  assert.equal(
    recorded.statements[0],
    PGVECTOR_MIGRATION_SQL,
    "migration runs as one idempotent script"
  );
  assert.ok(
    PGVECTOR_MIGRATION_SQL.includes("CREATE EXTENSION IF NOT EXISTS vector"),
    "migration must enable pgvector"
  );
  assert.ok(
    PGVECTOR_MIGRATION_SQL.includes("embedding vector(384)"),
    "migration must pin the model dimension"
  );
  assert.ok(
    PGVECTOR_MIGRATION_SQL.includes("USING hnsw (embedding vector_cosine_ops)"),
    "index operator class must match the cosine metric"
  );
  assert.ok(
    PGVECTOR_MIGRATION_SQL.includes(
      "WHERE valid_to IS NULL AND embedding IS NOT NULL"
    ),
    "hnsw index must be partial over live, embedded chunks"
  );
});

test("backfill counts expose missing embeddings and model migrations", async () => {
  const built = buildBackfillCountQuery("default");
  assert.deepEqual(built.params, ["default", EMBEDDING_MODEL]);
  assert.ok(built.text.includes('FILTER (WHERE "embedding" IS NULL)'));
  assert.ok(built.text.includes('"embedding_model" <> $2'));

  const counts = parseBackfillCounts("default", EMBEDDING_MODEL, {
    missing_embedding: 2,
    model_mismatch: "1",
    ready: 3,
    total: 6,
  });
  assert.deepEqual(counts, {
    embeddingModel: EMBEDDING_MODEL,
    missingEmbedding: 2,
    modelMismatch: 1,
    namespace: "default",
    ready: 3,
    total: 6,
  });

  const recorded = stubClient([
    [{ missing_embedding: 0, model_mismatch: 4, ready: 0, total: 4 }],
  ]);
  const live = await countChunksNeedingBackfill(
    recorded.client,
    "default",
    "other-model"
  );
  assert.equal(live.modelMismatch, 4);
  assert.equal(live.ready, 0);
});

test("backfill counts reject malformed rows", () => {
  assert.throws(
    () => parseBackfillCounts("default", EMBEDDING_MODEL, {}),
    /not a non-negative integer count/u
  );
});

// Deterministic fixture: six unit-sphere-ish chunks, query e1. Exact top-3 by
// cosine: fix-1 (1.0), fix-2 (0.9/sqrt(0.82) ~ 0.994), fix-5 (0.7/sqrt(0.98)
// ~ 0.707). The test recomputes it brute-force (independent implementation)
// and uses it as ground truth for the HNSW comparison.
const FIXTURE: { embedding: number[]; id: string }[] = [
  { embedding: [1, 0, 0, 0], id: "fix-1" },
  { embedding: [0.9, 0.1, 0, 0], id: "fix-2" },
  { embedding: [0, 1, 0, 0], id: "fix-3" },
  { embedding: [0, 0, 1, 0], id: "fix-4" },
  { embedding: [0.7, 0.7, 0, 0], id: "fix-5" },
  { embedding: [0, 0, 0, 1], id: "fix-6" },
];
const FIXTURE_QUERY = [1, 0, 0, 0];

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  return dot / Math.sqrt(normA * normB);
};

const byCosineThenId = (
  a: { cosine: number; id: string },
  b: { cosine: number; id: string }
): number => {
  if (a.cosine !== b.cosine) {
    return b.cosine - a.cosine;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
};

/** Test-local brute-force exact top-k (pgvector's exact-scan semantics). */
const exactTopK = (query: number[], k: number): string[] =>
  FIXTURE.map(({ embedding, id }) => ({ cosine: cosine(query, embedding), id }))
    .toSorted(byCosineThenId)
    .slice(0, k)
    .map((entry) => entry.id);

const EXACT_TOP_3 = ["fix-1", "fix-2", "fix-5"];

test("exact top-k over the deterministic fixture matches brute-force cosine", () => {
  assert.deepEqual(exactTopK(FIXTURE_QUERY, 3), EXACT_TOP_3);
  assert.deepEqual(exactTopK(FIXTURE_QUERY, 6), [
    "fix-1",
    "fix-2",
    "fix-5",
    "fix-3",
    "fix-4",
    "fix-6",
  ]);
});

test("hnswRecall compares approximate top-k against exact ground truth", () => {
  assert.equal(hnswRecall(EXACT_TOP_3, EXACT_TOP_3), 1);
  // A small ef that explores the wrong branch misses 2 of 3.
  assert.equal(hnswRecall(["fix-1", "fix-3", "fix-6"], EXACT_TOP_3), 1 / 3);
  assert.equal(hnswRecall(["fix-2", "fix-1"], EXACT_TOP_3), 2 / 3);
  assert.equal(hnswRecall([], EXACT_TOP_3), 0);
  assert.equal(hnswRecall([], []), 1);
  // Duplicates never inflate recall.
  assert.equal(hnswRecall(["fix-1", "fix-1", "fix-2"], EXACT_TOP_3), 2 / 3);
});

const padToDimensions = (vector: number[], dimensions: number): number[] => [
  ...vector,
  ...Array.from({ length: dimensions - vector.length }, () => 0),
];

const fixtureRow = (id: string, distance: number): Record<string, unknown> => ({
  anchors: [{ end: 4, start: 0, type: "offset" }],
  chunk_id: id,
  distance,
  document_id: `doc-${id}`,
  namespace: "default",
  text: `${id} text`,
  version_id: "v1",
});

const fixtureDistances: Record<string, number> = {
  "fix-1": 0,
  "fix-2": 1 - 0.9 / Math.sqrt(0.82),
  "fix-3": 1,
  "fix-4": 1,
  "fix-5": 1 - 0.7 / Math.sqrt(0.98),
  "fix-6": 1,
};

test("HNSW vs exact on the deterministic fixture through the full search path", async () => {
  // Simulated HNSW output (small ef, two misses) and exact output, both in
  // row shape, exercising SQL construction, mapping, and recall end to end.
  const exactRows = EXACT_TOP_3.map((id) =>
    fixtureRow(id, fixtureDistances[id] ?? 1)
  );
  const hnswRows = ["fix-1", "fix-3", "fix-6"].map((id) =>
    fixtureRow(id, fixtureDistances[id] ?? 1)
  );

  // 384-d stand-in for the real bge embedding: the builder requires the
  // indexed dimension, and the fixture math above is dimension-independent.
  const paddedQuery = padToDimensions(FIXTURE_QUERY, EMBEDDING_DIMENSIONS);
  const exactHits = await searchPgvectorExact(
    stubClient([[], [], exactRows, []]).client,
    paddedQuery,
    { limit: 3 }
  );
  const hnswHits = await searchPgvector(
    stubClient([[], [], hnswRows, []]).client,
    paddedQuery,
    { efSearch: 2, limit: 3 }
  );

  assert.deepEqual(
    exactHits.map((hit) => hit.chunkId),
    EXACT_TOP_3
  );
  const recall = hnswRecall(
    hnswHits.map((hit) => hit.chunkId),
    exactHits.map((hit) => hit.chunkId)
  );
  assert.equal(recall, 1 / 3);
});

// Live-DB integration: runs only when DATABASE_URL points at a Postgres with
// pgvector. Otherwise skipped in CI/offline, like the BM25 integration test.
const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

test(
  "integration: migration + HNSW recall vs exact top-k on the fixture",
  { skip: !hasLiveDb },
  async () => {
    await withPgvectorClientFromEnv(async (client) => {
      await ensurePgvectorSchema(client);
      const namespace = "pgvector-test";
      await client.query("DELETE FROM chunks WHERE namespace = $1", [
        namespace,
      ]);

      const insert = `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text, anchors, embedding, embedding_model)
VALUES ($1, $2, 'v1', $3, $4, $5::jsonb, $6::vector, $7)`;
      const fixtureValues = FIXTURE.map(({ embedding, id }) => [
        id,
        `doc-${id}`,
        namespace,
        `${id} text`,
        JSON.stringify([{ end: 4, start: 0, type: "offset" }]),
        toPgvectorLiteral(padToDimensions(embedding, EMBEDDING_DIMENSIONS)),
        EMBEDDING_MODEL,
      ]);
      // A chunk from another model generation and an un-embedded chunk must
      // never surface in results (model migration / missing embedding).
      fixtureValues.push([
        "fix-other-model",
        "doc-other",
        namespace,
        "other model text",
        JSON.stringify([{ end: 4, start: 0, type: "offset" }]),
        toPgvectorLiteral(padToDimensions(FIXTURE_QUERY, EMBEDDING_DIMENSIONS)),
        "other-model-v0",
      ]);
      await Promise.all(
        fixtureValues.map((values) => client.query(insert, values))
      );
      await client.query(
        `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text, anchors, embedding, embedding_model)
VALUES ('fix-null', 'doc-null', 'v1', $1, 'null text', '[]'::jsonb, NULL, $2)`,
        [namespace, EMBEDDING_MODEL]
      );

      const paddedQuery = padToDimensions(FIXTURE_QUERY, EMBEDDING_DIMENSIONS);
      const exact = await searchPgvectorExact(client, paddedQuery, {
        limit: 3,
        namespace,
      });
      // >= fixture size: HNSW must be exhaustive here.
      const hnsw = await searchPgvector(client, paddedQuery, {
        efSearch: 40,
        limit: 3,
        namespace,
      });

      assert.deepEqual(
        exact.map((hit) => hit.chunkId),
        EXACT_TOP_3,
        "exact sequential scan must reproduce brute-force ground truth"
      );
      const recall = hnswRecall(
        hnsw.map((hit) => hit.chunkId),
        exact.map((hit) => hit.chunkId)
      );
      assert.equal(
        recall,
        1,
        `HNSW recall vs exact top-3 on the fixture was ${recall}`
      );
      const counts = await countChunksNeedingBackfill(
        client,
        namespace,
        EMBEDDING_MODEL
      );
      assert.deepEqual(
        [
          counts.total,
          counts.ready,
          counts.modelMismatch,
          counts.missingEmbedding,
        ],
        [8, 6, 1, 1]
      );

      await client.query("DELETE FROM chunks WHERE namespace = $1", [
        namespace,
      ]);
    });
  }
);

test("integration path requires DATABASE_URL when env is empty", async () => {
  const saved = process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL"];
  try {
    await assert.rejects(
      () => withPgvectorClientFromEnv(() => Promise.resolve(0)),
      /DATABASE_URL is not set/u
    );
  } finally {
    if (saved !== undefined) {
      process.env["DATABASE_URL"] = saved;
    }
  }
});
