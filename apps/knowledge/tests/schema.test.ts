import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { PgClient } from "../src/pg-client.ts";
import { parseAnchors } from "../src/pgvector.ts";
import {
  buildChunkReactivateCurrent,
  buildChunkSupersede,
  buildChunkUpsert,
  buildDocumentRestore,
  buildDocumentTombstone,
  buildDocumentUpsert,
  buildDocumentVersionInsert,
  buildNamespaceRegistration,
  KNOWLEDGE_MIGRATIONS,
  KNOWLEDGE_NAMESPACE_PATTERN,
  KNOWLEDGE_SCHEMA_VERSION,
  migrateKnowledgeSchema,
  readKnowledgeSchemaVersion,
} from "../src/schema.ts";
import type { ChunkUpsertInput } from "../src/schema.ts";
import { fakePool } from "./fake-pool.ts";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const MIGRATION_SQL = KNOWLEDGE_MIGRATIONS.map(
  (migration) => migration.sql
).join("\n");

const TABLE_DEFINITION =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<table>\w+)/giu;

const definedTables = (sql: string): string[] =>
  [...sql.matchAll(TABLE_DEFINITION)].map(
    (match) => match.groups?.["table"] ?? ""
  );

// --- Migration DDL shape -------------------------------------------------

test("migrations define the corpus, the ingest queue, and nothing twice", () => {
  assert.deepEqual(definedTables(MIGRATION_SQL).toSorted(), [
    "chunks",
    "document",
    "document_version",
    "git_source_manifest",
    "ingest_document",
    "ingest_job",
    "ingest_source",
    "knowledge_namespace",
  ]);
  const sql = MIGRATION_SQL;
  // Source identity is separate from content versions.
  assert.ok(
    sql.includes("UNIQUE (namespace, source, external_id)"),
    "document identity must be (namespace, source, external_id)"
  );
  assert.ok(
    sql.includes("UNIQUE (document_id, version)"),
    "document_version must be unique per (document, version)"
  );
  // Re-ingesting unchanged text is a DB-level no-op.
  assert.ok(
    sql.includes("UNIQUE (document_id, content_hash)"),
    "chunks must be content-addressed by (document_id, content_hash)"
  );
  for (const fk of [
    "document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE",
    "version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE",
  ]) {
    assert.ok(sql.includes(fk), `missing FK ${fk}`);
  }
  // Every chunk result must resolve to a source, title, and url (ADR-002 D8).
  for (const column of [
    "source TEXT NOT NULL CHECK (length(source) > 0)",
    "title TEXT",
    "url TEXT",
    "deleted_at TIMESTAMPTZ",
  ]) {
    assert.ok(sql.includes(column), `missing document column ${column}`);
  }
  assert.ok(
    sql.includes("REFERENCES knowledge_namespace(name)"),
    "document and chunks must scope to the namespace registry"
  );
  assert.ok(sql.includes("anchors JSONB NOT NULL DEFAULT '[]'::jsonb"));
  assert.ok(sql.includes("idx INT NOT NULL DEFAULT 0"));
  assert.ok(
    sql.includes("valid_from TIMESTAMPTZ NOT NULL DEFAULT now()") &&
      sql.includes("valid_to TIMESTAMPTZ")
  );
  assert.ok(sql.includes("embedding vector(384)"));
  assert.ok(sql.includes("embedding_model TEXT"));
  // The queue: idempotent enqueue, the live state machine, a version ledger.
  assert.match(sql, /idempotency_key TEXT NOT NULL UNIQUE/u);
  assert.match(
    sql,
    /CHECK \(kind IN \('document', 'document-version', 'source_sync'\)\)/u
  );
  assert.match(
    sql,
    /CHECK \(status IN \('pending', 'running', 'succeeded', 'retryable', 'dead'\)\)/u
  );
  assert.match(
    sql,
    /UNIQUE \(namespace, source_id, external_id, version_id\)/u
  );
});

