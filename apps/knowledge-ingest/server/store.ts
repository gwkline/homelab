// Domain types and the storage contract for the knowledge ingestion queue
// (#58). The queue is Postgres-native (ADR-002 D5): one `ingest_job` table
// claimed with `FOR UPDATE SKIP LOCKED`, no Redis or external broker.
//
// Two stores implement `IngestStore`:
//   - `PgIngestStore` (pg-store.ts): the durable service path.
//   - `MemoryIngestStore` (memory-store.ts): identical semantics in-process
//     for offline tests and local dev; jobs are not durable there.

export type JobState =
  | "pending"
  | "running"
  | "succeeded"
  | "retryable"
  | "dead";

export type JobKind = "document" | "source_sync";

export type SourceKind = "github" | "file" | "url" | "web";

export interface IngestProvenance {
  ingestedAt: string;
  ingestionEventId: string | null;
}

export interface IngestSourceInput {
  kind: SourceKind;
  path: string | null;
  ref: string | null;
  repo: string | null;
  sourceId: string;
  url: string | null;
}

export interface IngestRequestInput {
  contentHash: string;
  externalId: string;
  idempotencyKey: string | null;
  namespace: string;
  provenance: IngestProvenance;
  source: IngestSourceInput;
  tags: string[];
  title: string | null;
  version: { commit: string | null; versionId: string };
}

export interface DocumentPayload {
  contentHash: string;
  externalId: string;
  namespace: string;
  provenance: IngestProvenance;
  source: IngestSourceInput;
  tags: string[];
  title: string | null;
  version: { commit: string | null; versionId: string };
}

export interface SourceSyncPayload {
  source: IngestSourceInput;
}

export type JobPayload =
  | { document: DocumentPayload; kind: "document" }
  | { kind: "source_sync"; sync: SourceSyncPayload };

export interface IngestJobRecord {
  attempts: number;
  chunksIngested: number | null;
  documentsIngested: number | null;
  enqueuedAt: string;
  error: string | null;
  finishedAt: string | null;
  idempotencyKey: string;
  jobId: string;
  kind: JobKind;
  maxAttempts: number;
  namespace: string;
  priority: number;
  /** Resolved #56 provenance for document jobs; null for source_sync jobs. */
  provenance: IngestProvenance | null;
  sourceId: string;
  startedAt: string | null;
  status: JobState;
}

export interface ClaimedJob {
  attempts: number;
  jobId: string;
  kind: JobKind;
  maxAttempts: number;
  namespace: string;
  payload: JobPayload;
  sourceId: string;
  startedAt: string;
}

export interface ClaimRequest {
  limit: number;
  workerId: string;
}

export interface EnqueueResult {
  duplicate: boolean;
  job: IngestJobRecord;
}

export interface SourceStatus {
  chunkCount: number;
  currentJob: {
    jobId: string;
    startedAt: string | null;
    status: string;
  } | null;
  documentCount: number;
  kind: string;
  lastError: { at: string | null; message: string } | null;
  lastSyncAt: string | null;
  namespace: string;
  path: string | null;
  ref: string | null;
  repo: string | null;
  sourceId: string;
  url: string | null;
}

export interface JobOutcome {
  chunksIngested: number;
  documentsIngested: number;
}

export class StoreUnavailableError extends Error {
  override name = "StoreUnavailableError";
}

export class SourceNotFoundError extends Error {
  override name = "SourceNotFoundError";
}

export interface IngestStore {
  readonly backend: "memory" | "postgres";
  /** Idempotent DDL (no-op for the memory store). */
  applySchema: () => Promise<void>;
  /**
   * Fail a claimed attempt. Returns the resulting state (`retryable` while
   * attempts remain, `dead` once exhausted) or null when the caller no
   * longer owns the claim (recovered by another worker meanwhile).
   */
  fail: (
    workerId: string,
    jobId: string,
    error: string,
    retryDelaySeconds: number
  ) => Promise<JobState | null>;
  /** Mark a claimed job succeeded. False when the claim was lost meanwhile. */
  complete: (
    workerId: string,
    jobId: string,
    outcome: JobOutcome
  ) => Promise<boolean>;
  /** Renew the lease on in-flight jobs owned by `workerId`. */
  heartbeat: (workerId: string, jobIds: string[]) => Promise<void>;
  /** Atomically claim up to `limit` claimable jobs for `workerId`. */
  claim: (request: ClaimRequest) => Promise<ClaimedJob[]>;
  /** Reset `running` jobs whose lease expired; dead-letter exhausted ones. */
  recoverStale: (leaseSeconds: number) => Promise<number>;
  /** Enqueue one document-ingest event; duplicate = an existing job matched the idempotency key. */
  enqueueIngest: (request: IngestRequestInput) => Promise<EnqueueResult>;
  /** Enqueue a source resync; throws SourceNotFoundError for unknown sources. */
  enqueueSourceSync: (sourceId: string) => Promise<EnqueueResult>;
  getJob: (jobId: string) => Promise<IngestJobRecord | null>;
  listSources: () => Promise<SourceStatus[]>;
  /**
   * Idempotent publish of a document version keyed by
   * (namespace, source_id, external_id, version_id). Returns true when a new
   * version row was created, false when the version already existed — the
   * property that makes stale-claim recovery safe against double-publishing.
   */
  publishDocumentVersion: (
    payload: DocumentPayload,
    chunkCount: number
  ) => Promise<boolean>;
  /** Readiness probe; must throw (fast) when the backing store is unusable. */
  ping: () => Promise<void>;
}
