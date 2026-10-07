/**
 * Pure queue core (ADR-002 D5): schema, SQL, idempotency keys, and backoff
 * math. No I/O; `PgIngestStore` executes it and `MemoryIngestStore` mirrors
 * the same state machine.
 *
 * Tables:
 * - `ingest_job`: the queue, claimed with `FOR UPDATE SKIP LOCKED` and leased
 *   via `heartbeat_at`. `document` jobs carry identity only and the worker
 *   fetches content; `document-version` jobs carry their own content.
 * - `ingest_source`: registered sources for the panel.
 * - `ingest_document`: published-version ledger. Its UNIQUE identity makes
 *   stale-claim re-runs land on the same row. Not named `document`, which is
 *   the retrieval corpus table in the same database.
 * - `git_source_manifest`: last synced commit and blob map per git source.
 */

import { createHash, randomUUID } from "node:crypto";

import type { IngestRequestInput, JobKind, JobState } from "./store.ts";

export const INGEST_SCHEMA_VERSION = "2-ingest-queue-pipeline";

export const INGEST_TABLE = "ingest_job";
export const SOURCE_TABLE = "ingest_source";
export const DOCUMENT_TABLE = "ingest_document";
export const MANIFEST_TABLE = "git_source_manifest";

export const JOB_STATES = [
  "pending",
  "running",
  "succeeded",
  "retryable",
  "dead",
] as const satisfies readonly JobState[];

export const JOB_KINDS = [
  "document",
  "document-version",
  "source_sync",
] as const satisfies readonly JobKind[];

export const SOURCE_KINDS = ["github", "file", "url", "web"] as const;

/** Claimable states: fresh work plus retries whose backoff elapsed. */
export const CLAIMABLE_STATES = ["pending", "retryable"] as const;

export const STALE_RECOVERY_MESSAGE =
  "claim lease expired; recovered for retry";

/**
 * Idempotent schema. The UNIQUE `idempotency_key` makes duplicate event
 * delivery collide instead of enqueueing twice; the partial index serves the
 * SKIP LOCKED scan.
 */
export const INGEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingest_job (
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
);
`;

/** New job ids are app-generated so every store produces the same shape. */
export const newJobId = (): string => `job_${randomUUID()}`;

const hashHex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Deterministic document id, so a version identity maps to one row in every store. */
export const documentIdFor = (
  namespace: string,
  sourceId: string,
  externalId: string,
  versionId: string
): string =>
  `doc_${hashHex(
    `document|${namespace}|${sourceId}|${externalId}|${versionId}`
  ).slice(0, 40)}`;

/**
 * Default idempotency key over (source, namespace, externalId, versionId,
 * contentHash): redelivery collides, any version or content change is new.
 */
export const deriveIngestIdempotencyKey = (
  request: IngestRequestInput
): string =>
  `docevt_${hashHex(
    [
      request.source.sourceId,
      request.namespace,
      request.externalId,
      request.version.versionId,
      request.contentHash,
    ].join("|")
  )}`;

/** Key for source resync jobs (unique per enqueue; dedupe is state-based). */
export const newSyncIdempotencyKey = (sourceId: string): string =>
  `sync_${sourceId}_${randomUUID()}`;

/**
 * Deterministic job id for a document version. Content is part of the digest
 * because changed content under the same version id is a new event.
 */
export const documentVersionJobId = (payload: {
  content: string;
  documentId: string;
  versionId: string;
}): string => {
  const digest = createHash("sha256")
    .update(
      `${payload.documentId}|${payload.versionId}|${hashHex(payload.content)}`,
      "utf-8"
    )
    .digest("hex")
    .slice(0, 40);
  return `dv_${digest}`;
};

/** Idempotency key for a document-version event; identical re-emits dedupe. */
export const deriveDocumentVersionKey = (payload: {
  content: string;
  documentId: string;
  externalId: string;
  namespace: string;
  versionId: string;
}): string =>
  `dvv_${hashHex(
    [
      payload.documentId,
      payload.namespace,
      payload.externalId,
      payload.versionId,
      hashHex(payload.content),
    ].join("|")
  )}`;

/** Exponential backoff for 1-based `attempts`: base, doubling, capped at max. */
export const retryDelaySeconds = (
  attempts: number,
  baseMs: number,
  maxMs: number
): number => {
  const exponent = Math.max(Math.trunc(attempts), 1) - 1;
  const delayMs = Math.min(baseMs * 2 ** exponent, maxMs);
  return delayMs / 1000;
};

/**
 * Single-statement claim: SKIP LOCKED keeps concurrent workers off the same
 * rows, and the UPDATE makes claim + lease atomic without a transaction.
 */
export const CLAIM_SQL = `UPDATE ${INGEST_TABLE} SET
  status = 'running',
  attempts = attempts + 1,
  worker_id = $1,
  heartbeat_at = now(),
  started_at = COALESCE(started_at, now())
