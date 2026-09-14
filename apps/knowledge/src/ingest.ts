/**
 * Ingest worker: normalized document version → chunks → embeddings →
 * the shared `chunks` table (#57; ADR-002 D5/D14 "K-ingest").
 *
 * `processDocumentVersion` is the pipeline: chunk deterministically
 * (`src/chunk.ts`), embed in explicit batches with bounded concurrency,
 * timeouts, and retries (`src/embedder.ts`), then persist in one transaction:
 * upsert every chunk and supersede the chunk ids that disappeared from this
 * document version (`valid_to = now()`). The run is retryable end to end:
 *
 * - Chunk ids are content+position addressed, so reprocessing the same
 *   version re-derives the same ids and the upsert is a no-op for unchanged
 *   chunks (unchanged content never re-embeds — ADR-002 D3/D10).
 * - A chunk whose embedding failed is still persisted — with `embedding
 *   NULL` and no model tag — so the BM25 channel keeps serving its text and
 *   `countChunksNeedingBackfill` (src/pgvector.ts) reports exactly how many
 *   vectors are waiting on the re-embed backfill. One bad chunk never
 *   discards its valid batchmates.
 * - `embedding` + `embedding_model` are written as an atomic pair (or the
 *   previous pair is kept via COALESCE), so a row can never claim a model it
 *   wasn't embedded under, and a re-embed under a new model migrates per
 *   chunk while chunks from other model generations coexist (retrieval
 *   filters by `embedding_model`).
 *
 * Jobs: `ingest_jobs` is the durable retry record (ADR-002 D5). Enqueue is
 * idempotent on `job_id`; `claimIngestJob` claims one queued job with
 * `FOR UPDATE SKIP LOCKED` in deterministic `(enqueued_at, job_id)` order;
 * `runIngestJob` marks it done or records a truncated failure. Payloads
 * carry the normalized content and are never logged.
 *
 * Logs are structured entries carrying only identifiers and counts — job id,
 * document id, version id, namespace, chunk/embed failure counts — never
 * document bodies or chunk texts.
 */

import { chunkDocumentVersion, CHUNKER_VERSION } from "./chunk.ts";
import type { NormalizedDocumentVersion } from "./chunk.ts";
import { embedChunkTexts } from "./embedder.ts";
import type { EmbeddingWorkerConfig } from "./embedder.ts";
import type { CitationAnchor, PgvectorDbClient } from "./pgvector.ts";
import { toPgvectorLiteral } from "./pgvector.ts";

/** Bump alongside schema-affecting changes to the `ingest_jobs` table. */
export const INGEST_SCHEMA_VERSION = "1-ingest-jobs";

/**
 * Idempotent migration for the durable job record (ADR-002 D5). The `chunks`
 * table itself is created by `ensurePgvectorSchema` (src/pgvector.ts); run
 * that first.
 */
export const INGEST_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS ingest_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  namespace TEXT NOT NULL,
  document_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);`;

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/** Job ids/paths are identifiers; bodies never belong in them. */
export const isIngestIdentifier = (value: string): boolean =>
  ID_PATTERN.test(value);

/** Errors recorded on jobs are truncated: enough to diagnose, never a body. */
export const MAX_JOB_ERROR_CHARS = 2000;

/** Parameterized SQL text plus bind params for `client.query`. */
export interface IngestQuery {
  params: unknown[];
  text: string;
}

export interface IngestJobSpec {
  documentId: string | null;
  jobId: string;
  kind: string;
  namespace: string;
  payload: Record<string, unknown>;
}

/**
 * Enqueue one job. Idempotent on `job_id`: re-enqueuing a known job (a
 * retried sync, a duplicated webhook) changes nothing — the queue, not the
 * caller, owns retry state.
 */
export const buildEnqueueJobQuery = (job: IngestJobSpec): IngestQuery => {
  if (!isIngestIdentifier(job.jobId)) {
    throw new TypeError(`ingest: invalid job id ${JSON.stringify(job.jobId)}`);
  }
  if (typeof job.kind !== "string" || !isIngestIdentifier(job.kind)) {
    throw new TypeError(`ingest: invalid job kind ${JSON.stringify(job.kind)}`);
  }
  if (
    typeof job.namespace !== "string" ||
    !NAMESPACE_PATTERN.test(job.namespace)
  ) {
    throw new TypeError(
      `ingest: invalid namespace ${JSON.stringify(job.namespace)}`
    );
  }
  if (job.documentId !== null && !isIngestIdentifier(job.documentId)) {
    throw new TypeError(
      `ingest: invalid document id ${JSON.stringify(job.documentId)}`
    );
  }
  return {
    params: [
      job.jobId,
      job.kind,
      job.namespace,
      job.documentId,
      JSON.stringify(job.payload),
    ],
    text: `INSERT INTO ingest_jobs ("job_id", "kind", "namespace", "document_id", "payload")
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT ("job_id") DO NOTHING`,
  };
};

/**
 * Claim the next queued job: `FOR UPDATE SKIP LOCKED` so concurrent workers
 * never fight over a row, oldest first with `job_id` as the deterministic
 * tie-break. Bumps `attempts`, marks the job `running`, and clears any stale
 * error from a previous attempt.
 */
export const buildClaimJobQuery = (): IngestQuery => ({
  params: [],
  text: `UPDATE ingest_jobs SET
  "status" = 'running',
  "attempts" = "attempts" + 1,
  "started_at" = now(),
  "heartbeat_at" = now(),
  "error" = NULL
