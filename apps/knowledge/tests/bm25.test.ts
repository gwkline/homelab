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
import type { Bm25DbClient } from "../src/bm25.ts";

const stubClient = (
  rows: Array<Record<string, unknown>>,
  seen: { text?: string; params?: unknown[] } = {}
): Bm25DbClient => ({
  query: (text: string, params: unknown[]) => {
    seen.text = text;
    seen.params = params;
    return Promise.resolve({ rows });
  },
});

test("builder binds query text + limit, names the bm25 index explicitly", () => {
  const built = buildBm25SearchQuery("wireless headphones", { limit: 5 });

  assert.deepEqual(built.params, ["wireless headphones", 5]);
  assert.ok(
    built.text.includes(`"content" <@> to_bm25query($1, '${BM25_INDEX_NAME}')`),
    `missing <@> ranking against ${BM25_INDEX_NAME}: ${built.text}`
  );
  assert.ok(
    built.text.includes("ORDER BY score ASC"),
    `negative BM25 must sort ascending: ${built.text}`
  );
  assert.ok(built.text.includes("LIMIT $2"), `limit must bind: ${built.text}`);
  // Query text is a bind param, never interpolated into the SQL.
  assert.ok(!built.text.includes("wireless headphones"));
});

test("builder defaults: limit 10, docs_content_bm25 index", () => {
  const built = buildBm25SearchQuery("retirement savings");
  assert.deepEqual(built.params, ["retirement savings", 10]);
  assert.ok(built.text.includes(`'${BM25_INDEX_NAME}'`));
});

test("builder accepts a custom index name, rejects injection", () => {
  const ok = buildBm25SearchQuery("q", { indexName: "docs_simple_idx" });
  assert.ok(ok.text.includes("to_bm25query($1, 'docs_simple_idx')"));

  assert.throws(
    () => buildBm25SearchQuery("q", { indexName: "docs; DROP TABLE docs;--" }),
    /invalid index name/
  );
});

test("builder rejects empty queries and bad limits without touching the db", () => {
  for (const bad of ["", "   "]) {
    assert.throws(() => buildBm25SearchQuery(bad), /non-empty string/);
  }
  for (const bad of [0, -3, 2.5, Number.NaN]) {
    assert.throws(
      () => buildBm25SearchQuery("q", { limit: bad }),
      /limit must be an integer >= 1/
    );
  }
});

test("parseBm25Rows maps rows, coerces missing content, rejects bad rows", () => {
  const hits = parseBm25Rows([
    { content: "alpha text", id: "a", score: -3.2 },
    { id: "b", score: -1.1 },
  ]);
  assert.deepEqual(hits, [
    { content: "alpha text", id: "a", score: -3.2 },
    { content: "", id: "b", score: -1.1 },
  ]);

  assert.throws(() => parseBm25Rows([{ id: "a" }]), /no numeric score/);
  assert.throws(
    () => parseBm25Rows([{ content: "x", id: "a", score: "high" }]),
    /no numeric score/
  );
  assert.throws(
    () => parseBm25Rows([{ content: "x", id: 7, score: -1 }]),
    /no string id/
  );
});

test("searchBm25 returns hits best-first and sends the built query", async () => {
  const seen: { text?: string; params?: unknown[] } = {};
  const client = stubClient(
    [
      { content: "best", id: "doc-1", score: -4.0 },
      { content: "worse", id: "doc-2", score: -0.5 },
    ],
    seen
  );

  const hits = await searchBm25(client, "network error", { limit: 2 });

  assert.deepEqual(
    hits.map((hit) => hit.id),
    ["doc-1", "doc-2"]
  );
  assert.deepEqual(seen.params, ["network error", 2]);
  assert.ok(seen.text?.includes("<@> to_bm25query("));
});

test("searchBm25 validates before issuing any query", async () => {
  let calls = 0;
  const client: Bm25DbClient = {
    query: () => {
      calls += 1;
      return Promise.resolve({ rows: [] });
    },
  };
  await assert.rejects(() => searchBm25(client, "   "), /non-empty string/);
  await assert.rejects(() => searchBm25(client, "q", { limit: 0 }), /limit/);
  assert.equal(calls, 0);
});

test("ensureBm25Schema runs the migration: extension, table, bm25 index", async () => {
  const seen: { text?: string; params?: unknown[] } = {};
  await ensureBm25Schema(stubClient([], seen));
  assert.ok(
    seen.text?.includes("CREATE EXTENSION IF NOT EXISTS pg_textsearch"),
    "migration must enable pg_textsearch"
  );
  assert.ok(
    seen.text?.includes("USING bm25 (content)"),
    "migration must create the single-column bm25 index"
  );
  assert.ok(
    seen.text?.includes("WITH (text_config = 'english')"),
    "migration must pin text_config english"
  );
  assert.ok(
    seen.text?.includes("CREATE TABLE IF NOT EXISTS docs"),
    "migration must create the docs table"
  );
  assert.ok(
    seen.text === BM25_MIGRATION_SQL,
    "migration runs as one idempotent script"
  );
});

test("integration path requires DATABASE_URL when env is empty", async () => {
  const saved = process.env["DATABASE_URL"];
  delete process.env["DATABASE_URL"];
  try {
    await assert.rejects(
      () => withBm25ClientFromEnv(() => Promise.resolve(0)),
      /DATABASE_URL is not set/
    );
  } finally {
    if (saved !== undefined) {
      process.env["DATABASE_URL"] = saved;
    }
  }
});

// Live-DB integration: runs only when DATABASE_URL points at a Postgres
// with pg_textsearch (issue #48 image). Otherwise skipped in CI/offline.
const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

test(
  "integration: migration + ranked search over seeded docs",
  { skip: !hasLiveDb },
  async () => {
    await withBm25ClientFromEnv(async (client) => {
      await ensureBm25Schema(client);
      await client.query("DELETE FROM docs WHERE id LIKE 'bm25-test-%'", []);
      const seed: Array<[string, string]> = [
        ["bm25-test-1", "wireless noise-cancelling headphones review"],
        ["bm25-test-2", "wired earbuds buying guide"],
        ["bm25-test-3", "retirement savings account basics"],
      ];
      for (const [id, content] of seed) {
        await client.query(
          "INSERT INTO docs (id, content) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content",
          [id, content]
        );
      }

      const hits = await searchBm25(client, "wireless headphones", {
        limit: 3,
      });
      assert.ok(hits.length >= 1, "expected at least one hit");
      assert.equal(hits[0]?.id, "bm25-test-1");
      // Negative BM25: ascending order, best (most negative) first.
      for (let i = 1; i < hits.length; i += 1) {
        const prev = hits[i - 1]?.score ?? 0;
        const curr = hits[i]?.score ?? 0;
        assert.ok(prev <= curr, `scores not ascending: ${prev} > ${curr}`);
      }

      await client.query("DELETE FROM docs WHERE id LIKE 'bm25-test-%'", []);
    });
  }
);
