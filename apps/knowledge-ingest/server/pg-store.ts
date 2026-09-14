/**
 * Postgres-backed `IngestStore` (#58): the durable service path. Executes the
 * queue SQL from `queue.ts` over a minimal pg-compatible client; every value
 * is a bind parameter, never interpolated. All statements are single-shot so
 * they are atomic without explicit transactions — the claim in particular is
 * one `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`.
 *
 * Row mappers throw on malformed rows instead of silently passing garbage
 * through the API (same discipline as the apps/knowledge channel mappers).
 */

import type { Pool } from "pg";

import {
  ACTIVE_SYNC_JOB_SQL,
  CLAIM_SQL,
  COMPLETE_SQL,
  ENQUEUE_JOB_SQL,
  FAIL_SQL,
  HEARTBEAT_SQL,
  INGEST_SCHEMA_SQL,
  JOB_BY_ID_SQL,
  PING_SQL,
  PUBLISH_DOCUMENT_SQL,
  RECOVER_STALE_SQL,
  SOURCE_BY_ID_SQL,
  SOURCE_LIST_SQL,
  SOURCE_UPSERT_SQL,
  STALE_RECOVERY_MESSAGE,
  deriveIngestIdempotencyKey,
  documentIdFor,
  newJobId,
  newSyncIdempotencyKey,
} from "./queue.ts";
import type {
  ClaimedJob,
  ClaimRequest,
  DocumentPayload,
  EnqueueResult,
  IngestJobRecord,
  IngestRequestInput,
  IngestSourceInput,
  IngestStore,
  JobKind,
  JobOutcome,
  JobPayload,
  JobState,
  SourceStatus,
} from "./store.ts";
import { SourceNotFoundError, StoreUnavailableError } from "./store.ts";

export interface QueueDbClient {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

const JOB_STATES_SET = new Set([
  "pending",
  "running",
  "succeeded",
  "retryable",
  "dead",
]);

const asJobKind = (value: unknown, context: string): JobKind => {
  if (value === "document" || value === "source_sync") {
    return value;
  }
  throw new TypeError(`pg-store: ${context} has invalid kind ${String(value)}`);
};

const asCount = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const asTimestamp = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : null;
};

const asState = (value: unknown, context: string): JobState => {
  if (typeof value === "string" && JOB_STATES_SET.has(value)) {
    return value as JobState;
  }
  throw new TypeError(
    `pg-store: ${context} has invalid state ${String(value)}`
  );
};

/** Document jobs carry the resolved #56 provenance inside their payload. */
const provenanceOf = (
  row: Record<string, unknown>
): IngestJobRecord["provenance"] => {
  const payload: unknown = row["payload"];
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const { document } = payload as { document?: { provenance?: unknown } };
  const rawProvenance = document?.provenance;
  if (rawProvenance === null || typeof rawProvenance !== "object") {
    return null;
  }
  const rec = rawProvenance as Record<string, unknown>;
  const { ingestedAt } = rec;
  if (typeof ingestedAt !== "string") {
    return null;
  }
  const eventId = rec["ingestionEventId"];
  return {
    ingestedAt,
    ingestionEventId:
      eventId === null || eventId === undefined ? null : String(eventId),
  };
};

const outcomeOf = (row: Record<string, unknown>): JobOutcome | null => {
  const result: unknown = row["result"];
  if (result === null || typeof result !== "object") {
    return null;
  }
  const partial = result as Partial<JobOutcome>;
  return {
    chunksIngested: asCount(partial.chunksIngested) ?? 0,
    documentsIngested: asCount(partial.documentsIngested) ?? 0,
  };
};

const record = (
  row: Record<string, unknown>,
  context: string
): IngestJobRecord => {
  const { id: jobId } = row;
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new TypeError(`pg-store: ${context} has no id`);
  }
  const { namespace, source_id: sourceId } = row;
  if (typeof sourceId !== "string" || typeof namespace !== "string") {
    throw new TypeError(`pg-store: ${jobId} is missing identity columns`);
  }
  const { error } = row;
  const kind = asJobKind(row["kind"], jobId);
  const outcome = outcomeOf(row);
  const provenance = kind === "document" ? provenanceOf(row) : null;
  return {
    attempts: Number(row["attempts"] ?? 0),
    chunksIngested: asCount(outcome?.chunksIngested ?? null),
    documentsIngested: asCount(outcome?.documentsIngested ?? null),
    enqueuedAt: asTimestamp(row["enqueued_at"]) ?? "",
    error: error === null || error === undefined ? null : String(error),
    finishedAt: asTimestamp(row["finished_at"]),
    idempotencyKey: String(row["idempotency_key"] ?? ""),
    jobId,
    kind,
    maxAttempts: Number(row["max_attempts"] ?? 5),
    namespace,
    priority: Number(row["priority"] ?? 0),
    provenance,
    sourceId,
    startedAt: asTimestamp(row["started_at"]),
    status: asState(row["status"], jobId),
  };
};

