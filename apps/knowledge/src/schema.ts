/**
 * Durable knowledge schema (ADR-002 D3/D10) and the only place DDL lives.
 *
 * `document` holds the stable `(namespace, source, external_id)` identity and
 * current-version pointer; `document_version` is append-only history; `chunks`
 * is the single retrieval table both channels rank, content-addressed on
 * `(document_id, content_hash)` so unchanged text keeps its embedding.
 *
 * Deletion is two-clock: a tombstone sets `deleted_at` and supersedes live
 * chunks, which the channels' `valid_to IS NULL` predicate hides at once;
 * hard delete is a separate GC job.
 *
 * Ids are opaque TEXT rather than ADR-002's uuid, since every consumer treats
 * them as strings.
 *
 * knowledge-ingest applies migrations at boot under an advisory lock.
 * Retrieval never issues DDL: it reads the applied version and refuses to
 * serve until it reaches `KNOWLEDGE_SCHEMA_VERSION`.
 */

import type { PgClient, PgPool } from "./pg-client.ts";
import { withTransaction } from "./pg-client.ts";

export const KNOWLEDGE_NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;

/**
 * Retrieval corpus. The trailing `ADD COLUMN IF NOT EXISTS` statements
 * upgrade older `chunks` tables in place.
 */
const CORPUS_SQL = `CREATE EXTENSION IF NOT EXISTS vector;
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
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS idx INT NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunker_version TEXT NOT NULL DEFAULT '';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now();`;

/**
 * Ingest queue and its bookkeeping:
 * - `ingest_job`: claimed with `FOR UPDATE SKIP LOCKED` and leased via
 *   `heartbeat_at`; the UNIQUE `idempotency_key` makes duplicate event
 *   delivery collide instead of enqueueing twice.
 * - `ingest_source`: registered sources for the panel.
 * - `ingest_document`: published-version ledger. Not named `document`, which
 *   is the corpus table above.
 * - `git_source_manifest`: last synced commit and blob map per git source.
 */
const QUEUE_SQL = `CREATE TABLE IF NOT EXISTS ingest_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'document-version', 'source_sync')),
  idempotency_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'retryable', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  priority INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result JSONB,
  worker_id TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ingest_job_claimable
  ON ingest_job (priority DESC, enqueued_at ASC, id ASC)
  WHERE status IN ('pending', 'retryable');
CREATE INDEX IF NOT EXISTS ingest_job_source_recent
  ON ingest_job (source_id, enqueued_at DESC);

CREATE TABLE IF NOT EXISTS ingest_source (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'file', 'url', 'web')),
  namespace TEXT NOT NULL,
  repo TEXT,
  ref TEXT,
  url TEXT,
  path TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_document (
  document_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT,
  commit_ref TEXT,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  provenance JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace, source_id, external_id, version_id)
);
CREATE INDEX IF NOT EXISTS document_source
  ON ingest_document (source_id);

CREATE TABLE IF NOT EXISTS git_source_manifest (
  source_key TEXT PRIMARY KEY,
  commit_sha TEXT,
  entries JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/** Both channels index live chunks only (ADR-002 D7). */
const CHANNEL_SQL = `CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE INDEX IF NOT EXISTS chunks_text_bm25
  ON chunks USING bm25 (text)
  WITH (text_config = 'english')
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE valid_to IS NULL AND embedding IS NOT NULL;`;

export interface KnowledgeMigration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Applied in id order, each once. Append new migrations; never edit a shipped
 * one. Migration 1 is idempotent so it adopts databases created before the
 * ledger existed, and drops a claim index for a queue status nothing sets.
 */
export const KNOWLEDGE_MIGRATIONS: readonly KnowledgeMigration[] = [
  {
    id: 1,
    name: "knowledge-core",
    sql: `${CORPUS_SQL}
