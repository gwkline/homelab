/**
 * Durable knowledge schema (ADR-002 D3/D10).
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
 */

import type { PgClient } from "./pg-client.ts";

/** Recorded in eval provenance; bump when a migration changes what retrieval sees. */
export const KNOWLEDGE_SCHEMA_VERSION = "1-knowledge-core";

export const KNOWLEDGE_NAMESPACE_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;

/**
 * Idempotent base migration; the channel migrations compose it and add their
 * own indexes. The trailing `ADD COLUMN IF NOT EXISTS` statements upgrade
 * older `chunks` tables in place.
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

export interface SchemaQuery {
  text: string;
  params: unknown[];
}

export const ensureKnowledgeSchema = async (
  client: PgClient
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

/** SKIP LOCKED keeps concurrent workers off the same row; priority, then FIFO. */
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
