/**
 * Durable knowledge schema (#56) — sources, documents, document versions,
 * chunks, and ingestion jobs, with the advanced index DDL from ADR-002
 * (D3 schema, D5 queue, D6 embeddings, D7 channels, D9 namespaces, D10
 * deletion/versioning).
 *
 * The module owns three things:
 *
 * 1. `KNOWLEDGE_MIGRATIONS` — numbered, idempotent-at-the-runner raw SQL
 *    migrations applied in lexicographic order. There is no ORM in this
 *    package; the advanced index DDL (partial HNSW, partial BM25, partial
 *    B-trees) is plain SQL exactly as the database executes it.
 * 2. `ensureKnowledgeSchema` — the runner. It records each applied migration
 *    (id + sha256 checksum) in `knowledge_schema_migrations`, applies pending
 *    migrations one transaction each, refuses drifted re-definitions, and
 *    skips extension-gated migrations when the extension is not available
 *    (they stay pending and apply on a cluster that ships it).
 * 3. `KNOWLEDGE_SCHEMA_VERSION` — the generation marker recorded in eval
 *    provenance (`eval/run-meta.ts`). Generation 1 was the pre-#56 ad-hoc
 *    `chunks` table ("1-pgvector-chunks" / "1-bm25-chunks"); generation 2 is
 *    this schema.
 *
 * Tables and the contracts they pin:
 *
 * - `documents` — one row per external/source identity forever. The stable
 *   identity is `UNIQUE (namespace, source, external_id)` (path, canonical
 *   URL, note slug — ADR-002 D3/D9); content changes bump `version` and are
 *   recorded in `document_versions`, never re-key identity. `deleted_at` is
 *   the tombstone (D10): NULL = live, set = hidden from retrieval while rows
 *   remain for GC on a separate clock.
 * - `document_versions` — one row per content version: the provenance record
 *   that explains which version produced any historical result (D3/D8/D10).
 *   `chunks.version_id` references it, so a citation resolves chunk ->
 *   version -> document -> source/url even after newer versions land.
 * - `chunks` — content-addressed per document: `UNIQUE (document_id,
 *   content_hash)` means re-ingesting unchanged content touches nothing and
 *   re-chunking a changed document carries identical chunk text forward
 *   without re-embedding (D3/D10). `anchors` is the citation-anchor JSONB
 *   array (offset start/end and/or heading value — the shape validated by
 *   `parseAnchors` in src/pgvector.ts), `idx` is the position for ordered
 *   context, and `valid_from`/`valid_to` window the chunk's liveness so
 *   superseded chunks drop out of retrieval before GC reclaims them.
 * - `ingest_jobs` — the durable ingestion queue (D5): claimed with
 *   `FOR UPDATE SKIP LOCKED` against the partial `ingest_jobs_claimable`
 *   index (priority DESC, FIFO within priority), heartbeat + attempts for
 *   crash-safe retry.
 *
 * Embedding model versioning (D6): `chunks.embedding` is pinned to
 * `vector(384)` (local `BAAI/bge-small-en-v1.5`) and `chunks.embedding_model`
 * records the producing generation; retrieval filters `embedding_model = $n`
 * so models never mix, and a model swap is a re-embed backfill plus a new
 * numbered migration, never an in-place rewrite.
 *
 * Namespace scoping (D9) is a plain `namespace` text column on documents and
 * chunks — the collection key both retrieval channels filter on — backed by
 * the partial `chunks_namespace_active` B-tree over live chunks (the index
 * src/bm25.ts and src/pgvector.ts address) and `documents_namespace_live`.
 *
 * Adopting this schema on a database that still holds the pre-#56 ad-hoc
 * `chunks` table: drop the legacy tables (`chunks`, and any ad-hoc state) and
 * re-run the migration — everything under them is re-ingestible by design,
 * which is the point of content-addressed chunks.
 */

import { createHash } from "node:crypto";

/**
 * Schema generation recorded in eval provenance. Bump only with a migration
 * that changes retrieval-visible schema semantics.
 */
export const KNOWLEDGE_SCHEMA_VERSION = "2-knowledge-schema";

/** Runner bookkeeping table: one row per applied migration. */
export const KNOWLEDGE_SCHEMA_TABLE = "knowledge_schema_migrations";

/** Extensions a migration may depend on (installed per CNPG Database spec). */
export type KnowledgeExtension = "pg_textsearch" | "vector";

export interface KnowledgeMigration {
  /** Lexicographic apply order; never rewrite an applied id's SQL. */
  id: string;
  /** One-line intent, mirrored into the migration record's review. */
  description: string;
  /**
   * When set, the migration applies only if this extension is available
   * (`pg_available_extensions`); otherwise it stays pending and is retried on
   * every run — a vanilla PostgreSQL 18 gets the core schema, the knowledge
   * CNPG cluster gets the full index set.
   */
  requiresExtension?: KnowledgeExtension;
  /** Raw SQL applied in one transaction and recorded with its checksum. */
  sql: string;
}

/**
 * The knowledge schema, in apply order. Migrations 0001–0004 are the core
 * (no extensions) and must apply on any PostgreSQL 18; 0005/0006 add the
 * retrieval channels' advanced indexes and are extension-gated.
 */
