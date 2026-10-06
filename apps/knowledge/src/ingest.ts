/**
 * Ingest worker: normalized document version → chunks → embeddings →
 * the #56 knowledge schema (#57; ADR-002 D5/D14 "K-ingest").
 *
 * `processDocumentVersion` is the pipeline: chunk deterministically
 * (`src/chunk.ts`), embed in explicit batches with bounded concurrency,
 * timeouts, and retries (`src/embedder.ts`), then persist in one transaction
 * against the #56 document model (`src/schema.ts`), in FK order:
 *
 * 1. register the namespace (`knowledge_namespace` — `document`/`chunks`
 *    FK it, so an unregistered collection key cannot ingest);
 * 2. upsert the document row — identity `(namespace, source, external_id)`,
 *    the full-content sha256 decides the version bump, and an unchanged
 *    hash leaves the row untouched (#56 idempotency);
 * 3. append the `document_version` row the chunks will cite (history is
 *    never mutated: an already-recorded `(document_id, version)` keeps its
 *    original row id, and the chunks point at that row);
 * 4. upsert every chunk into `chunks` — content-addressed on
 *    `(document_id, content_hash)` per the #56 UNIQUE constraint — writing
 *    the embedding pair atomically;
 * 5. supersede the live chunks whose content hash disappeared from this
 *    version (`valid_to = now()`).
 *
 * The run is retryable end to end:
 *
 * - Chunk ids are content+position addressed, so reprocessing the same
 *   version re-derives the same ids and values; unchanged content conflicts
 *   on `(document_id, content_hash)` and touches nothing (ADR-002 D3/D10).
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
 * Jobs ride the #56 `ingest_job` table (created by the base schema
 * migration, ADR-002 D5): enqueue is idempotent on the job id, the claim is
 * the schema's `FOR UPDATE SKIP LOCKED` statement (priority first, then
 * FIFO), and `drainIngestJobs` claims until the queue is empty or a
 * per-pass cap. Job payloads carry the normalized content and are never
 * logged.
 *
 * Logs are structured entries carrying only identifiers and counts — job id,
 * document id, version id, namespace, chunk/embed failure counts — never
 * document bodies or chunk texts.
 */

import { chunkDocumentVersion, CHUNKER_VERSION, sha256Hex } from "./chunk.ts";
import type { ChunkFormat, NormalizedDocumentVersion } from "./chunk.ts";
import { embedChunkTexts } from "./embedder.ts";
import type { EmbeddingWorkerConfig } from "./embedder.ts";
import type { CitationAnchor, PgvectorDbClient } from "./pgvector.ts";
import { toPgvectorLiteral } from "./pgvector.ts";
import {
  buildDocumentUpsert,
  buildDocumentVersionInsert,
  buildIngestJobClaim,
  buildNamespaceRegistration,
} from "./schema.ts";
import type { SchemaQuery } from "./schema.ts";

/**
 * The worker's input unit: a normalized document version plus the #56
 * document identity (`source` + `externalId`) and citation metadata the
 * schema's `document` row requires. The chunker only consumes the
 * `NormalizedDocumentVersion` subset.
 */
export interface IngestDocumentVersion extends NormalizedDocumentVersion {
  /** #56 document identity: stable within `(namespace, source, external_id)`. */
  externalId: string;
  /** Source kind label, e.g. `"file"`, `"github"`, `"url"`. */
  source: string;
  title?: string | null;
  url?: string | null;
}

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Job ids/kinds are identifiers; bodies never belong in them. */
export const isIngestIdentifier = (value: string): boolean =>
  ID_PATTERN.test(value);

/** Errors recorded on jobs are truncated: enough to diagnose, never a body. */
export const MAX_JOB_ERROR_CHARS = 2000;

const truncateJobError = (message: string): string =>
  message.length > MAX_JOB_ERROR_CHARS
    ? message.slice(0, MAX_JOB_ERROR_CHARS)
    : message;

