import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BM25_INDEX_NAME,
  buildBm25SearchQuery,
  parseBm25Rows,
  searchBm25,
  withBm25ClientFromEnv,
} from "../src/bm25.ts";
import type { Bm25SearchQuery } from "../src/bm25.ts";
import type { PgClient } from "../src/pg-client.ts";
import { migrateKnowledgeSchema } from "../src/schema.ts";
import { fixtureVersionId, insertChunkFixtures } from "./live-fixtures.ts";
import type { ChunkFixture } from "./live-fixtures.ts";

const stubClient = (
  rows: Record<string, unknown>[],
  seen: { text?: string; params?: unknown[] } = {}
): PgClient => ({
  query: (text: string, params: unknown[]) => {
    seen.text = text;
    seen.params = params;
    return Promise.resolve({ rows });
  },
});

test("builder binds query/namespace/limit and ranks the final index shape", () => {
  const built = buildBm25SearchQuery("wireless headphones", {
    limit: 5,
    namespace: "homelab-docs",
  });

  assert.deepEqual(built.params, ["wireless headphones", "homelab-docs", 5]);
  assert.ok(
    built.text.includes(`"text" <@> to_bm25query($1, '${BM25_INDEX_NAME}')`),
    `missing <@> ranking against ${BM25_INDEX_NAME}: ${built.text}`
  );
  assert.ok(
    built.text.includes('FROM "chunks"'),
    "keyword channel must search the shared chunks table"
  );
  assert.ok(
    built.text.includes('WHERE "namespace" = $2'),
    "namespace filter must be a bind parameter"
  );
  assert.ok(
    built.text.includes('AND "valid_to" IS NULL'),
    "default query must target the partial index's live-chunk predicate"
  );
  assert.ok(
    built.text.includes(
      `ORDER BY ("text" <@> to_bm25query($1, '${BM25_INDEX_NAME}')) ASC`
    ),
    "top-k must order by the indexed score expression ascending"
  );
  assert.ok(built.text.includes("LIMIT $3"), "limit must bind");
  // Query text is a bind param, never interpolated into the SQL.
  assert.ok(!built.text.includes("wireless headphones"));
});

test("builder defaults: namespace default, live chunks only, limit 10", () => {
  const built = buildBm25SearchQuery("retirement savings");
  assert.deepEqual(built.params, ["retirement savings", "default", 10]);
  assert.ok(built.text.includes(`'${BM25_INDEX_NAME}'`));
  assert.ok(built.text.includes('AND "valid_to" IS NULL'));
});

test("builder always searches live chunks, the only ones the index can rank", () => {
  const built = buildBm25SearchQuery("q");
  assert.ok(built.text.includes('AND "valid_to" IS NULL'));
});

test("builder accepts a custom index name, rejects injection", () => {
  const ok = buildBm25SearchQuery("q", { indexName: "chunks_alt_bm25" });
  assert.ok(ok.text.includes("to_bm25query($1, 'chunks_alt_bm25')"));

  assert.throws(
    () =>
      buildBm25SearchQuery("q", { indexName: "chunks; DROP TABLE chunks;--" }),
    /invalid index name/u
  );
  assert.throws(
    () => buildBm25SearchQuery("q", { indexName: "" }),
    /invalid index name/u
  );
});

test("builder rejects empty queries, bad namespaces, and bad limits", () => {
  for (const bad of ["", "   "]) {
    assert.throws(() => buildBm25SearchQuery(bad), /non-empty string/u);
  }
  assert.throws(
    () => buildBm25SearchQuery("q", { namespace: "bad namespace!" }),
    /invalid namespace/u
  );
  for (const bad of [0, -3, 2.5, Number.NaN]) {
    assert.throws(
      () => buildBm25SearchQuery("q", { limit: bad }),
      /limit must be an integer >= 1/u
    );
  }
});

test("query classes pass through verbatim as bind params", () => {
  // The database tokenizes and stems; any application-side mangling would
  // break provenance. Rare-term and no-result cases need live IDF, below.
  const classes = [
    "KWREF-6087",
    "zzqqxw qwertyuiopvbx",
    "restart, failed; (check the logs)!",
    "running",
  ];
  for (const query of classes) {
    const built = buildBm25SearchQuery(query);
    assert.equal(built.params[0], query);
    assert.ok(!built.text.includes(query), `interpolated: ${query}`);
  }
});

