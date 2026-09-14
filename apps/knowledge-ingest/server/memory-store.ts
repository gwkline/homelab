import {
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
  JobOutcome,
  JobPayload,
  JobState,
  SourceStatus,
} from "./store.ts";
import { SourceNotFoundError } from "./store.ts";

interface JobRow {
  attempts: number;
  availableAt: Date;
  enqueuedAt: Date;
  error: string | null;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  idempotencyKey: string;
  jobId: string;
  kind: "document" | "source_sync";
  maxAttempts: number;
  namespace: string;
  payload: JobPayload;
  priority: number;
  result: JobOutcome | null;
  sourceId: string;
  startedAt: Date | null;
  status: JobState;
  workerId: string | null;
}

interface SourceRow {
  kind: IngestSourceInput["kind"];
  namespace: string;
  path: string | null;
  ref: string | null;
  repo: string | null;
  sourceId: string;
  url: string | null;
}

interface DocumentRow {
  chunkCount: number;
  contentHash: string;
  documentId: string;
  externalId: string;
  namespace: string;
  provenance: { ingestedAt: string; ingestionEventId: string | null };
  publishedAt: Date;
  sourceId: string;
  title: string | null;
  versionId: string;
}

export interface MemoryStoreOptions {
  /** Injectable clock; defaults to the real time. Tests pin time to drive leases. */
  maxAttempts?: number;
  now?: () => Date;
}

const iso = (date: Date | null): string | null =>
  date === null ? null : date.toISOString();

const toRecord = (row: JobRow): IngestJobRecord => {
  const document =
    row.kind === "document" && row.payload.kind === "document"
      ? row.payload.document
      : null;
  return {
    attempts: row.attempts,
    chunksIngested: row.result?.chunksIngested ?? null,
    documentsIngested: row.result?.documentsIngested ?? null,
    enqueuedAt: row.enqueuedAt.toISOString(),
    error: row.error,
    finishedAt: iso(row.finishedAt),
    idempotencyKey: row.idempotencyKey,
    jobId: row.jobId,
    kind: row.kind,
    maxAttempts: row.maxAttempts,
    namespace: row.namespace,
    priority: row.priority,
    provenance: document === null ? null : { ...document.provenance },
    sourceId: row.sourceId,
    startedAt: iso(row.startedAt),
    status: row.status,
  };
};

const documentKey = (payload: DocumentPayload): string =>
  `${payload.namespace}|${payload.source.sourceId}|${payload.externalId}|${payload.version.versionId}`;

const isActive = (row: JobRow): boolean =>
  row.status === "pending" ||
  row.status === "running" ||
  row.status === "retryable";

const claimOrder = (a: JobRow, b: JobRow): number => {
  if (b.priority !== a.priority) {
    return b.priority - a.priority;
  }
  if (a.enqueuedAt.getTime() !== b.enqueuedAt.getTime()) {
    return a.enqueuedAt.getTime() - b.enqueuedAt.getTime();
  }
  return a.jobId.localeCompare(b.jobId);
};