test("migration DDL carries the advanced and channel indexes", () => {
  const sql = MIGRATION_SQL;
  assert.ok(
    sql.includes(
      "CREATE INDEX IF NOT EXISTS chunks_namespace_active\n  ON chunks (namespace) WHERE valid_to IS NULL"
    ),
    "namespace scoping must be indexed over live chunks"
  );
  assert.ok(
    sql.includes(
      "CREATE INDEX IF NOT EXISTS document_tombstoned\n  ON document (deleted_at) WHERE deleted_at IS NOT NULL"
    ),
    "tombstones must be indexed for the GC clock"
  );
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS ingest_job_claimable[\s\S]*WHERE status IN \('pending', 'retryable'\)/u,
    "the SKIP LOCKED claim scan needs its partial index"
  );
  assert.ok(
    sql.includes("DROP INDEX IF EXISTS ingest_job_claim;"),
    "the claim index for the unused 'queued' status is dropped"
  );
  assert.ok(sql.includes("CREATE EXTENSION IF NOT EXISTS vector"));
  assert.ok(sql.includes("CREATE EXTENSION IF NOT EXISTS pg_textsearch"));
  assert.ok(
    sql.includes(
      "ON chunks USING bm25 (text)\n  WITH (text_config = 'english')\n  WHERE valid_to IS NULL"
    ),
    "bm25 index must be partial over live chunks so corpus statistics exclude them"
  );
  assert.ok(
    sql.includes(
      "ON chunks USING hnsw (embedding vector_cosine_ops)\n  WHERE valid_to IS NULL AND embedding IS NOT NULL"
    ),
    "hnsw index must use the cosine metric over live, embedded chunks"
  );
});

test("migration 1 adopts pre-ledger databases: every statement is re-runnable", () => {
  const [first] = KNOWLEDGE_MIGRATIONS;
  assert.ok(first !== undefined);
  for (const column of [
    "idx",
    "content_hash",
    "chunker_version",
    "valid_from",
  ]) {
    assert.ok(
      first.sql.includes(`ADD COLUMN IF NOT EXISTS ${column}`),
      `stopgap upgrade path missing for ${column}`
    );
  }
  for (const statement of first.sql
    .split("\n")
    .filter((line) => /^(?:CREATE|DROP) /u.test(line))) {
    assert.match(
      statement,
      /IF (?:NOT )?EXISTS/u,
      `non-idempotent DDL: ${statement}`
    );
  }
});

test("migration ids are unique and ascending; the schema version is the newest", () => {
  const ids = KNOWLEDGE_MIGRATIONS.map((migration) => migration.id);
  assert.deepEqual(
    ids,
    ids.toSorted((a, b) => a - b)
  );
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(KNOWLEDGE_SCHEMA_VERSION, ids.at(-1));
});

const ledgerBackend = (appliedIds: number[], failOn?: string): PgClient => ({
  query: (text) => {
    if (failOn !== undefined && text.includes(failOn)) {
      return Promise.reject(new Error("migration failed"));
    }
    if (text === "SELECT id FROM knowledge_schema_migration") {
      return Promise.resolve({ rows: appliedIds.map((id) => ({ id })) });
    }
    return Promise.resolve({ rows: [] });
  },
});

test("migrate applies pending migrations under an advisory lock in one transaction", async () => {
  const { calls, pool, releases } = fakePool(ledgerBackend([]));
  const applied = await migrateKnowledgeSchema(pool);
  assert.deepEqual(
    applied,
    KNOWLEDGE_MIGRATIONS.map((migration) => migration.id)
  );
  assert.ok(calls.every((call) => call.checkout === 1));
  const texts = calls.map((call) => call.text);
  assert.equal(texts[0], "BEGIN");
  assert.match(texts[1] ?? "", /pg_advisory_xact_lock/u);
  assert.match(texts[2] ?? "", /knowledge_schema_migration/u);
  assert.equal(texts[4], KNOWLEDGE_MIGRATIONS[0]?.sql);
  assert.match(texts[5] ?? "", /^INSERT INTO knowledge_schema_migration/u);
  assert.equal(texts.at(-1), "COMMIT");
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
});

test("migrate is a no-op once every migration is recorded", async () => {
  const { calls, pool } = fakePool(
    ledgerBackend(KNOWLEDGE_MIGRATIONS.map((migration) => migration.id))
  );
  assert.deepEqual(await migrateKnowledgeSchema(pool), []);
  assert.ok(
    !calls.some((call) =>
      KNOWLEDGE_MIGRATIONS.some((migration) => migration.sql === call.text)
    ),
    "applied migrations never re-run"
  );
});

test("a failing migration rolls back with its ledger row", async () => {
  const { calls, pool } = fakePool(
    ledgerBackend([], "CREATE EXTENSION IF NOT EXISTS vector")
  );
  await assert.rejects(migrateKnowledgeSchema(pool), /migration failed/u);
  const texts = calls.map((call) => call.text);
  assert.equal(texts.at(-1), "ROLLBACK");
  assert.ok(!texts.includes("COMMIT"));
});