WHERE id IN (
  SELECT id FROM ${INGEST_TABLE}
  WHERE status IN ('pending', 'retryable') AND available_at <= now()
  ORDER BY priority DESC, enqueued_at ASC, id ASC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
RETURNING id, kind, payload, attempts, max_attempts, source_id, namespace, started_at`;

/** Reset leases that expired; dead-letter jobs that already exhausted attempts. */
export const RECOVER_STALE_SQL = `UPDATE ${INGEST_TABLE} SET
  status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
  worker_id = NULL,
  error = $2,
  heartbeat_at = NULL
WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1)
RETURNING id`;

/** Complete only if the caller still owns the claim (worker_id + running). */
export const COMPLETE_SQL = `UPDATE ${INGEST_TABLE} SET
  status = 'succeeded',
  result = $2::jsonb,
  error = NULL,
  finished_at = now()
WHERE id = $1 AND worker_id = $3 AND status = 'running'
RETURNING id`;

/**
 * Retry with backoff or dead-letter once attempts are exhausted, decided
 * inside the statement so a concurrent recovery cannot race the decision.
 */
export const FAIL_SQL = `UPDATE ${INGEST_TABLE} SET
  status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retryable' END,
  error = $2,
  finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE finished_at END,
  available_at = CASE WHEN attempts >= max_attempts THEN available_at
    ELSE now() + make_interval(secs => $3) END,
  worker_id = NULL
WHERE id = $1 AND worker_id = $4 AND status = 'running'
RETURNING status`;

export const HEARTBEAT_SQL = `UPDATE ${INGEST_TABLE} SET heartbeat_at = now()
WHERE id = ANY($1::text[]) AND worker_id = $2 AND status = 'running'`;

/** Idempotent enqueue: a duplicate key returns the existing job instead of erroring. */
export const ENQUEUE_JOB_SQL = `WITH ins AS (
  INSERT INTO ${INGEST_TABLE}
    (id, kind, idempotency_key, source_id, namespace, payload, priority, max_attempts)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id, kind, status, source_id, namespace, idempotency_key,
            attempts, max_attempts, priority, error, result, payload,
            enqueued_at, started_at, finished_at
)
SELECT i.*, TRUE AS duplicate FROM ins i
UNION ALL
SELECT j.id, j.kind, j.status, j.source_id, j.namespace, j.idempotency_key,
       j.attempts, j.max_attempts, j.priority, j.error, j.result, j.payload,
       j.enqueued_at, j.started_at, j.finished_at, FALSE AS duplicate
