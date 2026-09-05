import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BM25_INDEX_NAME,
  BM25_MIGRATION_SQL,
  buildBm25SearchQuery,
  ensureBm25Schema,
  parseBm25Rows,
  searchBm25,
  withBm25ClientFromEnv,
} from "../src/bm25.ts";
import type { Bm25DbClient, Bm25SearchQuery } from "../src/bm25.ts";
import { ensurePgvectorSchema } from "../src/pgvector.ts";

const stubClient = (
  rows: Record<string, unknown>[],
  seen: { text?: string; params?: unknown[] } = {}
): Bm25DbClient => ({
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

test("builder includeSuperseded drops the active-version predicate", () => {
  const built = buildBm25SearchQuery("q", { includeSuperseded: true });
  assert.ok(
    !built.text.includes('"valid_to" IS NULL'),
    "superseded mode cannot use the partial index"
  );
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
  // Exact identifiers, punctuation, and stemming candidates must reach the
  // index untouched: the english text_config tokenizes/stems on the database
  // side, and any application-side mangling would break provenance. Rare-term
  // and no-result classes are proven live (they need real IDF/statistics).
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
  const client: Bm25DbClient = {
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

test("ensureBm25Schema runs the migration: extension, B-tree, partial bm25 index", async () => {
  const seen: { text?: string; params?: unknown[] } = {};
  await ensureBm25Schema(stubClient([], seen));
  assert.ok(
    seen.text === BM25_MIGRATION_SQL,
    "migration runs as one idempotent script"
  );
  assert.ok(
    seen.text?.includes("CREATE EXTENSION IF NOT EXISTS pg_textsearch"),
    "migration must enable pg_textsearch"
  );
  assert.ok(
    seen.text?.includes("ON chunks (namespace) WHERE valid_to IS NULL"),
    "migration must add the B-tree supporting the namespace filter"
  );
  assert.ok(
    seen.text?.includes("USING bm25 (text)"),
    "migration must index the chunk text column"
  );
  assert.ok(
    seen.text?.includes("WITH (text_config = 'english')"),
    "migration must pin text_config english"
  );
  assert.ok(
    seen.text?.includes("WHERE valid_to IS NULL"),
    "bm25 index must be partial over live chunks so corpus statistics exclude them"
  );
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

// Live-DB integration: runs only when DATABASE_URL points at a Postgres with
// BOTH pg_textsearch and pgvector (the knowledge CNPG cluster: the shared
// chunks schema needs the vector type, the keyword channel needs the BM25
// index). Otherwise skipped in CI/offline, like the pgvector integration test.
const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

const WIDE_NAMESPACE = "bm25-wide";
const SPARSE_NAMESPACE = "bm25-sparse";
const OTHER_NAMESPACE = "bm25-other";
const TEST_NAMESPACES = [WIDE_NAMESPACE, SPARSE_NAMESPACE, OTHER_NAMESPACE];

/**
 * Deterministic filler corpus: 10_000 rows cycling two topic lists (LCM 70
 * distinct texts, no digits, no probe terms) so the planner has realistic
 * statistics and BM25 has varied term frequencies. "Sufficiently sized" per
 * #60: the EXPLAIN assertions below need a corpus big enough that top-k
 * planning prefers the indexes over a sequential scan.
 */
const FILLER_ROWS = 10_000;

const seedFixture = async (client: Bm25DbClient): Promise<void> => {
  await client.query("DELETE FROM chunks WHERE namespace = ANY($1)", [
    TEST_NAMESPACES,
  ]);
  await client.query(
    `INSERT INTO chunks (chunk_id, document_id, version_id, namespace, text)
SELECT 'bm25-filler-' || g,
       'bm25-filler-doc-' || (g / 4),
       'v1',
       $1,
       'filler ' || (ARRAY['database', 'network', 'storage', 'backup', 'cluster', 'router', 'volume', 'policy', 'image', 'gateway'])[1 + (g % 10)]
         || ' ' || (ARRAY['database', 'network', 'storage', 'backup', 'cluster', 'router'])[1 + (g % 7)] || ' report'
FROM generate_series(1, $2) AS g`,
    [WIDE_NAMESPACE, FILLER_ROWS]
  );

  const probeInsert = `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text)
VALUES ($1, $2, 'v1', $3, $4)`;
  const probes: [string, string, string][] = [
    [
      "bm25-ident",
      "bm25-ident-doc",
      "fixture identifier KWREF-6087 marks the keyword channel",
    ],
    [
      "bm25-rare",
      "bm25-rare-doc",
      "the fluxcapacitor valve regulates pressure in the storage room",
    ],
    [
      "bm25-stem",
      "bm25-stem-doc",
      "the service runs continuously and the runner retries",
    ],
    [
      "bm25-punct",
      "bm25-punct-doc",
      "restart failed; check the logs, then reboot",
    ],
  ];
  await Promise.all(
    probes.map(([chunkId, documentId, text]) =>
      client.query(probeInsert, [chunkId, documentId, WIDE_NAMESPACE, text])
    )
  );
  // Superseded chunk: must stay invisible to the default (live-only) search.
  await client.query(
    `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text, valid_to)
VALUES ('bm25-dead', 'bm25-dead-doc', 'v1', $1, 'dead chunk marker KWXDEAD-1', now())`,
    [WIDE_NAMESPACE]
  );
  await client.query(probeInsert, [
    "bm25-other-1",
    "bm25-other-doc",
    OTHER_NAMESPACE,
    "wireless headphones live in another collection",
  ]);
  await client.query(
    `INSERT INTO chunks (chunk_id, document_id, version_id, namespace, text)
SELECT 'bm25-sparse-' || g,
       'bm25-sparse-doc-' || g,
       'v1',
       $1,
       'sparse collection row ' || g || ' about network policy'
FROM generate_series(1, 5) AS g`,
    [SPARSE_NAMESPACE]
  );
  // Refresh planner statistics after the bulk load so EXPLAIN reflects the
  // real corpus size instead of stale pre-load estimates.
  await client.query("ANALYZE chunks", []);
};

/** EXPLAIN the built search query and return the plan as one string. */
const explainSearch = async (
  client: Bm25DbClient,
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
      // The shared chunks schema (vector type + base indexes), then the BM25
      // channel's extension + indexes.
      await ensurePgvectorSchema(client);
      await ensureBm25Schema(client);
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
      assert.equal(ident[0]?.versionId, "v1");
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
      const deadIncluded = await searchBm25(client, "KWXDEAD-1", {
        includeSuperseded: true,
        limit: 10,
        namespace: WIDE_NAMESPACE,
      });
      assert.deepEqual(
        deadIncluded.map((hit) => hit.chunkId),
        ["bm25-dead"]
      );

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