const validRow = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  anchors: [{ end: 9, start: 0, type: "offset" }],
  chunk_id: "chunk-1",
  document_id: "doc-1",
  namespace: "default",
  score: -3.2,
  text: "alpha text",
  version_id: "v1",
  ...overrides,
});

test("parseBm25Rows maps rows to the citation contract with 1-based ranks", () => {
  const hits = parseBm25Rows([
    validRow(),
    validRow({
      anchors: '[{"type":"heading","value":"Setup"}]',
      chunk_id: "chunk-2",
      score: -1.1,
      text: undefined,
    }),
  ]);
  assert.deepEqual(hits, [
    {
      anchors: [{ end: 9, start: 0, type: "offset" }],
      chunkId: "chunk-1",
      documentId: "doc-1",
      namespace: "default",
      rank: 1,
      score: -3.2,
      text: "alpha text",
      versionId: "v1",
    },
    {
      anchors: [{ type: "heading", value: "Setup" }],
      chunkId: "chunk-2",
      documentId: "doc-1",
      namespace: "default",
      rank: 2,
      score: -1.1,
      text: "",
      versionId: "v1",
    },
  ]);
});

test("parseBm25Rows rejects malformed rows and broken anchors", () => {
  assert.throws(
    () => parseBm25Rows([validRow({ chunk_id: undefined })]),
    /no string chunk_id/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ document_id: null })]),
    /no string document_id/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ version_id: 9 })]),
    /no string version_id/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ namespace: "" })]),
    /no string namespace/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ score: "high" })]),
    /no numeric score/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ score: Number.NaN })]),
    /no numeric score/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ anchors: [{ type: "banana" }] })]),
    /anchor type must be/u
  );
  assert.throws(
    () => parseBm25Rows([validRow({ anchors: "not json{{{" })]),
    /not valid JSON/u
  );
});

test("searchBm25 returns hits best-first and sends the built query", async () => {
  const seen: { text?: string; params?: unknown[] } = {};
  const client = stubClient(
    [
      validRow({ chunk_id: "chunk-1", score: -4 }),
      validRow({ chunk_id: "chunk-2", score: -0.5 }),
    ],
    seen
  );

  const hits = await searchBm25(client, "network error", { limit: 2 });

  assert.deepEqual(
    hits.map((hit) => hit.chunkId),
    ["chunk-1", "chunk-2"]
  );
  assert.deepEqual(
    hits.map((hit) => hit.rank),
    [1, 2]
  );
  // Negative BM25: best (most negative) match sorts first.
  assert.ok(
    hits[0] !== undefined &&
      hits[1] !== undefined &&
      hits[0].score < hits[1].score
  );
  assert.deepEqual(seen.params, ["network error", "default", 2]);
  assert.ok(seen.text?.includes("<@> to_bm25query("));
  assert.ok(seen.text?.includes("ORDER BY"));
  assert.ok(seen.text?.includes("LIMIT $3"));
});