const sourceStatus = (
  source: SourceRow,
  documents: Map<string, DocumentRow>,
  jobs: Map<string, JobRow>
): SourceStatus => {
  const sourceJobs = [...jobs.values()]
    .filter((job) => job.sourceId === source.sourceId)
    .toSorted((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime());
  const sourceDocs = [...documents.values()].filter(
    (doc) => doc.sourceId === source.sourceId
  );
  const active = sourceJobs.toReversed().find(isActive);
  const lastErrorRow = sourceJobs
    .toReversed()
    .find(
      (job) =>
        job.status === "dead" && job.error !== null && job.finishedAt !== null
    );
  const lastSync = sourceJobs
    .toReversed()
    .find((job) => job.status === "succeeded" && job.finishedAt !== null);
  return {
    chunkCount: sourceDocs.reduce((sum, doc) => sum + doc.chunkCount, 0),
    currentJob: active
      ? {
          jobId: active.jobId,
          startedAt: iso(active.startedAt),
          status: active.status,
        }
      : null,
    documentCount: sourceDocs.length,
    kind: source.kind,
    lastError: lastErrorRow
      ? {
          at: iso(lastErrorRow.finishedAt),
          message: lastErrorRow.error ?? "",
        }
      : null,
    lastSyncAt: iso(lastSync?.finishedAt ?? null),
    namespace: source.namespace,
    path: source.path,
    ref: source.ref,
    repo: source.repo,
    sourceId: source.sourceId,
    url: source.url,
  };
};

/**
 * In-process mirror of the Postgres queue semantics (same states, same claim
 * guards, same idempotency rule, same recovery). Every store operation reads
 * and mutates synchronously — under the JavaScript event loop that makes each
 * operation atomic, which is exactly the guarantee `FOR UPDATE SKIP LOCKED`
 * provides across real connections in `PgIngestStore`. Not durable: for tests
 * and local dev only.
 */
export const createMemoryIngestStore = (
  options: MemoryStoreOptions = {}
): IngestStore => {
  const documents = new Map<string, DocumentRow>();
  const jobs = new Map<string, JobRow>();
  const sources = new Map<string, SourceRow>();
  const now = options.now ?? (() => new Date());
  const defaultMaxAttempts = options.maxAttempts ?? 5;

  const upsertSource = (source: IngestSourceInput, namespace: string): void => {
    sources.set(source.sourceId, {
      kind: source.kind,
      namespace,
      path: source.path,
      ref: source.ref,
      repo: source.repo,
      sourceId: source.sourceId,
      url: source.url,
    });
  };

  const insertJob = (input: {
    idempotencyKey: string;
    kind: JobPayload["kind"];
    maxAttempts: number;
    namespace: string;
    payload: (jobId: string) => JobPayload;
    sourceId: string;
  }): JobRow => {
    const nowDate = now();
    const jobId = newJobId();
    const row: JobRow = {
      attempts: 0,
      availableAt: nowDate,
      enqueuedAt: nowDate,
      error: null,
      finishedAt: null,
      heartbeatAt: null,
      idempotencyKey: input.idempotencyKey,
      jobId,
      kind: input.kind,
      maxAttempts: input.maxAttempts,
      namespace: input.namespace,
      payload: input.payload(jobId),
      priority: 0,
      result: null,
      sourceId: input.sourceId,
      startedAt: null,
      status: "pending",
      workerId: null,
    };
    jobs.set(jobId, row);
    return row;
  };

  const store: IngestStore = {
    applySchema: () => Promise.resolve(),

    backend: "memory",

    claim(request: ClaimRequest): Promise<ClaimedJob[]> {
      const nowDate = now();
      const claimable = [...jobs.values()]
        .filter(
          (row) =>
            (row.status === "pending" || row.status === "retryable") &&
            row.availableAt.getTime() <= nowDate.getTime()
        )
        .toSorted(claimOrder)
        .slice(0, request.limit);
      const claimed: ClaimedJob[] = claimable.map((row) => {
        row.status = "running";
        row.attempts += 1;
        row.workerId = request.workerId;
        row.startedAt ??= nowDate;
        row.heartbeatAt = nowDate;
        return {
          attempts: row.attempts,
          jobId: row.jobId,
          kind: row.kind,
          maxAttempts: row.maxAttempts,
          namespace: row.namespace,
          payload: structuredClone(row.payload),
          sourceId: row.sourceId,
          startedAt: (row.startedAt ?? nowDate).toISOString(),
        };
      });
      return Promise.resolve(claimed);
    },

    complete(
      workerId: string,
      jobId: string,
      outcome: JobOutcome
    ): Promise<boolean> {
      const row = jobs.get(jobId);
      if (!row || row.status !== "running" || row.workerId !== workerId) {
        return Promise.resolve(false);
      }
      row.status = "succeeded";
      row.result = { ...outcome };
      row.error = null;
      row.finishedAt = now();
      row.workerId = null;
      return Promise.resolve(true);
    },

    enqueueIngest(request: IngestRequestInput): Promise<EnqueueResult> {
      const idempotencyKey =
        request.idempotencyKey ?? deriveIngestIdempotencyKey(request);
      for (const row of jobs.values()) {
        if (row.idempotencyKey === idempotencyKey) {
          return Promise.resolve({ duplicate: true, job: toRecord(row) });
        }
      }
      upsertSource(request.source, request.namespace);
      const row = insertJob({
        idempotencyKey,
        kind: "document",
        maxAttempts: defaultMaxAttempts,
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
      return Promise.resolve({ duplicate: false, job: toRecord(row) });
    },

    enqueueSourceSync(sourceId: string): Promise<EnqueueResult> {
      const source = sources.get(sourceId);
      if (!source) {
        throw new SourceNotFoundError(`unknown source: ${sourceId}`);
      }
      for (const row of jobs.values()) {
        if (
          row.kind === "source_sync" &&
          row.sourceId === sourceId &&
          isActive(row)
        ) {
          return Promise.resolve({ duplicate: true, job: toRecord(row) });
        }
      }
      const row = insertJob({
        idempotencyKey: newSyncIdempotencyKey(sourceId),
        kind: "source_sync",
        maxAttempts: defaultMaxAttempts,
        namespace: source.namespace,
        payload: () => ({
          kind: "source_sync",
          sync: { source: { ...source } },
        }),
        sourceId,
      });
      return Promise.resolve({ duplicate: false, job: toRecord(row) });
    },

    fail(
      workerId: string,
      jobId: string,
      error: string,
      retryDelaySeconds: number
    ): Promise<JobState | null> {
      const row = jobs.get(jobId);
      if (!row || row.status !== "running" || row.workerId !== workerId) {
        return Promise.resolve(null);
      }
      row.error = error;
      row.workerId = null;
      if (row.attempts >= row.maxAttempts) {
        row.status = "dead";
        row.finishedAt = now();
      } else {
        row.status = "retryable";
        row.availableAt = new Date(now().getTime() + retryDelaySeconds * 1000);
      }
      return Promise.resolve(row.status);
    },

    getJob(jobId: string): Promise<IngestJobRecord | null> {
      const row = jobs.get(jobId);
      return Promise.resolve(row ? toRecord(row) : null);
    },

    heartbeat(workerId: string, jobIds: string[]): Promise<void> {
      const nowDate = now();
      for (const jobId of jobIds) {
        const row = jobs.get(jobId);
        if (row && row.status === "running" && row.workerId === workerId) {
          row.heartbeatAt = nowDate;
        }
      }
      return Promise.resolve();
    },

    listSources(): Promise<SourceStatus[]> {
      const rows = [...sources.values()].toSorted((a, b) =>
        a.sourceId.localeCompare(b.sourceId)
      );
      return Promise.resolve(
        rows.map((source) => sourceStatus(source, documents, jobs))
      );
    },

    ping: () => Promise.resolve(),

    publishDocumentVersion(
      payload: DocumentPayload,
      chunkCount: number
    ): Promise<boolean> {
      const key = documentKey(payload);
      if (documents.has(key)) {
        return Promise.resolve(false);
      }
      documents.set(key, {
        chunkCount,
        contentHash: payload.contentHash,
        documentId: documentIdFor(
          payload.namespace,
          payload.source.sourceId,
          payload.externalId,
          payload.version.versionId
        ),
        externalId: payload.externalId,
        namespace: payload.namespace,
        provenance: { ...payload.provenance },
        publishedAt: now(),
        sourceId: payload.source.sourceId,
        title: payload.title,
        versionId: payload.version.versionId,
      });
      return Promise.resolve(true);
    },

    recoverStale(leaseSeconds: number): Promise<number> {
      const nowDate = now();
      const cutoff = nowDate.getTime() - leaseSeconds * 1000;
      let recovered = 0;
      for (const row of jobs.values()) {
        if (row.status !== "running" || row.heartbeatAt === null) {
          continue;
        }
        if (row.heartbeatAt.getTime() >= cutoff) {
          continue;
        }
        row.status = row.attempts >= row.maxAttempts ? "dead" : "pending";
        if (row.status === "dead") {
          row.finishedAt = nowDate;
        }
        row.workerId = null;
        row.error = STALE_RECOVERY_MESSAGE;
        row.heartbeatAt = null;
        recovered += 1;
      }
      return Promise.resolve(recovered);
    },
  };
  return store;
};