// --- queue: the #56 ingest_job table ---

export interface IngestJobSpec {
  /** Caller-assigned job id; idempotency key for the enqueue. */
  jobId: string;
  kind: string;
  /** JSONB payload (the normalized document for `document-version` jobs). */
  payload: Record<string, unknown>;
  /** Higher runs first (the claim orders `priority DESC`). Default 0. */
  priority?: number;
}

/**
 * Enqueue one job. Idempotent on the job id: re-enqueuing a known job (a
 * retried sync, a duplicated webhook) changes nothing — the queue, not the
 * caller, owns retry state.
 */
export const buildEnqueueJobQuery = (job: IngestJobSpec): SchemaQuery => {
  if (!isIngestIdentifier(job.jobId)) {
    throw new TypeError(`ingest: invalid job id ${JSON.stringify(job.jobId)}`);
  }
  if (typeof job.kind !== "string" || !isIngestIdentifier(job.kind)) {
    throw new TypeError(`ingest: invalid job kind ${JSON.stringify(job.kind)}`);
  }
  if (job.payload === null || typeof job.payload !== "object") {
    throw new TypeError("ingest: job payload must be a JSON object");
  }
  const priority = job.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new TypeError(
      `ingest: priority must be an integer >= 0, got ${String(job.priority)}`
    );
  }
  return {
    params: [job.jobId, job.kind, JSON.stringify(job.payload), priority],
    text: `INSERT INTO ingest_job (id, kind, payload, priority)
VALUES ($1, $2, $3::jsonb, $4)
ON CONFLICT (id) DO NOTHING`,
  };
};

/** Claim the next queued job: the #56 schema's SKIP LOCKED claim statement. */
export const buildClaimJobQuery = (): SchemaQuery => buildIngestJobClaim();

export const buildCompleteJobQuery = (jobId: string): SchemaQuery => ({
  params: [jobId],
  text: `UPDATE ingest_job
SET status = 'done', heartbeat_at = now(), error = NULL
WHERE id = $1`,
});

export const buildFailJobQuery = (
  jobId: string,
  error: string
): SchemaQuery => ({
  params: [jobId, truncateJobError(error)],
  text: `UPDATE ingest_job
SET status = 'failed', heartbeat_at = now(), error = $2
WHERE id = $1`,
});

/** One claimed ingest job, parsed from a driver row. */
export interface IngestJobRecord {
  attempts: number;
  jobId: string;
  kind: string;
  payload: unknown;
}

/** Map a claimed row; malformed rows throw instead of running garbage. */
export const parseIngestJobRow = (
  row: Record<string, unknown>
): IngestJobRecord => {
  const { attempts, id: jobId } = row;
  const { kind, payload } = row;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new TypeError("ingest: claimed job has no string id");
  }
  if (typeof kind !== "string" || kind.length === 0) {
    throw new TypeError(`ingest: claimed job ${jobId} has no string kind`);
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
  return { attempts: attemptsValue, jobId, kind, payload };
};

/** Required, non-empty string field of a job payload. */
const payloadRequiredString = (
  record: Record<string, unknown>,
  key: string,
  jobId: string
): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`ingest: job ${jobId} payload has no string ${key}`);
  }
  return value;
};

/** Optional chunk-format field of a job payload. */
const payloadChunkFormat = (
  record: Record<string, unknown>,
  jobId: string
): ChunkFormat | undefined => {
  const { format } = record;
  if (format === undefined) {
    return undefined;
  }
  if (format !== "markdown" && format !== "code" && format !== "text") {
    throw new TypeError(
      `ingest: job ${jobId} payload format ${JSON.stringify(format)} is not a chunk format`
    );
  }
  return format;
};

/** Optional string-or-null field of a job payload. */
const payloadNullableString = (
  record: Record<string, unknown>,
  key: string,
  jobId: string
): string | null | undefined => {
  const value = record[key];
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  throw new TypeError(
    `ingest: job ${jobId} payload ${key} must be a string or null`
  );
};

