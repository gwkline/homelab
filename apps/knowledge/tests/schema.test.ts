import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  buildChunkReactivateCurrent,
  buildChunkSupersede,
  buildChunkUpsert,
  buildDocumentRestore,
  buildDocumentTombstone,
  buildDocumentUpsert,
  buildDocumentVersionInsert,
  buildIngestJobClaim,
  buildNamespaceRegistration,
  ensureKnowledgeSchema,
  KNOWLEDGE_NAMESPACE_PATTERN,
  KNOWLEDGE_SCHEMA_MIGRATION_SQL,
  KNOWLEDGE_SCHEMA_VERSION,
} from "../src/schema.ts";
import type { ChunkUpsertInput, SchemaDbClient } from "../src/schema.ts";
import { ensurePgvectorSchema, parseAnchors } from "../src/pgvector.ts";
import { ensureBm25Schema } from "../src/bm25.ts";

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

// --- Migration DDL shape -------------------------------------------------

test("migration defines the full document/version/chunk/provenance model", () => {
  const sql = KNOWLEDGE_SCHEMA_MIGRATION_SQL;
  // All five tables of the #56 model (ADR-002 D3/D5/D9).
  for (const table of [
    "knowledge_namespace",
    "document",
    "document_version",
    "chunks",
    "ingest_job",
  ]) {
    assert.ok(
      sql.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `missing table ${table}`
    );
  }
  // Stable external/source identity is separate from content versions:
  // identity key on document, append-only versions with their own hashes.
  assert.ok(
    sql.includes("UNIQUE (namespace, source, external_id)"),
    "document identity must be (namespace, source, external_id)"
  );
  assert.ok(
    sql.includes("UNIQUE (document_id, version)"),
    "document_version must be unique per (document, version)"
  );
  // Content-addressed chunks: re-ingesting unchanged text is a DB-level no-op.
  assert.ok(
    sql.includes("UNIQUE (document_id, content_hash)"),
    "chunks must be content-addressed by (document_id, content_hash)"
  );
  // Provenance chain: chunk → version → document, cascading for GC.
  for (const fk of [
    "document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE",
    "version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE",
  ]) {
    assert.ok(sql.includes(fk), `missing FK ${fk}`);
  }
  // Namespace scoping is a real, validated collection key.
  assert.ok(
    sql.includes("REFERENCES knowledge_namespace(name)"),
    "document and chunks must scope to the namespace registry"
  );
  // Chunks carry citation anchors (source offsets / headings) and ordered idx.
  assert.ok(sql.includes("anchors JSONB NOT NULL DEFAULT '[]'::jsonb"));
  assert.ok(sql.includes("idx INT NOT NULL DEFAULT 0"));
  // Validity windows for supersession + tombstone clock.
  assert.ok(
    sql.includes("valid_from TIMESTAMPTZ NOT NULL DEFAULT now()") &&
      sql.includes("valid_to TIMESTAMPTZ")
  );
  // pgvector dimension pinned (ADR-002 D6); model generation tagged.
  assert.ok(sql.includes("embedding vector(384)"));
  assert.ok(sql.includes("embedding_model TEXT"));
  // Ingestion queue (ADR-002 D5) with claimable state.
  assert.ok(
    sql.includes("status TEXT NOT NULL DEFAULT 'queued'") &&
      sql.includes("attempts INT NOT NULL DEFAULT 0") &&
      sql.includes("heartbeat_at") &&
      sql.includes("priority INT NOT NULL DEFAULT 0")
  );
});

test("migration DDL carries the advanced indexes", () => {
  const sql = KNOWLEDGE_SCHEMA_MIGRATION_SQL;
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
  assert.ok(
    sql.includes(
      "CREATE INDEX IF NOT EXISTS ingest_job_claim\n  ON ingest_job (priority DESC, enqueued_at) WHERE status = 'queued'"
    ),
    "the queue must have a claim-supporting partial index"
  );
});

test("migration upgrades pre-#56 chunk tables and is idempotent by construction", () => {
  const sql = KNOWLEDGE_SCHEMA_MIGRATION_SQL;
  for (const column of ["idx", "content_hash", "chunker_version", "valid_from"]) {
    assert.ok(
      sql.includes(`ADD COLUMN IF NOT EXISTS ${column}`),
      `stopgap upgrade path missing for ${column}`
    );
  }
  // Every DDL statement must be re-runnable: IF NOT EXISTS everywhere.
  for (const statement of sql
    .split("\n")
    .filter((line) => line.startsWith("CREATE "))) {
    assert.ok(
      statement.includes("IF NOT EXISTS"),
      `non-idempotent DDL: ${statement}`
    );
  }
});