test("searchBm25 validates before issuing any query", async () => {
  let calls = 0;
  const client: PgClient = {
    query: () => {
      calls += 1;
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.rejects(() => searchBm25(client, "   "), /non-empty string/u);
  await assert.rejects(
    () => searchBm25(client, "q", { namespace: "nope nope" }),
    /invalid namespace/u
  );
  await assert.rejects(() => searchBm25(client, "q", { limit: 0 }), /limit/u);
  assert.equal(calls, 0);
});

test("integration path requires DATABASE_URL when env is empty", async () => {
  const saved = process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL"];
  try {
    await assert.rejects(
      () => withBm25ClientFromEnv(() => Promise.resolve(0)),
      /DATABASE_URL is not set/u
    );
  } finally {
    if (saved !== undefined) {
      process.env["DATABASE_URL"] = saved;
    }
  }
});

// Live-DB integration: needs DATABASE_URL with both pg_textsearch and pgvector
// (the shared chunks schema uses the vector type).
const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

const WIDE_NAMESPACE = "bm25-wide";
const SPARSE_NAMESPACE = "bm25-sparse";
const OTHER_NAMESPACE = "bm25-other";
const TEST_NAMESPACES = [WIDE_NAMESPACE, SPARSE_NAMESPACE, OTHER_NAMESPACE];

/**
 * 10_000 filler rows (70 distinct texts, no probe terms): big enough that the
 * planner prefers the indexes over a sequential scan in the EXPLAIN checks.
 */
const FILLER_ROWS = 10_000;

const FILLER_NOUNS = [
  "database",
  "network",
  "storage",
  "backup",
  "cluster",
  "router",
  "volume",
  "policy",
  "image",
  "gateway",
];

const seedFixture = async (client: PgClient): Promise<void> => {
  await client.query("DELETE FROM chunks WHERE namespace = ANY($1)", [
    TEST_NAMESPACES,
  ]);
  const filler: ChunkFixture[] = Array.from(
    { length: FILLER_ROWS },
    (_, index) => {
      const g = index + 1;
      return {
        chunkId: `bm25-filler-${g}`,
        documentId: `bm25-filler-doc-${Math.trunc(g / 4)}`,
        namespace: WIDE_NAMESPACE,
        text: `filler ${FILLER_NOUNS[g % 10] ?? ""} ${FILLER_NOUNS[g % 6] ?? ""} report`,
      };
    }
  );
  const probes: ChunkFixture[] = [
    ["bm25-ident", "fixture identifier KWREF-6087 marks the keyword channel"],
    [
      "bm25-rare",
      "the fluxcapacitor valve regulates pressure in the storage room",
    ],
    ["bm25-stem", "the service runs continuously and the runner retries"],
    ["bm25-punct", "restart failed; check the logs, then reboot"],
  ].map(([chunkId = "", text = ""]) => ({
    chunkId,
    documentId: `${chunkId}-doc`,
    namespace: WIDE_NAMESPACE,
    text,
  }));
  const sparse: ChunkFixture[] = Array.from({ length: 5 }, (_, index) => ({
    chunkId: `bm25-sparse-${index + 1}`,
    documentId: `bm25-sparse-doc-${index + 1}`,
    namespace: SPARSE_NAMESPACE,
    text: `sparse collection row ${index + 1} about network policy`,
  }));
  await insertChunkFixtures(client, [
    ...filler,
    ...probes,
    // Superseded: must stay invisible to the default (live-only) search.
    {
      chunkId: "bm25-dead",
      documentId: "bm25-dead-doc",
      namespace: WIDE_NAMESPACE,
      superseded: true,
      text: "dead chunk marker KWXDEAD-1",
    },
    {
      chunkId: "bm25-other-1",
      documentId: "bm25-other-doc",
      namespace: OTHER_NAMESPACE,
      text: "wireless headphones live in another collection",
    },
    ...sparse,
  ]);
  // Refresh planner statistics so EXPLAIN sees the loaded corpus size.
  await client.query("ANALYZE chunks", []);
};

const explainSearch = async (
  client: PgClient,
  built: Bm25SearchQuery
): Promise<string> => {
  const result = await client.query(`EXPLAIN (COSTS OFF) ${built.text}`, [
    ...built.params,
  ]);
  return result.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
};

test(
  "integration: EXPLAIN index use + query classes on a seeded chunk corpus",
  { skip: !hasLiveDb },
  async () => {
    await withBm25ClientFromEnv(async (client) => {
      await migrateKnowledgeSchema(client);
      await seedFixture(client);

      // --- EXPLAIN: wide namespace uses the BM25 index -------------------
      const widePlan = await explainSearch(
        client,
        buildBm25SearchQuery("filler report", {
          limit: 10,
          namespace: WIDE_NAMESPACE,
        })
      );
      assert.ok(
        widePlan.includes(BM25_INDEX_NAME),
        `top-k over a wide namespace must scan ${BM25_INDEX_NAME}:\n${widePlan}`
      );
      assert.ok(
        !widePlan.includes("Seq Scan on chunks"),
        `top-k must not fall back to a sequential scan:\n${widePlan}`
      );

      // --- EXPLAIN: selective namespace pre-filters via the B-tree -------
      const sparsePlan = await explainSearch(
        client,
        buildBm25SearchQuery("network policy", {
          limit: 5,
          namespace: SPARSE_NAMESPACE,
        })
      );
      assert.ok(
        sparsePlan.includes("chunks_namespace_active"),
        `selective namespace filter must be supported by the B-tree:\n${sparsePlan}`
      );
      assert.ok(
        !sparsePlan.includes("Seq Scan on chunks"),
        `selective namespace top-k must not scan sequentially:\n${sparsePlan}`
      );

      // --- Exact identifier ----------------------------------------------
      const ident = await searchBm25(client, "KWREF-6087", {
        limit: 3,
        namespace: WIDE_NAMESPACE,
      });
      assert.ok(ident.length >= 1, "exact identifier must match its chunk");
      assert.equal(ident[0]?.chunkId, "bm25-ident");
      assert.equal(ident[0]?.documentId, "bm25-ident-doc");
      assert.equal(ident[0]?.versionId, fixtureVersionId("bm25-ident-doc"));
      assert.equal(ident[0]?.namespace, WIDE_NAMESPACE);
      assert.equal(ident[0]?.rank, 1);
      assert.ok(
        ident[0] !== undefined && ident[0].score < 0,
        "pg_textsearch returns negative BM25 scores (lower = better)"
      );

      // --- Rare term: IDF pulls exactly the one chunk containing it ------
      const rare = await searchBm25(client, "fluxcapacitor", {
        limit: 10,
        namespace: WIDE_NAMESPACE,
      });
      assert.deepEqual(
        rare.map((hit) => hit.chunkId),
        ["bm25-rare"]
      );

      // --- Stemming: english config matches inflected forms --------------
      const stem = await searchBm25(client, "running", {
        limit: 5,
        namespace: WIDE_NAMESPACE,
      });
      assert.ok(stem.length >= 1, "stemmed query must match its chunk");
      assert.equal(stem[0]?.chunkId, "bm25-stem");

      // --- Punctuation: tokenizer ignores punctuation placement ----------
      const punct = await searchBm25(
        client,
        "restart, failed; (check the logs)!",
        { limit: 5, namespace: WIDE_NAMESPACE }
      );
      assert.ok(punct.length >= 1, "punctuated query must match its chunk");
      assert.equal(punct[0]?.chunkId, "bm25-punct");

      // --- No-result queries return an empty result, never fabrications --
      const none = await searchBm25(client, "zzqqxw qwertyuiopvbx", {
        limit: 10,
        namespace: WIDE_NAMESPACE,
      });
      assert.deepEqual(none, []);

      // --- Namespace isolation: the collection filter is exact -----------
      const other = await searchBm25(client, "wireless headphones", {
        limit: 10,
        namespace: OTHER_NAMESPACE,
      });
      assert.deepEqual(
        other.map((hit) => hit.chunkId),
        ["bm25-other-1"]
      );
      const leaked = await searchBm25(client, "wireless headphones", {
        limit: 10,
        namespace: WIDE_NAMESPACE,
      });
      assert.deepEqual(leaked, []);

      // --- Superseded chunks are hidden unless explicitly included -------
      const dead = await searchBm25(client, "KWXDEAD-1", {
        limit: 10,
        namespace: WIDE_NAMESPACE,
      });
      assert.deepEqual(dead, []);

      // --- Selective namespace returns only that collection's rows -------
      const sparse = await searchBm25(client, "network policy", {
        limit: 5,
        namespace: SPARSE_NAMESPACE,
      });
      assert.equal(sparse.length, 5);
      for (const [index, hit] of sparse.entries()) {
        assert.equal(hit.namespace, SPARSE_NAMESPACE);
        assert.equal(hit.rank, index + 1);
      }
      for (let i = 1; i < sparse.length; i += 1) {
        const prev = sparse[i - 1]?.score ?? 0;
        const curr = sparse[i]?.score ?? 0;
        assert.ok(
          prev <= curr,
          `scores not ascending (negative BM25): ${prev} > ${curr}`
        );
      }

      await client.query("DELETE FROM chunks WHERE namespace = ANY($1)", [
        TEST_NAMESPACES,
      ]);
    });
  }
);