export const KNOWLEDGE_MIGRATIONS: readonly KnowledgeMigration[] = [
  {
    description:
      "documents: stable (namespace, source, external_id) identity; content version + tombstone columns",
    id: "0001-documents",
    sql: `CREATE TABLE documents (
  document_id  TEXT PRIMARY KEY,
  namespace    TEXT NOT NULL,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  title        TEXT,
  url          TEXT,
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  storage_path TEXT,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT documents_identity UNIQUE (namespace, source, external_id)
);
CREATE INDEX documents_namespace_live
  ON documents (namespace) WHERE deleted_at IS NULL;`,
  },
  {
    description:
      "document_versions: per-version provenance rows a citation can resolve to",
    id: "0002-document-versions",
    sql: `CREATE TABLE document_versions (
  version_id   TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
  version      INTEGER NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL,
  storage_path TEXT,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_identity UNIQUE (document_id, version)
);`,
  },
  {
    description:
      "chunks: content-addressed per document, version-scoped, citation anchors, live-windowed",
    id: "0003-chunks",
    sql: `CREATE TABLE chunks (
  chunk_id        TEXT PRIMARY KEY,
  document_id     TEXT NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE,
  version_id      TEXT NOT NULL REFERENCES document_versions (version_id) ON DELETE CASCADE,
  namespace       TEXT NOT NULL,
  idx             INTEGER NOT NULL CHECK (idx >= 0),
  text            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  anchors         JSONB NOT NULL DEFAULT '[]'::jsonb,
  chunker_version TEXT NOT NULL,
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chunks_content_identity UNIQUE (document_id, content_hash)
);
CREATE INDEX chunks_namespace_active
  ON chunks (namespace) WHERE valid_to IS NULL;`,
  },
  {
    description:
      "ingest_jobs: durable queue for FOR UPDATE SKIP LOCKED workers (ADR-002 D5)",
    id: "0004-ingest-jobs",
    sql: `CREATE TABLE ingest_jobs (
  job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error        TEXT,
  priority     INTEGER NOT NULL DEFAULT 0,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX ingest_jobs_claimable
  ON ingest_jobs (priority DESC, enqueued_at) WHERE status = 'pending';`,
  },
  {
    description:
      "pgvector channel: embedding columns (model-versioned, 384-d) + partial HNSW index",
    id: "0005-pgvector",
    requiresExtension: "vector",
    sql: `CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding vector(384),
  ADD COLUMN IF NOT EXISTS embedding_model TEXT;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE valid_to IS NULL AND embedding IS NOT NULL;`,
  },
  {
    description:
      "pg_textsearch channel: partial single-column BM25 index over live chunks",
    id: "0006-pg-textsearch",
    requiresExtension: "pg_textsearch",
    sql: `CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE INDEX IF NOT EXISTS chunks_text_bm25
  ON chunks USING bm25 (text)
  WITH (text_config = 'english')
  WHERE valid_to IS NULL;`,
  },
];

/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface KnowledgeSchemaClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SchemaApplyResult {
  /** Migration ids applied by this run, in order. */
  applied: string[];
  /**
   * Extension-gated migration ids left pending because the extension is not
   * available on this database. They are NOT recorded and retry next run.
   */
  skipped: string[];
  /** The schema generation now in place (`KNOWLEDGE_SCHEMA_VERSION`). */
  schemaVersion: string;
}

/** sha256 of a migration's SQL — the drift fingerprint stored per record. */
export const checksumMigration = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

const extensionAvailable = async (
  client: KnowledgeSchemaClient,
  extension: KnowledgeExtension
): Promise<boolean> => {
  const result = await client.query(
    "SELECT 1 FROM pg_available_extensions WHERE name = $1",
    [extension]
  );
  return result.rows.length > 0;
};

/**
 * Bring the database to the current knowledge schema. Idempotent: already
 * recorded migrations are checksum-verified and skipped, so re-running
 * against a fully migrated cluster issues only the bookkeeping table's
 * `CREATE TABLE IF NOT EXISTS` plus one `SELECT`. Each pending migration
 * applies inside its own transaction together with its record row, so a
 * failure mid-migration rolls back atomically and retries cleanly.
 */
export const ensureKnowledgeSchema = async (
  client: KnowledgeSchemaClient
): Promise<SchemaApplyResult> => {
  await client.query(
    `CREATE TABLE IF NOT EXISTS "${KNOWLEDGE_SCHEMA_TABLE}" (
  migration_id TEXT PRIMARY KEY,
  checksum     TEXT NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
    []
  );
  const existing = await client.query(
    `SELECT migration_id, checksum FROM "${KNOWLEDGE_SCHEMA_TABLE}"`,
    []
  );
  const recorded = new Map<string, string>();
  for (const row of existing.rows) {
    const { checksum, migration_id: id } = row;
    if (typeof id === "string" && typeof checksum === "string") {
      recorded.set(id, checksum);
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of KNOWLEDGE_MIGRATIONS) {
    const knownChecksum = recorded.get(migration.id);
    if (knownChecksum !== undefined) {
      const currentChecksum = checksumMigration(migration.sql);
      if (knownChecksum !== currentChecksum) {
        throw new Error(
          `knowledge-schema: migration ${migration.id} drifted (recorded ${knownChecksum.slice(0, 12)}, current ${currentChecksum.slice(0, 12)}); never edit an applied migration — add a new numbered one`
        );
      }
      continue;
    }
    if (
      migration.requiresExtension !== undefined &&
      !(await extensionAvailable(client, migration.requiresExtension))
    ) {
      skipped.push(migration.id);
      continue;
    }
    await client.query("BEGIN", []);
    try {
      await client.query(migration.sql, []);
      await client.query(
        `INSERT INTO "${KNOWLEDGE_SCHEMA_TABLE}" (migration_id, checksum) VALUES ($1, $2)`,
        [migration.id, checksumMigration(migration.sql)]
      );
      await client.query("COMMIT", []);
    } catch (error) {
      try {
        await client.query("ROLLBACK", []);
      } catch {
        // The original failure is the one worth surfacing.
      }
      throw error;
    }
    applied.push(migration.id);
  }
  return { applied, schemaVersion: KNOWLEDGE_SCHEMA_VERSION, skipped };
};