WHERE "job_id" = (
  SELECT "job_id" FROM ingest_jobs
  WHERE "status" = 'queued'
  ORDER BY "enqueued_at" ASC, "job_id" ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING "job_id", "kind", "namespace", "document_id", "payload", "attempts"`,
});

export const buildCompleteJobQuery = (jobId: string): IngestQuery => ({
  params: [jobId],
  text: `UPDATE ingest_jobs
SET "status" = 'done', "finished_at" = now(), "heartbeat_at" = now(), "error" = NULL
WHERE "job_id" = $1`,
});

const truncateJobError = (message: string): string =>
  message.length > MAX_JOB_ERROR_CHARS
    ? message.slice(0, MAX_JOB_ERROR_CHARS)
    : message;

export const buildFailJobQuery = (
  jobId: string,
  error: string
): IngestQuery => ({
  params: [jobId, truncateJobError(error)],
  text: `UPDATE ingest_jobs
SET "status" = 'failed', "finished_at" = now(), "error" = $2
WHERE "job_id" = $1`,
});

/** One claimed ingest job, parsed from a driver row. */
export interface IngestJobRecord {
  attempts: number;
  documentId: string | null;
  jobId: string;
  kind: string;
  namespace: string;
  payload: unknown;
}

/** Map a claimed row; malformed rows throw instead of running garbage. */
export const parseIngestJobRow = (
  row: Record<string, unknown>
): IngestJobRecord => {
  const { attempts, document_id: documentId, job_id: jobId } = row;
  const { kind, namespace, payload } = row;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new TypeError("ingest: claimed job has no string job_id");
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError(`ingest: claimed job ${jobId} has no string kind`);
  }
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new TypeError(`ingest: claimed job ${jobId} has no string namespace`);
  }
  if (
    documentId !== null &&
    documentId !== undefined &&
    (typeof documentId !== "string" || documentId.length === 0)
  ) {
    throw new TypeError(
      `ingest: claimed job ${jobId} has a malformed document_id`
    );
  }
  let attemptsValue = Number.NaN;
  if (typeof attempts === "number") {
    attemptsValue = attempts;
  } else if (typeof attempts === "string" && /^\d+$/u.test(attempts)) {
    attemptsValue = Number(attempts);
  }
  if (!Number.isInteger(attemptsValue) || attemptsValue < 0) {
    throw new TypeError(
      `ingest: claimed job ${jobId} has a malformed attempts count`
    );
  }
  return {
    attempts: attemptsValue,
    documentId: documentId ?? null,
    jobId,
    kind,
    namespace,
    payload,
  };
};

/** One row of the `chunks` upsert. */
export interface ChunkUpsertRow {
  anchors: CitationAnchor[];
  chunkId: string;
  documentId: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  namespace: string;
  text: string;
  versionId: string;
}

/**
 * Build the chunk upsert. On conflict (same chunk id — i.e. same document,
 * chunker version, position, and content hash) the row is refreshed and
 * un-superseded, while the embedding pair is preserved unless this run
 * produced a new one: `embedding` and `embedding_model` are only ever
 * written together, so a row can never claim a model its vector wasn't made
 * by, and a failed re-embed leaves the previous generation's pair intact.
 */
export const buildChunkUpsertQuery = (row: ChunkUpsertRow): IngestQuery => {
  if ((row.embedding === null) !== (row.embeddingModel === null)) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} must carry embedding and model together or neither`
    );
  }
  return {
    params: [
      row.chunkId,
      row.documentId,
      row.versionId,
      row.namespace,
      row.text,
      JSON.stringify(row.anchors),
      row.embedding === null ? null : toPgvectorLiteral(row.embedding),
      row.embeddingModel,
    ],
    text: `INSERT INTO "chunks" ("chunk_id", "document_id", "version_id", "namespace", "text", "anchors", "embedding", "embedding_model", "valid_to")
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NULL)
ON CONFLICT ("chunk_id") DO UPDATE SET
  "document_id" = EXCLUDED."document_id",
  "version_id" = EXCLUDED."version_id",
  "namespace" = EXCLUDED."namespace",
  "text" = EXCLUDED."text",
  "anchors" = EXCLUDED."anchors",
  "embedding" = COALESCE(EXCLUDED."embedding", "chunks"."embedding"),
  "embedding_model" = COALESCE(EXCLUDED."embedding_model", "chunks"."embedding_model"),
  "valid_to" = NULL`,
  };
};