test("ensureKnowledgeSchema runs the base migration as one script", async () => {
  const seen: { text?: string; params?: unknown[] } = {};
  const client: SchemaDbClient = {
    query: (text, params) => {
      seen.text = text;
      seen.params = params;
      return Promise.resolve({ rows: [] });
    },
  };
  await ensureKnowledgeSchema(client);
  assert.equal(seen.text, KNOWLEDGE_SCHEMA_MIGRATION_SQL);
  assert.deepEqual(seen.params, []);
  assert.ok(
    KNOWLEDGE_SCHEMA_MIGRATION_SQL.includes(
      "CREATE EXTENSION IF NOT EXISTS vector"
    ),
    "the embedding column requires the vector extension"
  );
});

test("channel migrations compose the core schema", () => {
  assert.ok(
    ensurePgvectorSchema !== undefined && ensureBm25Schema !== undefined
  );
});

// --- Builder contracts ----------------------------------------------------

test("namespace registration binds an idempotent upsert", () => {
  const built = buildNamespaceRegistration("homelab-docs", "primary corpus");
  assert.deepEqual(built.params, ["homelab-docs", "primary corpus"]);
  assert.ok(built.text.includes("ON CONFLICT (name) DO NOTHING"));
  assert.throws(() => buildNamespaceRegistration("bad namespace!"), /invalid namespace/u);
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
  assert.throws(() => buildDocumentUpsert({ ...valid, id: "" }), /invalid document id/u);
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
  assert.ok(built.text.includes("ON CONFLICT (document_id, version) DO NOTHING"));
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
    anchors: [{ type: "offset", start: 0, end: 9 }],
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
    JSON.stringify([{ type: "offset", start: 0, end: 9 }]),
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

test("ingest job claim takes one queued job atomically", () => {
  const built = buildIngestJobClaim();
  assert.deepEqual(built.params, []);
  assert.ok(
    built.text.includes("FOR UPDATE SKIP LOCKED"),
    "concurrent workers must never claim the same job"
  );
  assert.ok(built.text.includes("WHERE status = 'queued'"));
  assert.ok(
    built.text.includes("attempts = attempts + 1") &&
      built.text.includes("status = 'running'"),
    "a claim must record the attempt"
  );
  assert.ok(
    built.text.includes("ORDER BY priority DESC, enqueued_at ASC, id ASC"),
    "claims must be deterministic (priority, then FIFO)"
  );
  assert.ok(built.text.includes("RETURNING id, kind, payload, attempts"));
});

// --- Integration: migrate from empty PostgreSQL 18 and exercise invariants

const hasLiveDb = Boolean(process.env["DATABASE_URL"]);
const SCRATCH_SCHEMA = "knowledge_schema_test_56";
const NAMESPACE = "k56-test";

/** 384-d unit vector literal (pgvector text format) for typmod/index tests. */
const unitVector384 = (index: number): string =>
  `[${Array.from({ length: 384 }, (_, i) => (i === index ? 1 : 0)).join(",")}]`;

const catalogConstraints = async (
  client: SchemaDbClient
): Promise<string[]> => {
  const result = await client.query(
    `SELECT conname FROM pg_constraint c
     JOIN pg_class rel ON c.conrelid = rel.oid
     JOIN pg_namespace n ON rel.relnamespace = n.oid
     WHERE n.nspname = $1`,
    [SCRATCH_SCHEMA]
  );
  return result.rows.map((row) => String(row["conname"]));
};

const catalogIndexes = async (client: SchemaDbClient): Promise<string[]> => {
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
      // Extensions are pre-installed on the knowledge CNPG cluster
      // (deploy/postgres/base/databases.yaml). SCHEMA public keeps a first
      // install out of the scratch schema so cleanup can never drop it.
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public");
      await pool.query(
        "CREATE EXTENSION IF NOT EXISTS pg_textsearch SCHEMA public"
      );

      // --- From-empty migration ------------------------------------------
      await pool.query(`DROP SCHEMA IF EXISTS ${SCRATCH_SCHEMA} CASCADE`);
      await pool.query(`CREATE SCHEMA ${SCRATCH_SCHEMA}`);
      await ensureKnowledgeSchema(pool);

      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [SCRATCH_SCHEMA]
      );
      assert.deepEqual(
        tables.rows.map((row) => String(row["table_name"])),
        ["chunks", "document", "document_version", "ingest_job", "knowledge_namespace"],
        "migration from empty must create the full #56 model"
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
        "ingest_job_claim",
      ]) {
        assert.ok(indexes.includes(index), `missing index ${index}`);
      }

      // Channel migrations compose the core schema; re-running everything is
      // a no-op and adds only the channel indexes.
      await ensurePgvectorSchema(pool);
      await ensureBm25Schema(pool);
      const indexesAfterChannels = await catalogIndexes(pool);
      for (const index of ["chunks_embedding_hnsw", "chunks_text_bm25"]) {
        assert.ok(
          indexesAfterChannels.includes(index),
          `channel index ${index} missing`
        );
      }
      const bm25Def = await pool.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = $1 AND indexname = 'chunks_text_bm25'`,
        [SCRATCH_SCHEMA]
      );
      const definition = String(bm25Def.rows[0]?.["indexdef"] ?? "");
      assert.match(definition, /USING bm25/u);
      assert.match(definition, /text_config = 'english'/u);
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

      // Citation anchors round-trip through the strict read-side parser.
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
      assert.equal(noop.rows.length, 0, "unchanged content must return no rows");
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

      // Same content-hash chunk upserts reuse the row; embeddings survive
      // without a re-embed (ADR-002 D10).
      await pool.query(
        `UPDATE chunks SET embedding = $1::vector, embedding_model = 'k56-test-model'
         WHERE chunk_id = 'k56-c1'`,
        [unitVector384(0)]
      );
      const reUpsert = buildChunkUpsert(chunksV1[0]!);
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

      // New version carries one unchanged chunk (reactivated, same content
      // hash) and one new chunk; the dropped chunk stays superseded.
      const reactivatedUpsert = buildChunkUpsert({
        ...chunksV1[0]!,
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
      await pool.query(buildChunkReactivateCurrent("k56-doc").text, ["k56-doc"]);
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

      // --- Hard delete cascades (the GC path) -----------------------------
      await pool.query("DELETE FROM document WHERE id = $1", ["k56-doc"]);
      const afterDelete = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM chunks WHERE document_id = 'k56-doc') AS chunks,
           (SELECT count(*)::int FROM document_version WHERE document_id = 'k56-doc') AS versions`
      );
      assert.deepEqual(afterDelete.rows[0], { chunks: 0, versions: 0 });

      // --- Ingestion queue claim (FOR UPDATE SKIP LOCKED) ------------------
      await pool.query(
        `INSERT INTO ingest_job (id, kind, payload, priority)
         VALUES ('k56-job-low', 'ingest', $1::jsonb, 0)`,
        [JSON.stringify({ document_id: "k56-doc" })]
      );
      await pool.query(
        `INSERT INTO ingest_job (id, kind, payload, priority)
         VALUES ('k56-job-high', 'ingest', $1::jsonb, 5)`,
        [JSON.stringify({ document_id: "k56-doc" })]
      );
      const claim = buildIngestJobClaim();
      const firstClaim = await pool.query(claim.text, claim.params);
      assert.equal(firstClaim.rows[0]?.["id"], "k56-job-high");
      assert.equal(firstClaim.rows[0]?.["attempts"], 1);
      const secondClaim = await pool.query(claim.text, claim.params);
      assert.equal(secondClaim.rows[0]?.["id"], "k56-job-low");
      const thirdClaim = await pool.query(claim.text, claim.params);
      assert.deepEqual(thirdClaim.rows, []);
      const jobStatus = await pool.query(
        "SELECT status FROM ingest_job WHERE id = $1",
        ["k56-job-high"]
      );
      assert.equal(jobStatus.rows[0]?.["status"], "running");

      await pool.query(`DROP SCHEMA ${SCRATCH_SCHEMA} CASCADE`);
    } finally {
      await pool.end();
    }
  }
);

test("schema version is recorded for eval provenance", () => {
  assert.match(KNOWLEDGE_SCHEMA_VERSION, /^\d+-/u);
});