const parseClaimedRow = (
  row: Record<string, unknown>,
  index: number
): ClaimedJob => {
  const context = `claim row ${index}`;
  const jobId = row["id"];
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new TypeError(`pg-store: ${context} has no id`);
  }
  const payload: unknown = row["payload"];
  if (payload === null || typeof payload !== "object") {
    throw new TypeError(`pg-store: ${jobId} has a malformed payload`);
  }
  return {
    attempts: Number(row["attempts"] ?? 0),
    jobId,
    kind: asJobKind(row["kind"], jobId),
    maxAttempts: Number(row["max_attempts"] ?? 5),
    namespace: String(row["namespace"] ?? ""),
    payload: payload as JobPayload,
    sourceId: String(row["source_id"] ?? ""),
    startedAt: asTimestamp(row["started_at"]) ?? "",
  };
};

export class PgIngestStore implements IngestStore {
  readonly backend = "postgres" as const;

  private readonly client: QueueDbClient;
  private readonly defaultMaxAttempts: number;

  constructor(
    client: QueueDbClient,
    options: { defaultMaxAttempts?: number } = {}
  ) {
    this.client = client;
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? 5;
  }

  /** Idempotent DDL for the queue tables (see `queue.ts` for the layout). */
  async applySchema(): Promise<void> {
    await this.client.query(INGEST_SCHEMA_SQL, []);
  }

