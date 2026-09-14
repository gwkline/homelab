/**
 * Durable knowledge schema (#56, ADR-002 D3/D5/D8/D9/D10).
 *
 * This is the deliverable-one migration: the tables that make ingestion
 * idempotent, versioned, tombstone-able, and citable, plus the advanced
 * indexes the retrieval channels rely on. The retrieval table is `chunks`
 * (named by the landed #60/#62 channel modules) — everything else is singular
 * per ADR-002.
 *
 * Model:
 *
 * - `knowledge_namespace` — the collection registry (ADR-002 D9). Retrieval
 *   still scopes by the denormalized `namespace` text column on document and
 *   chunks; this table makes the collection key a first-class, DB-validated
 *   identity without per-namespace tables. `document` and `chunks` FK to it,
 *   so an unregistered or malformed namespace cannot ingest.
 * - `document` — stable external/source identity: one row per
 *   `(namespace, source, external_id)` (file path, canonical URL, note slug),
 *   never rewritten by content changes. Holds the CURRENT version pointer
 *   (`version`, `content_hash`) plus the `deleted_at` tombstone.
 * - `document_version` — content versions. Every ingest of changed content
 *   appends a row; history is never mutated, so any result can be explained
 *   by the version that produced it (`chunks.version_id` → `document_version`).
 * - `chunks` — the shared single-table retrieval store (both channels rank
 *   it). Chunk identity is content-addressed: UNIQUE (document_id,
 *   content_hash), copied from Probe via ADR-002 D3 — re-ingesting unchanged
 *   chunk text touches nothing, and its embedding survives without re-embed.
 *   Citation anchors (`anchors` JSONB: offset start/end or heading value),
 *   `idx`, `version_id`, and the `valid_from`/`valid_to` window are the
 *   provenance join resolved at query time — no separate provenance table in
 *   phase one.
 * - `ingest_job` — the durable ingestion queue (ADR-002 D5), claimed with
 *   FOR UPDATE SKIP LOCKED.
 *
 * Deletion is two-clock (D10): `tombstoneDocument` sets `document.deleted_at`
 * and supersedes the document's live chunks, so both channels' existing
 * `valid_to IS NULL` predicate hides them immediately without a document
 * join. Hard delete (rows + raw objects) is a GC job on a separate clock,
 * backed by `ON DELETE CASCADE` and the `document_tombstoned` index.
 *
 * Ids are opaque caller-assigned TEXT (uuid strings are the intended values;
 * `gen_random_uuid()` is the default). This deviates from ADR-002 D3's uuid
 * PKs deliberately: every landed consumer — the channel modules, the
 * knowledge-retrieval contract, and the eval fixtures — treats ids as
 * strings, and TEXT keys keep the same guarantees.
 *
 * The migration is idempotent and targets an EMPTY PostgreSQL 18 database
 * (the acceptance contract). Databases holding the pre-#56 stopgap `chunks`
 * table get the missing columns via `ADD COLUMN IF NOT EXISTS`, but NOT NULL
 * defaults there (`''`) are migration artifacts and the FK/UNIQUE constraints
 * below only exist on tables created fresh by this script — pre-#56 dev
 * databases should be recreated rather than trusted.
 */

/**
 * Schema/migration version recorded in eval provenance (`eval/run-meta.ts`).
 * Bump whenever a migration changes what retrieval runs against.
 */
export const KNOWLEDGE_SCHEMA_VERSION = "1-knowledge-core";

/** Collection-key pattern, identical to the channel modules' validation. */
export const KNOWLEDGE_NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;

/**
 * The base migration: extensions the core schema needs (pgvector for the
 * `vector(384)` embedding column; pg_textsearch stays in the BM25 channel's
 * migration), the five tables, and the core indexes. Channel migrations
 * (src/pgvector.ts, src/bm25.ts) compose this and add their channel indexes,
 * so every "advanced index" is represented in migration SQL.
 */
export const KNOWLEDGE_SCHEMA_MIGRATION_SQL = `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS knowledge_namespace (
  name TEXT PRIMARY KEY
    CHECK (name ~ '^[A-Za-z0-9_.-]{1,128}$'),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  namespace TEXT NOT NULL REFERENCES knowledge_namespace(name),
  source TEXT NOT NULL CHECK (length(source) > 0),
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  title TEXT,
  url TEXT,
  version INT NOT NULL DEFAULT 1 CHECK (version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, source, external_id)
);
CREATE TABLE IF NOT EXISTS document_version (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL REFERENCES knowledge_namespace(name),
  idx INT NOT NULL DEFAULT 0 CHECK (idx >= 0),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '' CHECK (length(content_hash) > 0),
  anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(384),
  embedding_model TEXT,
  chunker_version TEXT NOT NULL DEFAULT '' CHECK (length(chunker_version) > 0),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_hash)
);
CREATE INDEX IF NOT EXISTS chunks_namespace_active
  ON chunks (namespace) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS document_tombstoned
  ON document (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS ingest_job (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error TEXT,
  priority INT NOT NULL DEFAULT 0,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ingest_job_claim
  ON ingest_job (priority DESC, enqueued_at) WHERE status = 'queued';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS idx INT NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunker_version TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now();`;