test("the schema version reads 0 before the ledger exists, then its newest id", async () => {
  const absent: string[] = [];
  const before = await readKnowledgeSchemaVersion({
    query: (text) => {
      absent.push(text);
      return Promise.resolve({ rows: [{ present: false }] });
    },
  });
  assert.equal(before, 0);
  assert.equal(absent.length, 1, "no query touches a missing ledger");
  const after = await readKnowledgeSchemaVersion({
    query: (text) =>
      Promise.resolve({
        rows: text.includes("to_regclass")
          ? [{ present: true }]
          : [{ version: 3 }],
      }),
  });
  assert.equal(after, 3);
});

const KNOWLEDGE_DIRS = [
  "knowledge/src",
  "knowledge/eval",
  "knowledge/tests",
  "knowledge-ingest/server",
  "knowledge-ingest/tests",
  "knowledge-retrieval/server",
  "knowledge-retrieval/tests",
];

test("every table is defined once, in schema.ts", () => {
  const appsDir = path.resolve(import.meta.dirname, "../..");
  const definitions = KNOWLEDGE_DIRS.flatMap((dir) =>
    readdirSync(path.join(appsDir, dir), {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .flatMap((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return definedTables(readFileSync(file, "utf-8")).map((table) => ({
          file: path.relative(appsDir, file),
          table,
        }));
      })
  );
  assert.ok(definitions.length > 0);
  assert.deepEqual(
    [...new Set(definitions.map((definition) => definition.file))],
    ["knowledge/src/schema.ts"]
  );
  const tables = definitions.map((definition) => definition.table);
  assert.equal(new Set(tables).size, tables.length, tables.join(", "));
});

// --- Builder contracts ----------------------------------------------------

test("namespace registration binds an idempotent upsert", () => {
  const built = buildNamespaceRegistration("homelab-docs", "primary corpus");
  assert.deepEqual(built.params, ["homelab-docs", "primary corpus"]);
  assert.ok(built.text.includes("ON CONFLICT (name) DO NOTHING"));
  assert.throws(
    () => buildNamespaceRegistration("bad namespace!"),
    /invalid namespace/u
  );
  assert.throws(() => buildNamespaceRegistration(""), /invalid namespace/u);
  assert.ok(KNOWLEDGE_NAMESPACE_PATTERN.test("a.b-c_d"));
});

test("document upsert keys identity and no-ops on unchanged content", () => {
  const built = buildDocumentUpsert({
    content_hash: sha256("body"),
    external_id: "docs/k56.md",
    id: "doc-1",
    namespace: "default",
    source: "file",
    title: "Doc",
    url: null,
  });
  assert.deepEqual(built.params, [
    "doc-1",
    "default",
    "file",
    "docs/k56.md",
    "Doc",
    null,
    sha256("body"),
  ]);
  assert.ok(
    built.text.includes("ON CONFLICT (namespace, source, external_id)"),
    "identity conflict target must be the stable source key"
  );
  assert.ok(
    built.text.includes("version = document.version + 1"),
    "changed content must bump the version"
  );
  assert.ok(
    built.text.includes(
      "WHERE document.content_hash IS DISTINCT FROM EXCLUDED.content_hash"
    ),
    "unchanged content must filter the update out entirely"
  );
  assert.ok(
    built.text.includes("deleted_at = NULL"),
    "changed content must clear a tombstone"
  );
  assert.ok(built.text.includes("RETURNING id, version"));
});

test("document upsert validates identity fields and hashes", () => {
  const valid = {
    content_hash: sha256("body"),
    external_id: "docs/k56.md",
    id: "doc-1",
    namespace: "default",
    source: "file",
  };
  assert.throws(
    () => buildDocumentUpsert({ ...valid, content_hash: "nothex" }),
    /sha256 hex digest/u
  );
  assert.throws(
    () => buildDocumentUpsert({ ...valid, external_id: "" }),
    /invalid external_id/u
  );
  assert.throws(
    () => buildDocumentUpsert({ ...valid, source: "" }),
    /invalid source/u
  );
  assert.throws(
    () => buildDocumentUpsert({ ...valid, namespace: "nope nope" }),
    /invalid namespace/u
  );
  assert.throws(
    () => buildDocumentUpsert({ ...valid, id: "" }),
    /invalid document id/u
  );
  assert.throws(
    () => buildDocumentUpsert({ ...valid, title: 5 as unknown as string }),
    /title must be a string/u
  );
});

test("document version insert appends history idempotently", () => {
  const built = buildDocumentVersionInsert({
    content_hash: sha256("v2"),
    document_id: "doc-1",
    id: "doc-1:v2",
    version: 2,
  });
  assert.deepEqual(built.params, ["doc-1:v2", "doc-1", 2, sha256("v2")]);
  assert.ok(
    built.text.includes("ON CONFLICT (document_id, version) DO NOTHING")
  );
  assert.throws(
    () =>
      buildDocumentVersionInsert({
        content_hash: sha256("v"),
        document_id: "doc-1",
        id: "v0",
        version: 0,
      }),
    /version must be an integer >= 1/u
  );
  assert.throws(
    () =>
      buildDocumentVersionInsert({
        content_hash: "zz",
        document_id: "doc-1",
        id: "v2",
        version: 2,
      }),
    /sha256 hex digest/u
  );
});

test("chunk supersede hides live chunks via the channels' own predicate", () => {
  const built = buildChunkSupersede("doc-1");
  assert.deepEqual(built.params, ["doc-1"]);
  assert.ok(built.text.includes("SET valid_to = now()"));
  assert.ok(built.text.includes("WHERE document_id = $1 AND valid_to IS NULL"));
  assert.throws(() => buildChunkSupersede(""), /invalid document id/u);
});

test("chunk upsert is content-addressed and never rewrites embeddings", () => {
  const chunk: ChunkUpsertInput = {
    anchors: [{ end: 9, start: 0, type: "offset" }],
    chunk_id: "c-1",
    chunker_version: "k56-v1",
    content_hash: sha256("alpha text"),
    document_id: "doc-1",
    idx: 0,
    namespace: "default",
    text: "alpha text",
    version_id: "doc-1:v1",
  };
  const built = buildChunkUpsert(chunk);
  assert.deepEqual(built.params, [
    "c-1",
    "doc-1",
    "doc-1:v1",
    "default",
    0,
    "alpha text",
    sha256("alpha text"),
    JSON.stringify([{ end: 9, start: 0, type: "offset" }]),
    "k56-v1",
  ]);
  assert.ok(
    built.text.includes("ON CONFLICT (document_id, content_hash)"),
    "chunk identity is content-addressed"
  );
  assert.ok(
    built.text.includes("valid_to = NULL") &&
      built.text.includes("valid_from = now()"),
    "conflicting rows must be reactivated"
  );
  assert.ok(
    !built.text.includes("embedding ="),
    "the reactivation must not touch the embedding column"
  );
  assert.ok(built.text.includes("RETURNING chunk_id"));
  assert.throws(
    () => buildChunkUpsert({ ...chunk, content_hash: "deadbeef" }),
    /sha256 hex digest/u
  );
  assert.throws(
    () => buildChunkUpsert({ ...chunk, idx: -1 }),
    /idx must be an integer >= 0/u
  );
  assert.throws(
    () => buildChunkUpsert({ ...chunk, anchors: "[]" as unknown as unknown[] }),
    /anchors must be an array/u
  );
  assert.throws(
    () => buildChunkUpsert({ ...chunk, namespace: "nope nope" }),
    /invalid namespace/u
  );
});

test("tombstone sets the delete marker without destroying history", () => {
  const tombstone = buildDocumentTombstone("doc-1");
  assert.deepEqual(tombstone.params, ["doc-1"]);
  assert.ok(
    tombstone.text.includes("deleted_at = COALESCE(deleted_at, now())"),
    "re-tombstoning must not move the clock"
  );
  assert.ok(tombstone.text.includes("RETURNING id, deleted_at"));

  const restore = buildDocumentRestore("doc-1");
  assert.ok(restore.text.includes("SET deleted_at = NULL"));

  const reactivate = buildChunkReactivateCurrent("doc-1");
  assert.ok(
    reactivate.text.includes("v.version = d.version"),
    "reactivation must target the document's current version only"
  );
  assert.ok(reactivate.text.includes("c.valid_to IS NOT NULL"));
});

// --- Integration: migrate from empty PostgreSQL 18 and exercise invariants

const hasLiveDb = Boolean(process.env["DATABASE_URL"]);
const SCRATCH_SCHEMA = "knowledge_schema_test_56";
const NAMESPACE = "k56-test";

const unitVector384 = (index: number): string =>
  `[${Array.from({ length: 384 }, (_, i) => (i === index ? 1 : 0)).join(",")}]`;

const catalogConstraints = async (client: PgClient): Promise<string[]> => {
  const result = await client.query(
    `SELECT conname FROM pg_constraint c
     JOIN pg_class rel ON c.conrelid = rel.oid
     JOIN pg_namespace n ON rel.relnamespace = n.oid
     WHERE n.nspname = $1`,
    [SCRATCH_SCHEMA]
  );
  return result.rows.map((row) => String(row["conname"]));
};

const catalogIndexes = async (client: PgClient): Promise<string[]> => {
  const result = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = $1",
    [SCRATCH_SCHEMA]
  );
  return result.rows.map((row) => String(row["indexname"]));
};

test(
  "integration: migrate from empty PostgreSQL 18 and exercise insert/update/delete invariants",
  { skip: !hasLiveDb },
  async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env["DATABASE_URL"],
      options: `-c search_path=${SCRATCH_SCHEMA},public`,
    });
    try {
      // SCHEMA public keeps a first install out of the scratch schema so
      // cleanup can never drop it.
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
      await pool.query(
        "CREATE EXTENSION IF NOT EXISTS pg_textsearch SCHEMA public"
      );

      // --- From-empty migration ------------------------------------------
      await pool.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
      await pool.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`);
      assert.deepEqual(
        await migrateKnowledgeSchema(pool),
        KNOWLEDGE_MIGRATIONS.map((migration) => migration.id)
      );
      assert.equal(
        await readKnowledgeSchemaVersion(pool),
        KNOWLEDGE_SCHEMA_VERSION
      );
      assert.deepEqual(
        await migrateKnowledgeSchema(pool),
        [],
        "a second run applies nothing"
      );

      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [SCRATCH_SCHEMA]
      );
      assert.deepEqual(
        tables.rows.map((row) => String(row["table_name"])),
        [
          "chunks",
          "document",
          "document_version",
          "git_source_manifest",
          "ingest_document",
          "ingest_job",
          "ingest_source",
          "knowledge_namespace",
          "knowledge_schema_migration",
        ],
        "migration from empty must create the corpus and the queue"
      );

      const constraints = await catalogConstraints(pool);
      for (const expected of [
        "knowledge_namespace_pkey",
        "document_pkey",
        "document_namespace_source_external_id_key",
        "document_version_pkey",
        "document_version_document_id_version_key",
        "chunks_pkey",
        "chunks_document_id_content_hash_key",
        "ingest_job_pkey",
        "document_namespace_fkey",
        "document_version_document_id_fkey",
        "chunks_document_id_fkey",
        "chunks_version_id_fkey",
        "chunks_namespace_fkey",
        "ingest_job_status_check",
        "ingest_job_idempotency_key_key",
      ]) {
        assert.ok(
          constraints.includes(expected),
          `missing constraint ${expected}; got ${constraints.join(", ")}`
        );
      }

      const indexes = await catalogIndexes(pool);
      for (const index of [
        "chunks_namespace_active",
        "document_tombstoned",
        "ingest_job_claimable",
        "chunks_embedding_hnsw",
        "chunks_text_bm25",
      ]) {
        assert.ok(indexes.includes(index), `missing index ${index}`);
      }
      const bm25Def = await pool.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'chunks_text_bm25'`,
        [SCRATCH_SCHEMA]
      );
      const definition = String(bm25Def.rows[0]?.["indexdef"] ?? "");
      assert.match(definition, /USING bm25/u);
      assert.match(definition, /text_config\s*=\s*'?english'?/u);
      assert.match(definition, /WHERE[\s(]*valid_to IS NULL/u);

      // --- Insert path (namespace → document → version → chunks) ---------
      const registerNamespace = buildNamespaceRegistration(NAMESPACE);
      await pool.query(registerNamespace.text, registerNamespace.params);
      const docUpsertV1 = buildDocumentUpsert({
        content_hash: sha256("v1 body"),
        external_id: "docs/k56.md",
        id: "k56-doc",
        namespace: NAMESPACE,
        source: "file",
        title: "K56 doc",
      });
      const inserted = await pool.query(docUpsertV1.text, docUpsertV1.params);
      assert.deepEqual(inserted.rows, [{ id: "k56-doc", version: 1 }]);
      await pool.query(
        buildDocumentVersionInsert({
          content_hash: sha256("v1 body"),
          document_id: "k56-doc",
          id: "k56-doc:v1",
          version: 1,
        }).text,
        ["k56-doc:v1", "k56-doc", 1, sha256("v1 body")]
      );
      const chunksV1: ChunkUpsertInput[] = [
        {
          anchors: [{ end: 18, start: 0, type: "offset" }],
          chunk_id: "k56-c1",
          chunker_version: "k56-test-v1",
          content_hash: sha256("alpha introduction"),
          document_id: "k56-doc",
          idx: 0,
          namespace: NAMESPACE,
          text: "alpha introduction",
          version_id: "k56-doc:v1",
        },
        {
          anchors: [{ type: "heading", value: "Setup" }],
          chunk_id: "k56-c2",
          chunker_version: "k56-test-v1",
          content_hash: sha256("beta heading section"),
          document_id: "k56-doc",
          idx: 1,
          namespace: NAMESPACE,
          text: "beta heading section",
          version_id: "k56-doc:v1",
        },
        {
          anchors: [],
          chunk_id: "k56-c3",
          chunker_version: "k56-test-v1",
          content_hash: sha256("gamma deep details"),
          document_id: "k56-doc",
          idx: 2,
          namespace: NAMESPACE,
          text: "gamma deep details",
          version_id: "k56-doc:v1",
        },
      ];
      await Promise.all(
        chunksV1.map((chunk) => {
          const built = buildChunkUpsert(chunk);
          return pool.query(built.text, built.params);
        })
      );
      const chunkCount = await pool.query(
        `SELECT count(*)::int AS n FROM chunks
         WHERE namespace = $1 AND valid_to IS NULL`,
        [NAMESPACE]
      );
      assert.equal(chunkCount.rows[0]?.["n"], 3);

      const anchorRow = await pool.query(
        "SELECT anchors FROM chunks WHERE chunk_id = $1",
        ["k56-c2"]
      );
      assert.deepEqual(parseAnchors(anchorRow.rows[0]?.["anchors"], "k56-c2"), [
        { type: "heading", value: "Setup" },
      ]);

      // --- Referential + identity invariants ------------------------------
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO chunks
               (chunk_id, document_id, version_id, namespace, text, content_hash, chunker_version)
             VALUES ('k56-orphan', 'k56-missing-doc', 'k56-doc:v1', $1, 'orphan', $2, 'k56-test-v1')`,
            [NAMESPACE, sha256("orphan")]
          ),
        (error: { code?: string }) => error.code === "23503",
        "a chunk may not reference an unknown document"
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO document (id, namespace, source, external_id, content_hash)
             VALUES ('k56-ns-orphan', 'k56-missing-ns', 'file', 'x', $1)`,
            [sha256("x")]
          ),
        (error: { code?: string }) => error.code === "23503",
        "a document may not reference an unregistered namespace"
      );
      await assert.rejects(
        () =>
          pool.query(
            `INSERT INTO document (id, namespace, source, external_id, content_hash)
             VALUES ('k56-dup', $1, 'file', 'docs/k56.md', $2)`,
            [NAMESPACE, sha256("dup")]
          ),
        (error: { code?: string }) => error.code === "23505",
        "the stable identity key must be unique"
      );
      await assert.rejects(
        () =>
          pool.query(
            `UPDATE chunks SET embedding = '[1,2,3]'::vector
             WHERE chunk_id = 'k56-c1'`
          ),
        /384/u,
        "the vector(384) typmod must reject foreign dimensions"
      );

      // --- Re-ingesting unchanged content is a full no-op -----------------
      const docBefore = await pool.query(
        "SELECT version, content_hash, updated_at FROM document WHERE id = $1",
        ["k56-doc"]
      );
      const noopUpsert = buildDocumentUpsert({
        content_hash: sha256("v1 body"),
        external_id: "docs/k56.md",
        id: "k56-doc",
        namespace: NAMESPACE,
        source: "file",
        title: "K56 doc",
      });
      const noop = await pool.query(noopUpsert.text, noopUpsert.params);
      assert.equal(
        noop.rows.length,
        0,
        "unchanged content must return no rows"
      );
      const docAfter = await pool.query(
        "SELECT version, content_hash, updated_at FROM document WHERE id = $1",
        ["k56-doc"]
      );
      assert.deepEqual(docAfter.rows, docBefore.rows);
      const versionCount = await pool.query(
        "SELECT count(*)::int AS n FROM document_version WHERE document_id = $1",
        ["k56-doc"]
      );
      assert.equal(versionCount.rows[0]?.["n"], 1);

      // Embeddings survive without a re-embed (ADR-002 D10).
      await pool.query(
        `UPDATE chunks SET embedding = $1::vector, embedding_model = 'k56-test-model'
         WHERE chunk_id = 'k56-c1'`,
        [unitVector384(0)]
      );
      const [unchangedChunk] = chunksV1;
      assert.ok(unchangedChunk, "fixture must define its first chunk");
      const reUpsert = buildChunkUpsert(unchangedChunk);
      await pool.query(reUpsert.text, reUpsert.params);
      const preserved = await pool.query(
        "SELECT embedding::text AS embedding, embedding_model FROM chunks WHERE chunk_id = $1",
        ["k56-c1"]
      );
      assert.equal(preserved.rows[0]?.["embedding"], unitVector384(0));
      assert.equal(preserved.rows[0]?.["embedding_model"], "k56-test-model");

      // --- Update: version bump, supersession, provenance history ---------
      const changed = buildDocumentUpsert({
        content_hash: sha256("v2 body"),
        external_id: "docs/k56.md",
        id: "k56-doc",
        namespace: NAMESPACE,
        source: "file",
        title: "K56 doc",
      });
      const updated = await pool.query(changed.text, changed.params);
      assert.deepEqual(updated.rows, [{ id: "k56-doc", version: 2 }]);
      await pool.query(
        buildDocumentVersionInsert({
          content_hash: sha256("v2 body"),
          document_id: "k56-doc",
          id: "k56-doc:v2",
          version: 2,
        }).text,
        ["k56-doc:v2", "k56-doc", 2, sha256("v2 body")]
      );
      const superseded = await pool.query(buildChunkSupersede("k56-doc").text, [
        "k56-doc",
      ]);
      assert.equal(superseded.rows.length, 3);
      const liveAfterSupersede = await pool.query(
        "SELECT count(*)::int AS n FROM chunks WHERE namespace = $1 AND valid_to IS NULL",
        [NAMESPACE]
      );
      assert.equal(liveAfterSupersede.rows[0]?.["n"], 0);

      // One reactivated chunk, one new; the dropped chunk stays superseded.
      const reactivatedUpsert = buildChunkUpsert({
        ...unchangedChunk,
        chunk_id: "k56-c1-new",
        version_id: "k56-doc:v2",
      });
      await pool.query(reactivatedUpsert.text, reactivatedUpsert.params);
      const deltaUpsert = buildChunkUpsert({
        anchors: [],
        chunk_id: "k56-c4",
        chunker_version: "k56-test-v1",
        content_hash: sha256("delta new material"),
        document_id: "k56-doc",
        idx: 3,
        namespace: NAMESPACE,
        text: "delta new material",
        version_id: "k56-doc:v2",
      });
      await pool.query(deltaUpsert.text, deltaUpsert.params);

      const history = await pool.query(
        `SELECT id, version, content_hash FROM document_version
         WHERE document_id = $1 ORDER BY version`,
        ["k56-doc"]
      );
      assert.deepEqual(
        history.rows.map((row) => [row["version"], row["content_hash"]]),
        [
          [1, sha256("v1 body")],
          [2, sha256("v2 body")],
        ],
        "version history must be preserved for provenance"
      );
      const provenance = await pool.query(
        `SELECT c.chunk_id, c.version_id, v.version
         FROM chunks c JOIN document_version v ON v.id = c.version_id
         WHERE c.document_id = $1 AND c.valid_to IS NULL ORDER BY c.chunk_id`,
        ["k56-doc"]
      );
      assert.deepEqual(provenance.rows, [
        { chunk_id: "k56-c1", version: 2, version_id: "k56-doc:v2" },
        { chunk_id: "k56-c4", version: 2, version_id: "k56-doc:v2" },
      ]);
      const supersededCount = await pool.query(
        `SELECT count(*)::int AS n FROM chunks
         WHERE document_id = $1 AND valid_to IS NOT NULL`,
        ["k56-doc"]
      );
      assert.equal(supersededCount.rows[0]?.["n"], 2);
      const reactivated = await pool.query(
        "SELECT embedding::text AS embedding FROM chunks WHERE chunk_id = $1",
        ["k56-c1"]
      );
      assert.equal(
        reactivated.rows[0]?.["embedding"],
        unitVector384(0),
        "reactivated unchanged chunk must keep its embedding"
      );

      // --- Tombstone hides results; restore brings the current version back
      await pool.query(buildDocumentTombstone("k56-doc").text, ["k56-doc"]);
      await pool.query(buildChunkSupersede("k56-doc").text, ["k56-doc"]);
      const hidden = await pool.query(
        `SELECT count(*)::int AS n FROM chunks
         WHERE namespace = $1 AND valid_to IS NULL`,
        [NAMESPACE]
      );
      assert.equal(
        hidden.rows[0]?.["n"],
        0,
        "a tombstoned document must be invisible to live-chunk retrieval"
      );
      await pool.query(buildDocumentRestore("k56-doc").text, ["k56-doc"]);
      await pool.query(buildChunkReactivateCurrent("k56-doc").text, [
        "k56-doc",
      ]);
      const restored = await pool.query(
        `SELECT c.chunk_id, v.version FROM chunks c
         JOIN document_version v ON v.id = c.version_id
         WHERE c.document_id = $1 AND c.valid_to IS NULL`,
        ["k56-doc"]
      );
      assert.deepEqual(
        restored.rows.map((row) => row["chunk_id"]),
        ["k56-c1", "k56-c4"],
        "restore must bring back exactly the current version's chunks"
      );

      // ADR-002 D8: no result without a citation.
      const citations = await pool.query(
        `SELECT c.chunk_id, d.source, d.title, d.url
         FROM chunks c JOIN document d ON d.id = c.document_id
         WHERE c.document_id = $1
           AND c.valid_to IS NULL AND d.deleted_at IS NULL
         ORDER BY c.chunk_id`,
        ["k56-doc"]
      );
      assert.deepEqual(citations.rows, [
        { chunk_id: "k56-c1", source: "file", title: "K56 doc", url: null },
        { chunk_id: "k56-c4", source: "file", title: "K56 doc", url: null },
      ]);

      // --- Hard delete cascades (the GC path) -----------------------------
      await pool.query("DELETE FROM document WHERE id = $1", ["k56-doc"]);
      const afterDelete = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM chunks WHERE document_id = 'k56-doc') AS chunks,
           (SELECT count(*)::int FROM document_version WHERE document_id = 'k56-doc') AS versions`
      );
      assert.deepEqual(afterDelete.rows[0], { chunks: 0, versions: 0 });

      await pool.query(`DROP SCHEMA ${SCRATCH_SCHEMA} CASCADE`);
    } finally {
      await pool.end();
    }
  }
);

test(
  "integration: adopting a pre-ledger database re-tags its fake vectors",
  { skip: !hasLiveDb },
  async () => {
    const schema = "knowledge_retag_test";
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env["DATABASE_URL"],
      options: `-c search_path=${schema},public`,
    });
    try {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
      await pool.query(
        "CREATE EXTENSION IF NOT EXISTS pg_textsearch SCHEMA public"
      );
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.query(`CREATE SCHEMA ${schema}`);
      // The tables as they stood before the ledger, with rows the fake
      // provider wrote under the real model's name.
      await pool.query(KNOWLEDGE_MIGRATIONS[0]?.sql ?? "");
      await pool.query(
        "INSERT INTO knowledge_namespace (name) VALUES ('retag')"
      );
      await pool.query(
        `INSERT INTO document (id, namespace, source, external_id, content_hash)
         VALUES ('d1', 'retag', 'git', 'a.md', $1)`,
        [sha256("a")]
      );
      await pool.query(
        `INSERT INTO document_version (id, document_id, version, content_hash)
         VALUES ('d1-v1', 'd1', 1, $1)`,
        [sha256("a")]
      );
      const insertChunk = `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text, content_hash, chunker_version, embedding, embedding_model)
VALUES ($1, 'd1', 'd1-v1', 'retag', $1, $2, 'v1', $3::vector, $4)`;
      await pool.query(insertChunk, [
        "c-real-tag",
        sha256("c1"),
        unitVector384(0),
        "BAAI/bge-small-en-v1.5",
      ]);
      await pool.query(insertChunk, ["c-unembedded", sha256("c2"), null, null]);

      assert.deepEqual(
        await migrateKnowledgeSchema(pool),
        KNOWLEDGE_MIGRATIONS.map((migration) => migration.id)
      );
      const { rows } = await pool.query(
        "SELECT chunk_id, embedding_model FROM chunks ORDER BY chunk_id"
      );
      assert.deepEqual(rows, [
        { chunk_id: "c-real-tag", embedding_model: "fake/384" },
        { chunk_id: "c-unembedded", embedding_model: null },
      ]);
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }
);
