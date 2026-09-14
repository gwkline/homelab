/**
 * Durable work queue core (#58) — ADR-002 D5 without a broker service.
 *
 * Everything durable lives in three Postgres tables, created idempotently by
 * `INGEST_SCHEMA_SQL`:
 *
 *   ingest_job    — the work queue. Claimed with `FOR UPDATE SKIP LOCKED`
 *                   (single-statement claim, Probe's ingestion_queue pattern),
 *                   retried with exponential backoff, dead-lettered after
 *                   `max_attempts`, recovered from stale claims via the
 *                   `heartbeat_at` lease.
 *   ingest_source — registered sources (identity + namespace + origin), the
 *                   panel-facing source list (#58/#65 contract).
 *   document      — published document versions, unique on
 *                   (namespace, source_id, external_id, version_id). This
 *                   UNIQUE constraint is what makes stale-claim recovery safe:
 *                   a re-run after recovery re-publishes the same version
 *                   identity and lands on the same row, so a crashed worker
 *                   can never produce a second copy of a document version.
 *
 * This module is pure: SQL text, state constants, idempotency-key derivation
 * and backoff math only — no I/O, no clocks. `PgIngestStore` executes the
 * statements (parameters are positional per statement shape);
 * `MemoryIngestStore` mirrors the same state machine in-process so the
 * offline tests exercise identical enqueue/claim/complete/fail/recover
 * semantics.
 */

import { createHash, randomUUID } from "node:crypto";

import type { IngestRequestInput, JobKind, JobState } from "./store.ts";

export const INGEST_SCHEMA_VERSION = "1-ingest-queue";

export const INGEST_TABLE = "ingest_job";
export const SOURCE_TABLE = "ingest_source";
export const DOCUMENT_TABLE = "document";

export const JOB_STATES = [
  "pending",
  "running",
  "succeeded",
  "retryable",
  "dead",
] as const satisfies readonly JobState[];

export const JOB_KINDS = [
  "document",
  "source_sync",
] as const satisfies readonly JobKind[];

export const SOURCE_KINDS = ["github", "file", "url", "web"] as const;

/** Claimable states: fresh work plus retries whose backoff elapsed. */
export const CLAIMABLE_STATES = ["pending", "retryable"] as const;

export const STALE_RECOVERY_MESSAGE =
  "claim lease expired; recovered for retry";

/**
 * Idempotent schema. `ingest_job.idempotency_key` is globally UNIQUE: the API
 * derives it deterministically from the source event identity (see
 * `deriveIngestIdempotencyKey`) so duplicate delivery of the same
 * source/version event collides on the constraint instead of enqueueing a
 * second job. The claimable partial index serves the SKIP LOCKED scan.
 */
export const INGEST_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingest_job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'source_sync')),
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

CREATE TABLE IF NOT EXISTS document (
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
  ON document (source_id);
`;

/** New job ids are app-generated so every store produces the same shape. */
export const newJobId = (): string => `job_${randomUUID()}`;

const hashHex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Deterministic document id: the same version identity always maps to the
 * same row, in every store. `doc_` + 40 hex chars of the identity digest.
 */
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
 * The default idempotency key: a digest of the full source event identity —
 * source, namespace, external id, version id, and content hash. The same
 * event re-delivered (same version, same content) collides with the first
 * job; any change to the version or content is a new event.
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
 * Exponential backoff for the Nth failed attempt (attempts is 1-based at
 * fail time). Base delay for the first failure, doubling, capped at max.
 * Pure so tests can pin the sequence.
 */
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
 * Single-statement claim. The inner SELECT takes up to `limit` claimable rows
 * with `FOR UPDATE SKIP LOCKED` so concurrent workers can never lock — and
 * therefore never claim — the same row; the outer UPDATE flips each claimed
 * row to `running` and stamps the lease in the same statement, so claim +
 * state transition are atomic without an explicit transaction.
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

/**
 * Idempotent enqueue: the INSERT collides on `idempotency_key` for duplicate
 * events and the CTE returns the existing row instead, so a duplicate request
 * observes the original job (and its current state) rather than erroring.
 */
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

/**
 * Panel-facing source list (#58/#65): per-source counts from the published
 * `document` rows, last successful sync, last recorded terminal failure, and
 * the most recent still-active job.
 */
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

/** Publish is a no-op on version identity: same (namespace, source, external
 * id, version) never creates a second row. */
export const PUBLISH_DOCUMENT_SQL = `INSERT INTO ${DOCUMENT_TABLE}
  (document_id, namespace, source_id, external_id, version_id, content_hash,
   title, commit_ref, chunk_count, provenance)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
ON CONFLICT (namespace, source_id, external_id, version_id) DO NOTHING
RETURNING document_id`;

export const PING_SQL = "SELECT 1 AS ok";