/**
 * Supersede every live chunk of `documentId` whose id is not in `keepChunkIds`
 * (the chunks absent from the new document version). With an empty keep set
 * this supersedes the whole document — the honest result of re-ingesting an
 * emptied version.
 */
export const buildSupersedeChunksQuery = (
  documentId: string,
  keepChunkIds: string[]
): IngestQuery => ({
  params: [documentId, keepChunkIds],
  text: `UPDATE "chunks"
SET "valid_to" = now()
WHERE "document_id" = $1
  AND "valid_to" IS NULL
  AND NOT ("chunk_id" = ANY($2))`,
});

export type IngestLogEntry = Record<string, string | number | boolean | null>;

const noopLog = (_entry: IngestLogEntry): undefined => undefined;

/** Build the normalized document version a job's payload describes. */
export const parseDocumentPayload = (
  job: IngestJobRecord
): NormalizedDocumentVersion => {
  if (job.documentId === null) {
    throw new TypeError(
      `ingest: job ${job.jobId} has no document_id (kind ${job.kind})`
    );
  }
  const record =
    typeof job.payload === "object" && job.payload !== null
      ? (job.payload as Record<string, unknown>)
      : null;
  if (record === null) {
    throw new TypeError(
      `ingest: job ${job.jobId} payload is not a JSON object`
    );
  }
  const { content, format, versionId } = record;
  if (typeof content !== "string") {
    throw new TypeError(
      `ingest: job ${job.jobId} payload has no string content`
    );
  }
  if (typeof versionId !== "string" || versionId.length === 0) {
    throw new TypeError(`ingest: job ${job.jobId} payload has no versionId`);
  }
  if (
    format !== undefined &&
    format !== "markdown" &&
    format !== "code" &&
    format !== "text"
  ) {
    throw new TypeError(
      `ingest: job ${job.jobId} payload format ${JSON.stringify(format)} is not a chunk format`
    );
  }
  return {
    content,
    documentId: job.documentId,
    namespace: job.namespace,
    versionId,
    ...(format === undefined ? {} : { format }),
  };
};

export interface DocumentIngestOutcome {
  chunkerVersion: string;
  documentId: string;
  /** Chunks that carry a validated embedding after this run. */
  embeddedCount: number;
  /** Per-chunk embedding failures (chunk id + reason, never chunk text). */
  failedChunks: { chunkId: string; reason: string }[];
  jobId: string | null;
  model: string;
  namespace: string;
  /** `"ok"` when every chunk embedded; `"partial"` means re-embed backfill. */
  status: "ok" | "partial";
  totalChunks: number;
  versionId: string;
}

