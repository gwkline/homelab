import { z } from "@hono/zod-openapi";

import { JOB_KINDS, JOB_STATES } from "./queue.ts";

// ── shared patterns (kept identical to the panel's pinned knowledge API) ──

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const IDEMPOTENCY_KEY_PATTERN = /^[\w.:-]{8,200}$/u;
export const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const CONTENT_HASH_LENGTH = 64;

// ── error envelope (same shape as apps/knowledge-retrieval) ──

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "internal_error"
  | "store_unavailable";

export const errorSchema = z
  .object({
    error: z.object({
      code: z.enum([
        "invalid_request",
        "unauthorized",
        "not_found",
        "internal_error",
        "store_unavailable",
      ]),
      message: z.string(),
      runId: z.string().nullable(),
    }),
  })
  .describe(
    "Consistent error envelope; runId correlates with the request log line."
  );

export const errorBody = (
  code: ApiErrorCode,
  message: string,
  runId: string | null
): z.infer<typeof errorSchema> => ({ error: { code, message, runId } });

// ── ingest request (#58: source, namespace, external id, version/content
// identifier, and the #56 provenance block) ──

const sourceKindSchema = z
  .enum(["github", "file", "url", "web"])
  .describe("Origin system of the source.");

export const ingestRequestSchema = z.object({
  contentHash: z
    .string()
    .regex(CONTENT_HASH_PATTERN)
    .describe(
      "sha256 hex digest of the extracted content — the content identifier that makes re-ingest idempotent."
    ),
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .describe(
      "Stable external identity of the document inside the source (path, canonical URL, note slug)."
    ),
  idempotencyKey: z
    .string()
    .regex(IDEMPOTENCY_KEY_PATTERN)
    .optional()
    .describe(
      "Client-supplied dedupe key. Defaults to a digest of (source, namespace, externalId, versionId, contentHash) so the same source event/version never enqueues twice."
    ),
  namespace: z
    .string()
    .regex(NAMESPACE_PATTERN)
    .describe("Namespace/collection the document belongs to (ADR-002 D9)."),
  provenance: z
    .object({
      ingestedAt: z.iso
        .datetime({ offset: true })
        .optional()
        .describe(
          "When the producing source event ran (ISO-8601); defaults to server receive time."
        ),
      ingestionEventId: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Client's ingestion event id; defaults to the job id."),
    })
    .optional()
    .describe("Provenance metadata recorded with the document version (#56)."),
  source: z.object({
    kind: sourceKindSchema,
    path: z
      .string()
      .max(1024)
      .nullish()
      .describe("Source-relative path; null when meaningless."),
    ref: z
      .string()
      .max(256)
      .nullish()
      .describe("Branch/tag/ref for repository sources; null otherwise."),
    repo: z
      .string()
      .max(256)
      .nullish()
      .describe(
        "Repository (owner/name) for repository sources; null otherwise."
      ),
    sourceId: z
      .string()
      .regex(SOURCE_ID_PATTERN)
      .describe("Stable source identity, independent of document versions."),
    url: z
      .url()
      .max(2048)
      .nullish()
      .describe("Resolvable source URL; null when the source has none."),
  }),
  tags: z
    .array(z.string().min(1).max(64))
    .max(20)
    .optional()
    .describe("Free-form tags carried onto the document version."),
  title: z.string().min(1).max(512).optional(),
  version: z
    .object({
      commit: z
        .string()
        .max(256)
        .nullish()
        .describe(
          "Source commit this version was produced from; null when the source has none."
        ),
      versionId: z
        .string()
        .min(1)
        .max(256)
        .describe("Source-side version identifier; bump on content change."),
    })
    .describe("Content/version identifier of the ingested document."),
});

export type IngestRequestBody = z.infer<typeof ingestRequestSchema>;

const provenanceResponseSchema = z.object({
  ingestedAt: z.string(),
  ingestionEventId: z.string().nullable(),
});

const jobResponseSchema = z
  .object({
    attempts: z.number().int().min(0),
    chunksIngested: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Chunk count reported by the worker; null until succeeded."),
    documentsIngested: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe("Document versions published; null until succeeded."),
    duplicate: z
      .boolean()
      .optional()
      .describe(
        "Present on enqueue responses: true when an existing job matched the idempotency key."
      ),
    enqueuedAt: z.string(),
    error: z.string().nullable(),
    finishedAt: z.string().nullable(),
    jobId: z.string(),
    kind: z.enum(JOB_KINDS),
    maxAttempts: z.number().int().min(1),
    namespace: z.string(),
    priority: z.number().int(),
    provenance: provenanceResponseSchema
      .nullable()
      .describe("Resolved #56 provenance block; null for source_sync jobs."),
    sourceId: z.string(),
    startedAt: z.string().nullable(),
    status: z.enum(JOB_STATES),
  })
  .describe(
    "Ingestion job record. States: pending, running, succeeded, retryable, dead."
  );

export const ingestResponseSchema = jobResponseSchema.describe(
  "202 with a fresh job, or 200 with the pre-existing job when the idempotency key matched."
);

export const syncJobResponseSchema = jobResponseSchema;

export const syncTriggerResponseSchema = jobResponseSchema.describe(
  "202 with a fresh sync job, or 200 with the already-active sync job for the source."
);

const sourceStatusSchema = z.object({
  chunkCount: z.number().int().min(0),
  currentJob: z
    .object({
      jobId: z.string(),
      startedAt: z.string().nullable(),
      status: z.string(),
    })
    .nullable(),
  documentCount: z.number().int().min(0),
  kind: z.string(),
  lastError: z
    .object({
      at: z.string().nullable(),
      message: z.string(),
    })
    .nullable(),
  lastSyncAt: z.string().nullable(),
  namespace: z.string(),
  path: z.string().nullable(),
  ref: z.string().nullable(),
  repo: z.string().nullable(),
  sourceId: z.string(),
  url: z.string().nullable(),
});

export const sourcesResponseSchema = z.object({
  sources: z.array(sourceStatusSchema).describe("Registered sources."),
});

export const readinessSchema = z
  .object({
    backend: z.enum(["memory", "postgres"]),
    checks: z.object({
      database: z.enum(["up", "down"]),
    }),
    status: z.enum(["ok", "unavailable"]),
  })
  .describe(
    "Readiness: 200 only when the backing store answers; the check name distinguishes database unavailability."
  );