/** Build the normalized document version a job's payload describes. */
export const parseDocumentPayload = (
  job: IngestJobRecord
): IngestDocumentVersion => {
  const record =
    typeof job.payload === "object" && job.payload !== null
      ? (job.payload as Record<string, unknown>)
      : null;
  if (record === null) {
    throw new TypeError(
      `ingest: job ${job.jobId} payload is not a JSON object`
    );
  }
  const { jobId } = job;
  const content = payloadRequiredString(record, "content", jobId);
  const documentId = payloadRequiredString(record, "documentId", jobId);
  const externalId = payloadRequiredString(record, "externalId", jobId);
  const source = payloadRequiredString(record, "source", jobId);
  const versionId = payloadRequiredString(record, "versionId", jobId);
  const namespace = payloadRequiredString(record, "namespace", jobId);
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(
      `ingest: job ${jobId} payload has an invalid namespace`
    );
  }
  const format = payloadChunkFormat(record, jobId);
  const title = payloadNullableString(record, "title", jobId);
  const url = payloadNullableString(record, "url", jobId);
  return {
    content,
    documentId,
    externalId,
    namespace,
    source,
    versionId,
    ...(format === undefined ? {} : { format }),
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
  };
};

// --- document-model reads the pipeline needs beyond the schema builders ---

/**
 * Read the document's current row when the version-bump upsert returned
 * nothing (unchanged content): the row exists — that is why the DO UPDATE
 * guard filtered it — so a missing row is a contract violation, not a
 * content question.
 */
export const buildDocumentCurrentVersionQuery = (
  namespace: string,
  source: string,
  externalId: string
): SchemaQuery => {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new TypeError(
      `ingest: invalid namespace ${JSON.stringify(namespace)}`
    );
  }
  if (typeof source !== "string" || source.length === 0) {
    throw new TypeError("ingest: source must be a non-empty string");
  }
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new TypeError("ingest: externalId must be a non-empty string");
  }
  return {
    params: [namespace, source, externalId],
    text: `SELECT id, version FROM document
WHERE namespace = $1 AND source = $2 AND external_id = $3`,
  };
};

/**
 * Read the version row id when the append conflicted on
 * `(document_id, version)`: history is never mutated (#56), so the chunks
 * cite the row that already records this version.
 */
export const buildDocumentVersionIdQuery = (
  documentId: string,
  version: number
): SchemaQuery => {
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new TypeError("ingest: documentId must be a non-empty string");
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError(
      `ingest: version must be an integer >= 1, got ${String(version)}`
    );
  }
  return {
    params: [documentId, version],
    text: `SELECT id FROM document_version
WHERE document_id = $1 AND version = $2`,
  };
};

const readRowString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`ingest: ${label} is not a non-empty string`);
  }
  return value;
};

const readRowVersion = (value: unknown, label: string): number => {
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/u.test(value)) {
    parsed = Number(value);
  }
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(`ingest: ${label} is not a version integer >= 1`);
  }
  return parsed;
};

// --- chunk persistence ---

/** One row of the `chunks` upsert. */
export interface ChunkUpsertRow {
  anchors: CitationAnchor[];
  chunkId: string;
  chunkerVersion: string;
  contentHash: string;
  documentId: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  idx: number;
  namespace: string;
  text: string;
  versionId: string;
}

/**
 * Build the chunk upsert against the #56 `chunks` table. Conflict target is
 * the schema's UNIQUE `(document_id, content_hash)` — chunk identity is
 * content-addressed (#56, ADR-002 D3) — so re-ingesting unchanged chunk
 * text reactivates the existing row and never re-embeds it, while a chunker
 * bump re-points `chunker_version`/`idx` without inventing a second row for
 * the same text. The embedding pair is only ever written together, and a
 * failed re-embed leaves the previous generation's pair intact (COALESCE).
 * `chunk_id` stays out of the SET list on purpose: the row keeps the id it
 * was first inserted under, so citation anchors stay stable across
 * re-chunking.
 */