/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface SchemaDbClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Parameterized statement text plus bind params for `client.query`. */
export interface SchemaQuery {
  text: string;
  params: unknown[];
}

/** Run the idempotent base migration on `client` (channels add their indexes). */
export const ensureKnowledgeSchema = async (
  client: SchemaDbClient
): Promise<void> => {
  await client.query(KNOWLEDGE_SCHEMA_MIGRATION_SQL, []);
};

const validatedId = (value: string, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`schema: invalid ${label}`);
  }
  return value;
};

const validatedNamespace = (namespace: string): string => {
  if (!KNOWLEDGE_NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`schema: invalid namespace ${JSON.stringify(namespace)}`);
  }
  return namespace;
};

const validatedText = (value: string, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`schema: invalid ${label}`);
  }
  return value;
};

/** sha256 hex digests are the content-hash contract (ADR-002 D3). */
const validatedHash = (value: string, label: string): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`schema: ${label} must be a sha256 hex digest`);
  }
  return value;
};

const validatedIndex = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`schema: ${label} must be an integer >= 0`);
  }
  return value;
};

/**
 * Register a collection key (idempotent). `document`/`chunks` FK the
 * registry, so ingestion always pairs this with its first document.
 */
export const buildNamespaceRegistration = (
  namespace: string,
  description: string | null = null
): SchemaQuery => {
  const name = validatedNamespace(namespace);
  if (description !== null && typeof description !== "string") {
    throw new Error("schema: description must be a string or null");
  }
  return {
    params: [name, description],
    text: `INSERT INTO knowledge_namespace (name, description)
VALUES ($1, $2)
ON CONFLICT (name) DO NOTHING`,
  };
};

export interface DocumentUpsertInput {
  id: string;
  namespace: string;
  source: string;
  external_id: string;
  /** sha256 of the extracted text for the version being ingested. */
  content_hash: string;
  title?: string | null;
  url?: string | null;
}

/**
 * The ingest entry point (ADR-002 D10). Identity is
 * `(namespace, source, external_id)` — stable across content changes — and
 * the content hash decides everything:
 *
 * - No row → version 1 inserted.
 * - Row with a DIFFERENT hash → version bumped (`version = document.version
 *   + 1`), and a tombstone is cleared: changed content resurrects the
 *   document.
 * - Row with the SAME hash → the DO UPDATE WHERE guard filters the update,
 *   zero rows return, and nothing else in the database is touched. This is
 *   the idempotency signal callers branch on.
 */
export const buildDocumentUpsert = (doc: DocumentUpsertInput): SchemaQuery => {
  const id = validatedId(doc.id, "document id");
  const namespace = validatedNamespace(doc.namespace);
  const source = validatedText(doc.source, "source");
  const externalId = validatedText(doc.external_id, "external_id");
  const contentHash = validatedHash(doc.content_hash, "document content_hash");
  const title = doc.title ?? null;
  const url = doc.url ?? null;
  if (title !== null && typeof title !== "string") {
    throw new Error("schema: title must be a string or null");
  }
  if (url !== null && typeof url !== "string") {
    throw new Error("schema: url must be a string or null");
  }
  return {
    params: [id, namespace, source, externalId, title, url, contentHash],
    text: `INSERT INTO document
  (id, namespace, source, external_id, title, url, version, content_hash)
VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
ON CONFLICT (namespace, source, external_id) DO UPDATE SET
  version = document.version + 1,
  content_hash = EXCLUDED.content_hash,
  title = EXCLUDED.title,
  url = EXCLUDED.url,
  deleted_at = NULL,
  updated_at = now()
WHERE document.content_hash IS DISTINCT FROM EXCLUDED.content_hash
RETURNING id, version`,
  };
};

export interface DocumentVersionInput {
  id: string;
  document_id: string;
  version: number;
  content_hash: string;
}

/**
 * Append one content version (ADR-002 D10: history is append-only).
 * UNIQUE (document_id, version) makes retries with fresh ids no-ops instead
 * of duplicate history rows.
 */
export const buildDocumentVersionInsert = (
  version: DocumentVersionInput
): SchemaQuery => {
  const id = validatedId(version.id, "document version id");
  const documentId = validatedId(version.document_id, "document id");
  const versionNumber = validatedIndex(version.version, "version");
  if (versionNumber < 1) {
    throw new Error("schema: version must be an integer >= 1");
  }
  const contentHash = validatedHash(
    version.content_hash,
    "document_version content_hash"
  );
  return {
    params: [id, documentId, versionNumber, contentHash],
    text: `INSERT INTO document_version (id, document_id, version, content_hash)
VALUES ($1, $2, $3, $4)
ON CONFLICT (document_id, version) DO NOTHING
RETURNING id`,
  };
};

/**
 * Supersede every live chunk of a document (`valid_to = now()`): the step
 * that runs before re-chunking on content change, and the second half of a
 * tombstone. Live chunks are exactly what the retrieval channels' partial
 * indexes cover, so superseded chunks leave the searchable corpus (and its
 * BM25 statistics) immediately.
 */