  async ping(): Promise<void> {
    try {
      await this.client.query(PING_SQL, []);
    } catch (error) {
      throw new StoreUnavailableError(
        `ingest store unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  async enqueueIngest(request: IngestRequestInput): Promise<EnqueueResult> {
    await this.upsertSource(request.source, request.namespace);
    return await this.enqueueJob({
      idempotencyKey:
        request.idempotencyKey ?? deriveIngestIdempotencyKey(request),
      kind: "document",
      namespace: request.namespace,
      payload: (jobId) => ({
        document: {
          contentHash: request.contentHash,
          externalId: request.externalId,
          namespace: request.namespace,
          provenance: {
            ingestedAt: request.provenance.ingestedAt,
            ingestionEventId: request.provenance.ingestionEventId ?? jobId,
          },
          source: { ...request.source },
          tags: [...request.tags],
          title: request.title,
          version: { ...request.version },
        },
        kind: "document",
      }),
      sourceId: request.source.sourceId,
    });
  }

  async enqueueSourceSync(sourceId: string): Promise<EnqueueResult> {
    const existing = await this.client.query(SOURCE_BY_ID_SQL, [sourceId]);
    const [sourceRow] = existing.rows;
    if (!sourceRow) {
      throw new SourceNotFoundError(`unknown source: ${sourceId}`);
    }
    const active = await this.client.query(ACTIVE_SYNC_JOB_SQL, [sourceId]);
    const [activeRow] = active.rows;
    if (activeRow) {
      return { duplicate: true, job: record(activeRow, "active sync job") };
    }
    const source: IngestSourceInput = {
      kind: (sourceRow["kind"] ?? "url") as IngestSourceInput["kind"],
      path: (sourceRow["path"] ?? null) as string | null,
      ref: (sourceRow["ref"] ?? null) as string | null,
      repo: (sourceRow["repo"] ?? null) as string | null,
      sourceId,
      url: (sourceRow["url"] ?? null) as string | null,
    };
    return await this.enqueueJob({
      idempotencyKey: newSyncIdempotencyKey(sourceId),
      kind: "source_sync",
      namespace: String(sourceRow["namespace"] ?? "default"),
      payload: () => ({ kind: "source_sync", sync: { source } }),
      sourceId,
    });
  }

  private async upsertSource(
    source: IngestSourceInput,
    namespace: string
  ): Promise<void> {
    await this.client.query(SOURCE_UPSERT_SQL, [
      source.sourceId,
      source.kind,
      namespace,
      source.repo,
      source.ref,
      source.url,
      source.path,
    ]);
  }

  private async enqueueJob(input: {
    idempotencyKey: string;
    kind: JobKind;
    namespace: string;
    payload: (jobId: string) => JobPayload;
    sourceId: string;
  }): Promise<EnqueueResult> {
    const jobId = newJobId();
    const { rows } = await this.client.query(ENQUEUE_JOB_SQL, [
      jobId,
      input.kind,
      input.idempotencyKey,
      input.sourceId,
      input.namespace,
      JSON.stringify(input.payload(jobId)),
      0,
      this.defaultMaxAttempts,
    ]);
    const [row] = rows;
    if (!row) {
      throw new StoreUnavailableError(
        `ingest job insert returned no row for idempotency key ${JSON.stringify(
          input.idempotencyKey
        )}`
      );
    }
    return {
      duplicate: row["duplicate"] === true,
      job: record(row, "enqueue"),
    };
  }

  async getJob(jobId: string): Promise<IngestJobRecord | null> {
    const { rows } = await this.client.query(JOB_BY_ID_SQL, [jobId]);
    const [row] = rows;
    return row ? record(row, jobId) : null;
  }

  async listSources(): Promise<SourceStatus[]> {
    const { rows } = await this.client.query(SOURCE_LIST_SQL, []);
    return rows.map((row, index) => {
      const context = `source row ${index}`;
      const sourceId = row["source_id"];
      if (typeof sourceId !== "string") {
        throw new TypeError(`pg-store: ${context} has no source_id`);
      }
      const lastError: unknown = row["last_error"];
      const currentJob: unknown = row["current_job"];
      const errRec =
        lastError !== null && typeof lastError === "object"
          ? (lastError as Record<string, unknown>)
          : null;
      const jobRec =
        currentJob !== null && typeof currentJob === "object"
          ? (currentJob as Record<string, unknown>)
          : null;
      const currentJobId = jobRec?.["jobId"];
      return {
        chunkCount: asCount(row["chunk_count"]) ?? 0,
        currentJob:
          jobRec === null || typeof currentJobId !== "string"
            ? null
            : {
                jobId: currentJobId,
                startedAt: asTimestamp(jobRec["startedAt"]),
                status: String(jobRec["status"] ?? "unknown"),
              },
        documentCount: asCount(row["document_count"]) ?? 0,
        kind: String(row["kind"] ?? "unknown"),
        lastError:
          errRec === null || typeof errRec["message"] !== "string"
            ? null
            : {
                at: asTimestamp(errRec["at"]),
                message: errRec["message"],
              },
        lastSyncAt: asTimestamp(row["last_sync_at"]),
        namespace: String(row["namespace"] ?? "default"),
        path: (row["path"] ?? null) as string | null,
        ref: (row["ref"] ?? null) as string | null,
        repo: (row["repo"] ?? null) as string | null,
        sourceId,
        url: (row["url"] ?? null) as string | null,
      };
    });
  }

  async recoverStale(leaseSeconds: number): Promise<number> {
    const { rows } = await this.client.query(RECOVER_STALE_SQL, [
      leaseSeconds,
      STALE_RECOVERY_MESSAGE,
    ]);
    return rows.length;
  }

  async claim(request: ClaimRequest): Promise<ClaimedJob[]> {
    const { rows } = await this.client.query(CLAIM_SQL, [
      request.workerId,
      request.limit,
    ]);
    return rows.map(parseClaimedRow);
  }

  async heartbeat(workerId: string, jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) {
      return;
    }
    await this.client.query(HEARTBEAT_SQL, [jobIds, workerId]);
  }

  async complete(
    workerId: string,
    jobId: string,
    outcome: JobOutcome
  ): Promise<boolean> {
    const { rows } = await this.client.query(COMPLETE_SQL, [
      jobId,
      JSON.stringify(outcome),
      workerId,
    ]);
    return rows.length > 0;
  }

  async fail(
    workerId: string,
    jobId: string,
    error: string,
    retryDelaySeconds: number
  ): Promise<JobState | null> {
    const { rows } = await this.client.query(FAIL_SQL, [
      jobId,
      error,
      retryDelaySeconds,
      workerId,
    ]);
    const [row] = rows;
    return row ? asState(row["status"], jobId) : null;
  }

  async publishDocumentVersion(
    payload: DocumentPayload,
    chunkCount: number
  ): Promise<boolean> {
    const { rows } = await this.client.query(PUBLISH_DOCUMENT_SQL, [
      documentIdFor(
        payload.namespace,
        payload.source.sourceId,
        payload.externalId,
        payload.version.versionId
      ),
      payload.namespace,
      payload.source.sourceId,
      payload.externalId,
      payload.version.versionId,
      payload.contentHash,
      payload.title,
      payload.version.commit,
      chunkCount,
      JSON.stringify(payload.provenance),
    ]);
    return rows.length > 0;
  }
}

/** Open a pg Pool for the store (kept separate so tests can inject stubs). */
export const createPgPool = async (connectionString: string): Promise<Pool> => {
  const { default: pg } = await import("pg");
  return new pg.Pool({ connectionString });
};