FROM ${INGEST_TABLE} j
WHERE j.idempotency_key = $3
  AND NOT EXISTS (SELECT 1 FROM ins)`;

/** Upsert the source registry entry for an ingest request's source. */
export const SOURCE_UPSERT_SQL = `INSERT INTO ${SOURCE_TABLE}
  (source_id, kind, namespace, repo, ref, url, path)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (source_id) DO UPDATE SET
  kind = EXCLUDED.kind,
  namespace = EXCLUDED.namespace,
  repo = EXCLUDED.repo,
  ref = EXCLUDED.ref,
  url = EXCLUDED.url,
  path = EXCLUDED.path,
  updated_at = now()`;

export const SOURCE_BY_ID_SQL = `SELECT source_id, kind, namespace, repo, ref, url, path
FROM ${SOURCE_TABLE}
WHERE source_id = $1`;

/** Register a source row only when absent (never overwrites a richer row). */
export const SOURCE_INSERT_IF_MISSING_SQL = `INSERT INTO ${SOURCE_TABLE}
  (source_id, kind, namespace, repo, ref, url, path)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (source_id) DO NOTHING`;

export const JOB_SELECT_COLUMNS = `id, kind, status, source_id, namespace,
  idempotency_key, attempts, max_attempts, priority, error, result, payload,
  enqueued_at, started_at, finished_at`;

export const JOB_BY_ID_SQL = `SELECT ${JOB_SELECT_COLUMNS}
FROM ${INGEST_TABLE}
WHERE id = $1`;

export const ACTIVE_SYNC_JOB_SQL = `SELECT ${JOB_SELECT_COLUMNS}
FROM ${INGEST_TABLE}
WHERE kind = 'source_sync' AND source_id = $1
  AND status IN ('pending', 'running', 'retryable')
ORDER BY enqueued_at DESC, id ASC
LIMIT 1`;

/** Panel source list: counts, last sync, last terminal failure, active job. */
export const SOURCE_LIST_SQL = `SELECT s.source_id, s.kind, s.namespace, s.repo, s.ref, s.url, s.path,
  COALESCE((
    SELECT SUM(d.chunk_count) FROM ${DOCUMENT_TABLE} d
    WHERE d.source_id = s.source_id
  ), 0) AS chunk_count,
  (
    SELECT COUNT(*) FROM ${DOCUMENT_TABLE} d
    WHERE d.source_id = s.source_id
  ) AS document_count,
  (
    SELECT MAX(j.finished_at) FROM ${INGEST_TABLE} j
    WHERE j.source_id = s.source_id AND j.status = 'succeeded'
  ) AS last_sync_at,
  (
    SELECT json_build_object('at', j.finished_at, 'message', j.error)
    FROM ${INGEST_TABLE} j
    WHERE j.source_id = s.source_id AND j.status = 'dead' AND j.error IS NOT NULL
    ORDER BY j.enqueued_at DESC, j.id ASC
    LIMIT 1
  ) AS last_error,
  (
    SELECT json_build_object('jobId', j.id, 'status', j.status, 'startedAt', j.started_at)
    FROM ${INGEST_TABLE} j
    WHERE j.source_id = s.source_id AND j.status IN ('pending', 'running', 'retryable')
    ORDER BY j.enqueued_at DESC, j.id ASC
    LIMIT 1
  ) AS current_job
FROM ${SOURCE_TABLE} s
ORDER BY s.source_id ASC`;

/** Publish is a no-op when the version identity already exists. */
export const PUBLISH_DOCUMENT_SQL = `INSERT INTO ${DOCUMENT_TABLE}
  (document_id, namespace, source_id, external_id, version_id, content_hash,
   title, commit_ref, chunk_count, provenance)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
ON CONFLICT (namespace, source_id, external_id, version_id) DO NOTHING
RETURNING document_id`;

export const LOAD_MANIFEST_SQL = `SELECT commit_sha, entries
FROM ${MANIFEST_TABLE}
WHERE source_key = $1`;

export const SAVE_MANIFEST_SQL = `INSERT INTO ${MANIFEST_TABLE}
  (source_key, commit_sha, entries)
VALUES ($1, $2, $3::jsonb)
ON CONFLICT (source_key) DO UPDATE SET
  commit_sha = EXCLUDED.commit_sha,
  entries = EXCLUDED.entries,
  updated_at = now()`;

export const PING_SQL = "SELECT 1 AS ok";