export const buildChunkSupersede = (documentId: string): SchemaQuery => {
  const id = validatedId(documentId, "document id");
  return {
    params: [id],
    text: `UPDATE chunks
SET valid_to = now()
WHERE document_id = $1 AND valid_to IS NULL
RETURNING chunk_id`,
  };
};

export interface ChunkUpsertInput {
  chunk_id: string;
  document_id: string;
  /** document_version.id this chunk was produced by (citation provenance). */
  version_id: string;
  namespace: string;
  idx: number;
  text: string;
  /** sha256 of the chunk text. */
  content_hash: string;
  /** Citation anchors (offset spans or headings); strict parsing is read-side. */
  anchors: unknown[];
  chunker_version: string;
}

/**
 * Content-addressed chunk upsert (ADR-002 D3/D10): UNIQUE (document_id,
 * content_hash) means identical chunk text maps to the existing row, which is
 * reactivated (`valid_to = NULL`) and re-pointed at the current version —
 * while `embedding` is deliberately absent from the SET list, so unchanged
 * text never re-embeds. Chunks absent from the new version stay superseded.
 */
export const buildChunkUpsert = (chunk: ChunkUpsertInput): SchemaQuery => {
  const chunkId = validatedId(chunk.chunk_id, "chunk id");
  const documentId = validatedId(chunk.document_id, "document id");
  const versionId = validatedId(chunk.version_id, "version id");
  const namespace = validatedNamespace(chunk.namespace);
  const idx = validatedIndex(chunk.idx, "chunk idx");
  const text = validatedText(chunk.text, "chunk text");
  const contentHash = validatedHash(chunk.content_hash, "chunk content_hash");
  const chunkerVersion = validatedText(
    chunk.chunker_version,
    "chunker_version"
  );
  if (!Array.isArray(chunk.anchors)) {
    throw new Error("schema: anchors must be an array");
  }
  return {
    params: [
      chunkId,
      documentId,
      versionId,
      namespace,
      idx,
      text,
      contentHash,
      JSON.stringify(chunk.anchors),
      chunkerVersion,
    ],
    text: `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, idx, text, content_hash, anchors, chunker_version)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
ON CONFLICT (document_id, content_hash) DO UPDATE SET
  version_id = EXCLUDED.version_id,
  namespace = EXCLUDED.namespace,
  idx = EXCLUDED.idx,
  text = EXCLUDED.text,
  anchors = EXCLUDED.anchors,
  chunker_version = EXCLUDED.chunker_version,
  valid_from = now(),
  valid_to = NULL
RETURNING chunk_id`,
  };
};

/**
 * Tombstone a document (ADR-002 D10): `deleted_at` is the durable delete
 * marker (GC scans it via `document_tombstoned`), while the paired
 * `buildChunkSupersede` call is what hides the chunks from the retrieval
 * channels, which predicate on `valid_to IS NULL` only.
 */
export const buildDocumentTombstone = (documentId: string): SchemaQuery => {
  const id = validatedId(documentId, "document id");
  return {
    params: [id],
    text: `UPDATE document
SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
WHERE id = $1
RETURNING id, deleted_at`,
  };
};

/** Clear a tombstone; pair with `buildChunkReactivateCurrent` to serve again. */
export const buildDocumentRestore = (documentId: string): SchemaQuery => {
  const id = validatedId(documentId, "document id");
  return {
    params: [id],
    text: `UPDATE document
SET deleted_at = NULL, updated_at = now()
WHERE id = $1
RETURNING id`,
  };
};

/**
 * Reactivate the chunks of a document's CURRENT version (the one
 * `document.version` names via document_version). Used after restore; after a
 * plain content change the chunk upserts reactivate what they re-insert.
 */
export const buildChunkReactivateCurrent = (
  documentId: string
): SchemaQuery => {
  const id = validatedId(documentId, "document id");
  return {
    params: [id],
    text: `UPDATE chunks c
SET valid_to = NULL, valid_from = now()
FROM document d, document_version v
WHERE d.id = $1
  AND v.document_id = d.id
  AND v.version = d.version
  AND c.document_id = d.id
  AND c.version_id = v.id
  AND c.valid_to IS NOT NULL
RETURNING c.chunk_id`,
  };
};

/**
 * Claim the next queued ingest job with FOR UPDATE SKIP LOCKED (ADR-002 D5):
 * concurrent workers never take the same row, and the claim (status, start
 * time, attempt count) is one atomic statement. Highest priority first,
 * then FIFO; equal `enqueued_at` ties break on id for determinism. Run it
 * inside the worker's transaction so the row lock spans the drain.
 */
export const buildIngestJobClaim = (): SchemaQuery => ({
  params: [],
  text: `UPDATE ingest_job
SET status = 'running', started_at = now(), heartbeat_at = now(), attempts = attempts + 1
WHERE id = (
  SELECT id FROM ingest_job
  WHERE status = 'queued'
  ORDER BY priority DESC, enqueued_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, payload, attempts`,
});