export const buildChunkUpsertQuery = (row: ChunkUpsertRow): SchemaQuery => {
  if ((row.embedding === null) !== (row.embeddingModel === null)) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} must carry embedding and model together or neither`
    );
  }
  if (
    typeof row.chunkerVersion !== "string" ||
    row.chunkerVersion.length === 0
  ) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} chunkerVersion must be a non-empty string`
    );
  }
  if (!HASH_PATTERN.test(row.contentHash)) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} contentHash must be a sha256 hex digest`
    );
  }
  if (!Number.isInteger(row.idx) || row.idx < 0) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} idx must be an integer >= 0`
    );
  }
  if (typeof row.text !== "string" || row.text.length === 0) {
    throw new TypeError(`ingest: chunk ${row.chunkId} text must be non-empty`);
  }
  if (!NAMESPACE_PATTERN.test(row.namespace)) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} has an invalid namespace`
    );
  }
  if (!Array.isArray(row.anchors)) {
    throw new TypeError(
      `ingest: chunk ${row.chunkId} anchors must be an array`
    );
  }
  return {
    params: [
      row.chunkId,
      row.documentId,
      row.versionId,
      row.namespace,
      row.idx,
      row.text,
      row.contentHash,
      JSON.stringify(row.anchors),
      row.embedding === null ? null : toPgvectorLiteral(row.embedding),
      row.embeddingModel,
      row.chunkerVersion,
    ],
    text: `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, idx, text, content_hash, anchors, embedding, embedding_model, chunker_version)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector, $10, $11)
ON CONFLICT (document_id, content_hash) DO UPDATE SET
  version_id = EXCLUDED.version_id,
  namespace = EXCLUDED.namespace,
  idx = EXCLUDED.idx,
  text = EXCLUDED.text,
  anchors = EXCLUDED.anchors,
  chunker_version = EXCLUDED.chunker_version,
  embedding = COALESCE(EXCLUDED.embedding, chunks.embedding),
  embedding_model = COALESCE(EXCLUDED.embedding_model, chunks.embedding_model),
  valid_from = now(),
  valid_to = NULL`,
  };
};

/**
 * Supersede every live chunk of `documentId` whose content hash is not in
 * `keepContentHashes` (the hashes absent from the new document version).
 * Keeping by content hash — the #56 identity — stays correct even when the
 * chunker re-ids chunks (version bump, position shift): the upserts above
 * have already reactivated this version's rows, so only genuinely dropped
 * text leaves the live corpus. With an empty keep set this supersedes the
 * whole document — the honest result of re-ingesting an emptied version.
 */
export const buildSupersedeChunksQuery = (
  documentId: string,
  keepContentHashes: string[]
): SchemaQuery => {
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new TypeError("ingest: documentId must be a non-empty string");
  }
  for (const hash of keepContentHashes) {
    if (!HASH_PATTERN.test(hash)) {
      throw new TypeError(
        `ingest: keep hashes must be sha256 hex digests, got ${JSON.stringify(hash)}`
      );
    }
  }
  return {
    params: [documentId, keepContentHashes],
    text: `UPDATE chunks
