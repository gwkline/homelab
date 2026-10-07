/**
 * Ingest worker: a normalized document version is chunked, embedded, and
 * persisted in one transaction (ADR-002 D5). Reprocessing is idempotent
 * because chunks are content-addressed on `(document_id, content_hash)`.
 *
 * A chunk whose embedding failed is still persisted with a NULL embedding so
 * BM25 keeps serving it and `countChunksNeedingBackfill` can report it.
 * Logs carry only identifiers and counts, never document or chunk text.
 */

import { chunkDocumentVersion, CHUNKER_VERSION, sha256Hex } from "./chunk.ts";
import type { ChunkFormat, NormalizedDocumentVersion } from "./chunk.ts";
import { embedChunkTexts } from "./embedder.ts";
import type { EmbeddingWorkerConfig } from "./embedder.ts";
import type { PgClient, PgPool } from "./pg-client.ts";
import { withTransaction } from "./pg-client.ts";
import type { CitationAnchor } from "./pgvector.ts";
import { toPgvectorLiteral } from "./pgvector.ts";
import {
  buildDocumentUpsert,
  buildDocumentVersionInsert,
  buildIngestJobClaim,
  buildNamespaceRegistration,
} from "./schema.ts";
import type { SchemaQuery } from "./schema.ts";

export interface IngestDocumentVersion extends NormalizedDocumentVersion {
  /** Stable within `(namespace, source)`. */
  externalId: string;
  /** e.g. `"file"`, `"git"`, `"url"`. */
  source: string;
  title?: string | null;
  url?: string | null;
}

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export const isIngestIdentifier = (value: string): boolean =>
  ID_PATTERN.test(value);

export const MAX_JOB_ERROR_CHARS = 2000;

const truncateJobError = (message: string): string =>
  message.length > MAX_JOB_ERROR_CHARS
    ? message.slice(0, MAX_JOB_ERROR_CHARS)
    : message;

export interface IngestJobSpec {
  /** Idempotency key for the enqueue. */
  jobId: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Higher runs first. Default 0. */
  priority?: number;
}

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

export interface IngestJobRecord {
  attempts: number;
  jobId: string;
  kind: string;
  payload: unknown;
}

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

/** Used when the version-bump upsert returns nothing because content is unchanged. */
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

/** History is append-only, so on conflict the chunks cite the existing row. */
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
 * Unchanged text reactivates its existing row instead of duplicating it. A
 * failed re-embed keeps the previous embedding pair (COALESCE), and
 * `chunk_id` is never updated so citations stay stable across re-chunking.
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
 * Supersedes live chunks whose content hash is absent from the new version.
 * Keying on content hash stays correct when the chunker re-ids chunks.
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

export type IngestLogEntry = Record<string, string | number | boolean | null>;

const noopLog = (_entry: IngestLogEntry): undefined => undefined;

export interface DocumentIngestOutcome {
  chunkerVersion: string;
  documentId: string;
  embeddedCount: number;
  failedChunks: { chunkId: string; reason: string }[];
  jobId: string | null;
  model: string;
  namespace: string;
  /** `"partial"` means some chunks await the re-embed backfill. */
  status: "ok" | "partial";
  totalChunks: number;
  versionId: string;
}

export interface IngestRunOptions {
  config: EmbeddingWorkerConfig;
  log?: (entry: IngestLogEntry) => void;
  jobId?: string;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Any database failure rolls back the whole version swap; embedding failures
 * do not, and are reported per chunk as `status: "partial"`.
 */
export const processDocumentVersion = async (
  pool: PgPool,
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
  const { documentId, versionId } = await withTransaction(
    pool,
    async (client) => {
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
      let storedDocumentId: string;
      let documentVersion: number;
      const [documentRow] = upserted.rows;
      if (documentRow === undefined) {
        // Unchanged content: the DO UPDATE guard filtered the upsert.
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
        storedDocumentId = readRowString(row["id"], "document id");
        documentVersion = readRowVersion(row["version"], "document version");
      } else {
        storedDocumentId = readRowString(
          documentRow["id"],
          "document upsert id"
        );
        documentVersion = readRowVersion(
          documentRow["version"],
          "document upsert version"
        );
      }
      const versionInsert = buildDocumentVersionInsert({
        content_hash: contentHash,
        document_id: storedDocumentId,
        id: doc.versionId,
        version: documentVersion,
      });
      const inserted = await client.query(
        versionInsert.text,
        versionInsert.params
      );
      let storedVersionId = doc.versionId;
      const [versionRow] = inserted.rows;
      if (versionRow === undefined) {
        // Version already recorded; cite the existing row.
        const existing = buildDocumentVersionIdQuery(
          storedDocumentId,
          documentVersion
        );
        const selected = await client.query(existing.text, existing.params);
        const [row] = selected.rows;
        if (row === undefined) {
          throw new Error(
            `ingest: document ${storedDocumentId} version ${documentVersion} vanished between insert and read`
          );
        }
        storedVersionId = readRowString(row["id"], "document version id");
      }
      for (const [index, chunk] of chunks.entries()) {
        const embedding = embeddings.get(index) ?? null;
        const built = buildChunkUpsertQuery({
          anchors: chunk.anchors,
          chunkId: chunk.chunkId,
          chunkerVersion: chunk.chunkerVersion,
          contentHash: chunk.contentHash,
          documentId: storedDocumentId,
          embedding,
          embeddingModel: embedding === null ? null : config.provider.model,
          idx: chunk.idx,
          namespace: chunk.namespace,
          text: chunk.text,
          versionId: storedVersionId,
        });
        await client.query(built.text, built.params);
      }
      const supersede = buildSupersedeChunksQuery(
        storedDocumentId,
        chunks.map((chunk) => chunk.contentHash)
      );
      await client.query(supersede.text, supersede.params);
      return { documentId: storedDocumentId, versionId: storedVersionId };
    }
  );
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

/** Per-chunk embedding failures are a `partial` outcome, not a job failure. */
export const runIngestJob = async (
  pool: PgPool,
  job: IngestJobRecord,
  options: IngestRunOptions
): Promise<IngestJobResult> => {
  try {
    const doc = parseDocumentPayload(job);
    const outcome = await processDocumentVersion(pool, doc, {
      ...options,
      jobId: job.jobId,
    });
    const complete = buildCompleteJobQuery(job.jobId);
    await pool.query(complete.text, complete.params);
    return { outcome, status: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fail = buildFailJobQuery(job.jobId, message);
    await pool.query(fail.text, fail.params);
    return { error: truncateJobError(message), status: "failed" };
  }
};

export const claimIngestJob = async (
  client: PgClient
): Promise<IngestJobRecord | null> => {
  const built = buildClaimJobQuery();
  const result = await client.query(built.text, built.params);
  const [row] = result.rows;
  return row === undefined ? null : parseIngestJobRow(row);
};

/** Claims and runs jobs until the queue is empty or `maxJobs` have run. */
export const drainIngestJobs = async (
  pool: PgPool,
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
    const job = await claimIngestJob(pool);
    if (job === null) {
      break;
    }
    results.push(await runIngestJob(pool, job, options));
  }
  return results;
};