${QUEUE_SQL}
${CHANNEL_SQL}
DROP INDEX IF EXISTS ingest_job_claim;`,
  },
  {
    // The fake provider used to stamp the configured model name on its
    // vectors, and no deployment has configured a real provider, so every
    // stored vector is fake. The honest tag keeps the vector channel and a
    // future re-embed from trusting them.
    id: 2,
    name: "retag-fake-embeddings",
    sql: `UPDATE chunks SET embedding_model = 'fake/384'
WHERE embedding IS NOT NULL AND embedding_model NOT LIKE 'fake/%';`,
  },
  {
    // Finished jobs now drop their document text; this clears the backlog.
    id: 3,
    name: "drop-finished-job-content",
    sql: `UPDATE ingest_job SET payload = payload #- '{documentVersion,content}'
WHERE status IN ('succeeded', 'dead') AND payload ? 'documentVersion';`,
  },
];

/** The schema version this build needs; recorded in eval provenance. */
export const KNOWLEDGE_SCHEMA_VERSION = Math.max(
  ...KNOWLEDGE_MIGRATIONS.map((migration) => migration.id)
);

const MIGRATION_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS knowledge_schema_migration (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * Applies pending migrations in one transaction. The transaction-scoped
 * advisory lock serializes concurrent ingest replicas; a waiter then finds
 * the winner's ledger rows and applies nothing. Index builds and lock waits
 * may outlast the pool's statement timeout, so it is lifted here. Returns
 * the applied ids.
 */
export const migrateKnowledgeSchema = (pool: PgPool): Promise<number[]> =>
  withTransaction(pool, async (client) => {
    await client.query("SET LOCAL statement_timeout = 0", []);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowledge_schema_migration'))",
      []
    );
    await client.query(MIGRATION_LEDGER_SQL, []);
    const { rows } = await client.query(
      "SELECT id FROM knowledge_schema_migration",
      []
    );
    const applied = new Set(rows.map((row) => Number(row["id"])));
    const pending = KNOWLEDGE_MIGRATIONS.filter(
      (migration) => !applied.has(migration.id)
    ).toSorted((a, b) => a.id - b.id);
    for (const migration of pending) {
      await client.query(migration.sql, []);
      await client.query(
        "INSERT INTO knowledge_schema_migration (id, name) VALUES ($1, $2)",
        [migration.id, migration.name]
      );
    }
    return pending.map((migration) => migration.id);
  });

/** Highest applied migration id; 0 before ingest has migrated anything. */
export const readKnowledgeSchemaVersion = async (
  client: PgClient
): Promise<number> => {
  const ledger = await client.query(
    "SELECT to_regclass('knowledge_schema_migration') IS NOT NULL AS present",
    []
  );
  if (ledger.rows[0]?.["present"] !== true) {
    return 0;
  }
  const { rows } = await client.query(
    "SELECT COALESCE(max(id), 0) AS version FROM knowledge_schema_migration",
    []
  );
  return Number(rows[0]?.["version"] ?? 0);
};

export interface SchemaQuery {
  text: string;
  params: unknown[];
}

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

/** `document` and `chunks` reference the registry, so ingest registers first. */
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
  content_hash: string;
  title?: string | null;
  url?: string | null;
}

/**
 * A changed hash bumps the version and clears any tombstone. An unchanged
 * hash returns zero rows, which is the idempotency signal callers branch on.
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

/** UNIQUE (document_id, version) makes retries with fresh ids no-ops. */
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

/** Superseded chunks leave the channels' partial indexes, and BM25 stats, at once. */
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
  version_id: string;
  namespace: string;
  idx: number;
  text: string;
  content_hash: string;
  /** Strict parsing happens read-side. */
  anchors: unknown[];
  chunker_version: string;
}

/** `embedding` is deliberately absent from the SET list: unchanged text never re-embeds. */
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
    throw new TypeError("schema: anchors must be an array");
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

/** Pair with `buildChunkSupersede`: the channels filter on `valid_to` only. */
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

/** Reactivates the chunks of the document's current version after a restore. */
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