SET valid_to = now()
WHERE document_id = $1
  AND valid_to IS NULL
  AND NOT (content_hash = ANY($2))`,
  };
};

// --- the pipeline ---

export type IngestLogEntry = Record<string, string | number | boolean | null>;

const noopLog = (_entry: IngestLogEntry): undefined => undefined;

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
  /** The `document_version` row the persisted chunks cite. */
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
 * The persistence transaction writes the #56 document model in FK order —
 * namespace, document, document version, then chunks — and supersedes the
 * content hashes that no longer exist in this version. Any database failure
 * rolls the whole version swap back. Embedding failures do NOT roll back:
 * they are reported per chunk in the outcome (`status: "partial"`) and
 * surface through `countChunksNeedingBackfill` until a re-run or backfill
 * embeds them.
 */
export const processDocumentVersion = async (
  client: PgvectorDbClient,
  doc: IngestDocumentVersion,
  options: IngestRunOptions
): Promise<DocumentIngestOutcome> => {
  const { config, jobId = null } = options;
  const log = options.log ?? noopLog;
  const contentHash = sha256Hex(doc.content);
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
  let { documentId, versionId } = doc;
  try {
    const registerNamespace = buildNamespaceRegistration(doc.namespace);
    await client.query(registerNamespace.text, registerNamespace.params);
    const documentUpsert = buildDocumentUpsert({
      content_hash: contentHash,
      external_id: doc.externalId,
      id: doc.documentId,
      namespace: doc.namespace,
      source: doc.source,
      ...(doc.title === undefined ? {} : { title: doc.title }),
      ...(doc.url === undefined ? {} : { url: doc.url }),
    });
    const upserted = await client.query(
      documentUpsert.text,
      documentUpsert.params
    );
    let documentVersion: number;
    const [documentRow] = upserted.rows;
    if (documentRow === undefined) {
      // Unchanged content: the DO UPDATE guard filtered the upsert, so
      // resolve the existing row the document already has.
      const current = buildDocumentCurrentVersionQuery(
        doc.namespace,
        doc.source,
        doc.externalId
      );
      const selected = await client.query(current.text, current.params);
      const [row] = selected.rows;
      if (row === undefined) {
        throw new Error(
          `ingest: document ${doc.namespace}/${doc.source}/${doc.externalId} vanished between upsert and read`
        );
      }
      documentId = readRowString(row["id"], "document id");
      documentVersion = readRowVersion(row["version"], "document version");
    } else {
      documentId = readRowString(documentRow["id"], "document upsert id");
      documentVersion = readRowVersion(
        documentRow["version"],
        "document upsert version"
      );
    }
    const versionInsert = buildDocumentVersionInsert({
      content_hash: contentHash,
      document_id: documentId,
      id: doc.versionId,
      version: documentVersion,
    });
    const inserted = await client.query(
      versionInsert.text,
      versionInsert.params
    );
    const [versionRow] = inserted.rows;
    if (versionRow === undefined) {
      // Same (document_id, version) already recorded: history is never
      // mutated, so the chunks cite the existing row's id.
      const existing = buildDocumentVersionIdQuery(documentId, documentVersion);
      const selected = await client.query(existing.text, existing.params);
      const [row] = selected.rows;
      if (row === undefined) {
        throw new Error(
          `ingest: document ${documentId} version ${documentVersion} vanished between insert and read`
        );
      }
      versionId = readRowString(row["id"], "document version id");
    }
    for (const [index, chunk] of chunks.entries()) {
      const embedding = embeddings.get(index) ?? null;
      const built = buildChunkUpsertQuery({
        anchors: chunk.anchors,
        chunkId: chunk.chunkId,
        chunkerVersion: chunk.chunkerVersion,
        contentHash: chunk.contentHash,
        documentId,
        embedding,
        embeddingModel: embedding === null ? null : config.provider.model,
        idx: chunk.idx,
        namespace: chunk.namespace,
        text: chunk.text,
        versionId,
      });
      await client.query(built.text, built.params);
    }
    const supersede = buildSupersedeChunksQuery(
      documentId,
      chunks.map((chunk) => chunk.contentHash)
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
    versionId,
  });
  return {
    chunkerVersion: CHUNKER_VERSION,
    documentId,
    embeddedCount: embeddings.size,
    failedChunks,
    jobId,
    model: config.provider.model,
    namespace: doc.namespace,
    status: failedChunks.length === 0 ? "ok" : "partial",
    totalChunks: chunks.length,
    versionId,
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
