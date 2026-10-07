// Storage contract for the ingestion queue: one Postgres `ingest_job` table
// claimed with `FOR UPDATE SKIP LOCKED` (ADR-002 D5). The memory store
// mirrors the semantics for tests and DB-less dev.

export type JobState =
  | "pending"
  | "running"
  | "succeeded"
  | "retryable"
  | "dead";

export type JobKind = "document" | "document-version" | "source_sync";

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

/**
 * A document version with inline content, as emitted by git-source and
 * consumed by `parseDocumentVersionPayload`. Provenance is kept for audit, never logged.
 */
export interface DocumentVersionPayload {
  content: string;
  documentId: string;
  externalId: string;
  /** Chunker format: `"markdown" | "code" | "text"`. */
  format?: string;
  namespace: string;
  /** Source provenance (repository, commit, blob hashes, path, lineage). */
  provenance: Record<string, unknown> | null;
  /** Source kind label persisted on the document row, e.g. `"git"`. */
  source: string;
  title?: string | null;
  url?: string | null;
  versionId: string;
}

export type JobPayload =
  | { document: DocumentPayload; kind: "document" }
  | { documentVersion: DocumentVersionPayload; kind: "document-version" }
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
  /** Resolved provenance for document jobs; null for source_sync jobs. */
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

export { StoreUnavailableError } from "../../knowledge/src/store-errors.ts";

export class SourceNotFoundError extends Error {
  override name = "SourceNotFoundError";
}

export interface IngestStore {
  readonly backend: "memory" | "postgres";
  /**
   * Fail a claimed attempt. Returns `retryable` or `dead`, or null when the
   * claim was lost to stale recovery.
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
  /**
   * Enqueue one inline-content document version. Idempotent on
   * (documentId, versionId, content), so a retried sync returns the original job.
   */
  enqueueDocumentVersion: (
    payload: DocumentVersionPayload,
    sourceId: string
  ) => Promise<EnqueueResult>;
  getJob: (jobId: string) => Promise<IngestJobRecord | null>;
  listSources: () => Promise<SourceStatus[]>;
  /**
   * Publish a version keyed by (namespace, source_id, external_id, version_id).
   * False when it already existed, which keeps stale-claim recovery from
   * double-publishing.
   */
  publishDocumentVersion: (
    payload: DocumentPayload,
    chunkCount: number
  ) => Promise<boolean>;
  /** Readiness probe; must throw (fast) when the backing store is unusable. */
  ping: () => Promise<void>;
  /**
   * Delete finished jobs older than `retentionDays`, keeping each source's
   * latest succeeded and dead job. Returns the number deleted.
   */
  pruneFinished: (retentionDays: number) => Promise<number>;
}