export interface IngestRunOptions {
  config: EmbeddingWorkerConfig;
  log?: (entry: IngestLogEntry) => void;
  /** Job id for structured logs; null for direct (job-less) processing. */
  jobId?: string;
  /** Injectable sleep forwarded to the embed engine (tests, backoff control). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run one document version through chunk → embed → persist.
 *
 * The persistence transaction upserts every chunk (embedded ones with their
 * `embedding` + `embedding_model` pair, failed ones with both NULL so the
 * text still serves the BM25 channel) and supersedes the chunk ids that no
 * longer exist in this version. Any database failure rolls the whole version
 * swap back. Embedding failures do NOT roll back: they are reported per
 * chunk in the outcome (`status: "partial"`) and surface through
 * `countChunksNeedingBackfill` until a re-run or backfill embeds them.
 */
export const processDocumentVersion = async (
  client: PgvectorDbClient,
  doc: NormalizedDocumentVersion,
  options: IngestRunOptions
): Promise<DocumentIngestOutcome> => {
  const { config, jobId = null } = options;
  const log = options.log ?? noopLog;
  const chunks = chunkDocumentVersion(doc, { maxChars: config.maxChars });
  log({
    bytes: doc.content.length,
    chunkerVersion: CHUNKER_VERSION,
    chunks: chunks.length,
    documentId: doc.documentId,
    event: "chunked",
    jobId,
    namespace: doc.namespace,
    versionId: doc.versionId,
  });
  const { embeddings, failures } = await embedChunkTexts(
    chunks.map((chunk) => chunk.text),
    config,
    options.sleep === undefined ? {} : { sleep: options.sleep }
  );
  log({
    documentId: doc.documentId,
    embedded: embeddings.size,
    event: "embedded",
    failed: failures.size,
    jobId,
    model: config.provider.model,
    provider: config.provider.name,
    versionId: doc.versionId,
  });
  await client.query("BEGIN", []);
  try {
    for (const [index, chunk] of chunks.entries()) {
      const embedding = embeddings.get(index) ?? null;
      const built = buildChunkUpsertQuery({
        anchors: chunk.anchors,
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        embedding,
        embeddingModel: embedding === null ? null : config.provider.model,
        namespace: chunk.namespace,
        text: chunk.text,
        versionId: chunk.versionId,
      });
      await client.query(built.text, built.params);
    }
    const supersede = buildSupersedeChunksQuery(
      doc.documentId,
      chunks.map((chunk) => chunk.chunkId)
    );
    await client.query(supersede.text, supersede.params);
    await client.query("COMMIT", []);
  } catch (error) {
    try {
      await client.query("ROLLBACK", []);
    } catch {
      // The original failure is the one worth surfacing.
    }
    throw error;
  }
  const failedChunks = [...failures.entries()]
    .toSorted(([a], [b]) => a - b)
    .map(([index, reason]) => {
      const chunk = chunks[index];
      return {
        chunkId: chunk === undefined ? "unknown" : chunk.chunkId,
        reason,
      };
    });
  log({
    documentId: doc.documentId,
    embedded: embeddings.size,
    event: "persisted",
    failed: failedChunks.length,
    jobId,
    namespace: doc.namespace,
    status: failedChunks.length === 0 ? "ok" : "partial",
    versionId: doc.versionId,
  });
  return {
    chunkerVersion: CHUNKER_VERSION,
    documentId: doc.documentId,
    embeddedCount: embeddings.size,
    failedChunks,
    jobId,
    model: config.provider.model,
    namespace: doc.namespace,
    status: failedChunks.length === 0 ? "ok" : "partial",
    totalChunks: chunks.length,
    versionId: doc.versionId,
  };
};

export interface IngestJobResult {
  error?: string;
  outcome?: DocumentIngestOutcome;
  status: "done" | "failed";
}

/**
 * Run one claimed job: parse its payload into a normalized document version,
 * process it, and mark it done — or record a truncated failure. Failures
 * here are unexpected errors (malformed payload, database failure, provider
 * exhaustion that threw); per-chunk embedding failures are not job failures
 * — they are the `partial` outcome above, visible to the backfill.
 */
export const runIngestJob = async (
  client: PgvectorDbClient,
  job: IngestJobRecord,
  options: IngestRunOptions
): Promise<IngestJobResult> => {
  try {
    const doc = parseDocumentPayload(job);
    const outcome = await processDocumentVersion(client, doc, {
      ...options,
      jobId: job.jobId,
    });
    const complete = buildCompleteJobQuery(job.jobId);
    await client.query(complete.text, complete.params);
    return { outcome, status: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fail = buildFailJobQuery(job.jobId, message);
    await client.query(fail.text, fail.params);
    return { error: truncateJobError(message), status: "failed" };
  }
};

/** Claim one queued job (`FOR UPDATE SKIP LOCKED`), or null when drained. */
export const claimIngestJob = async (
  client: PgvectorDbClient
): Promise<IngestJobRecord | null> => {
  const built = buildClaimJobQuery();
  const result = await client.query(built.text, built.params);
  const [row] = result.rows;
  return row === undefined ? null : parseIngestJobRow(row);
};

/**
 * Claim and run queued jobs until the queue is empty or `maxJobs` runs in
 * this pass. The caller (CronJob now, deployment later — ADR-002 D5) decides
 * the schedule; every run is safe to repeat thanks to idempotent upserts.
 */
export const drainIngestJobs = async (
  client: PgvectorDbClient,
  options: IngestRunOptions,
  limits: { maxJobs?: number } = {}
): Promise<IngestJobResult[]> => {
  const maxJobs = limits.maxJobs ?? 10;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) {
    throw new TypeError(
      `ingest: maxJobs must be an integer >= 1, got ${String(limits.maxJobs)}`
    );
  }
  const results: IngestJobResult[] = [];
  while (results.length < maxJobs) {
    const job = await claimIngestJob(client);
    if (job === null) {
      break;
    }
    results.push(await runIngestJob(client, job, options));
  }
  return results;
};

/** Run the idempotent `ingest_jobs` migration on `client`. */
export const ensureIngestSchema = async (
  client: PgvectorDbClient
): Promise<void> => {
  await client.query(INGEST_MIGRATION_SQL, []);
};
