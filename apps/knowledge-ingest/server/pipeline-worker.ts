/**
 * Ingest pipeline handler, routed by job kind:
 * - `document-version`: content is inline; chunk → embed → upsert.
 * - `document`: identity only; fetch by source kind (git blob or HTTP) and
 *   verify sha256 against `contentHash` so a stale event fails loudly.
 * - `source_sync`: `github` sources run an incremental git sync that enqueues
 *   one `document-version` job per change; other kinds have no crawler.
 *
 * Leases, retries, and dead-lettering live in worker.ts. Bodies never reach
 * logs.
 */

import { createHash } from "node:crypto";

import { chunkDocumentVersion } from "../../knowledge/src/chunk.ts";
import type { ChunkFormat } from "../../knowledge/src/chunk.ts";
import { classifyContent } from "../../knowledge/src/git-source.ts";
import type { GitSyncReport } from "../../knowledge/src/git-source.ts";
import { readGitHubBlob } from "./git-fetch.ts";
import { syncGitSourceDocuments } from "./git-sync.ts";
import type { GitManifestStore } from "./git-sync.ts";
import type { Logger } from "./log.ts";
import {
  DEFAULT_SOURCE_URL_PREFIXES,
  isAllowedSourceUrl,
  sourceUrlPrefixesFromEnv,
} from "./source-url.ts";
import type {
  ClaimedJob,
  DocumentPayload,
  DocumentVersionPayload,
  IngestSourceInput,
  IngestStore,
} from "./store.ts";
import type { JobHandler } from "./worker.ts";

/** sha256 hex of the extracted text. */
export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf-8").digest("hex");

export const DEFAULT_MAX_CONTENT_BYTES = 1_048_576;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

export interface PipelineConfig {
  /** Extracted-text cap for fetched content; larger bodies fail the job. */
  maxContentBytes: number;
  /** Per-request timeout for url/web fetches. */
  fetchTimeoutMs: number;
  /**
   * Prefixes every cloned or fetched URL must match. Checked again here
   * because stored sources predate the API check.
   */
  sourceUrlPrefixes: readonly string[];
}

const positiveIntOr = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Math.trunc(Number(raw));
  return Number.isInteger(value) && value > 0 ? value : Number.NaN;
};

export const pipelineConfigFromEnv = (
  env: Record<string, string | undefined>
): PipelineConfig => {
  const maxContentBytes = positiveIntOr(
    env,
    "KNOWLEDGE_INGEST_MAX_CONTENT_BYTES",
    DEFAULT_MAX_CONTENT_BYTES
  );
  const fetchTimeoutMs = positiveIntOr(
    env,
    "KNOWLEDGE_INGEST_FETCH_TIMEOUT_MS",
    DEFAULT_FETCH_TIMEOUT_MS
  );
  if (!Number.isInteger(maxContentBytes)) {
    throw new TypeError(
      `KNOWLEDGE_INGEST_MAX_CONTENT_BYTES must be a positive integer, got ${JSON.stringify(
        env.KNOWLEDGE_INGEST_MAX_CONTENT_BYTES
      )}`
    );
  }
  if (!Number.isInteger(fetchTimeoutMs)) {
    throw new TypeError(
      `KNOWLEDGE_INGEST_FETCH_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(
        env.KNOWLEDGE_INGEST_FETCH_TIMEOUT_MS
      )}`
    );
  }
  return {
    fetchTimeoutMs,
    maxContentBytes,
    sourceUrlPrefixes: sourceUrlPrefixesFromEnv(env),
  };
};

/** The normalized document the sink ingests. */
export interface PipelineDocument {
  content: string;
  documentId: string;
  externalId: string;
  format: ChunkFormat;
  namespace: string;
  /** Source kind label persisted on the document row, e.g. `"git"`. */
  source: string;
  title: string | null;
  url: string | null;
  versionId: string;
}

export interface PipelineSinkOutcome {
  /** Chunks persisted (embedded or queued for the re-embed backfill). */
  chunks: number;
  status: "ok" | "partial";
}

/**
 * Persistence boundary: chunk → embed → upsert. Tombstoned documents stop
 * serving immediately; hard delete is a separate GC job (ADR-002 D10).
 */
export interface PipelineSink {
  processDocumentVersion: (
    doc: PipelineDocument
  ) => Promise<PipelineSinkOutcome>;
  tombstoneDocument: (documentId: string) => Promise<void>;
}

export interface PipelineDeps {
  config?: PipelineConfig;
  fetchImpl?: typeof fetch;
  /** Injectable git sync for tests; default is the real clone/fetch sync. */
  gitSync?: Parameters<typeof syncGitSourceDocuments>[0]["gitSync"];
  logger?: Logger;
  manifests: GitManifestStore;
  sink: PipelineSink;
  store: IngestStore;
}

const FORMATS: ReadonlySet<string> = new Set(["markdown", "code", "text"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Required non-empty string field of a `document-version` payload. */
const requiredString = (
  payload: Record<string, unknown>,
  key: string,
  jobId: string
): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `pipeline: job ${jobId} documentVersion has no string ${key}`
    );
  }
  return value;
};

/** Optional chunk-format field of a `document-version` payload. */
const optionalFormat = (
  payload: Record<string, unknown>,
  jobId: string
): ChunkFormat | undefined => {
  const { format } = payload;
  if (format === undefined) {
    return undefined;
  }
  if (!FORMATS.has(String(format))) {
    throw new TypeError(
      `pipeline: job ${jobId} documentVersion format ${JSON.stringify(
        format
      )} is not a chunk format`
    );
  }
  return format as ChunkFormat;
};

/** Optional string-or-null field; preserves absent (`undefined`) vs explicit `null`. */
const optionalString = (
  payload: Record<string, unknown>,
  key: string,
  jobId: string
): string | null | undefined => {
  const value = payload[key];
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `pipeline: job ${jobId} documentVersion ${key} must be a string or null`
    );
  }
  return value;
};

/** Optional provenance object (or null) of a `document-version` payload. */
const optionalRecord = (
  payload: Record<string, unknown>,
  key: string,
  jobId: string
): Record<string, unknown> | null => {
  const value = payload[key];
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new TypeError(
      `pipeline: job ${jobId} documentVersion ${key} must be an object or null`
    );
  }
  return value;
};

const stringOr = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Validate a `document-version` payload, throwing on malformed input. */
export const parseDocumentVersionPayload = (
  payload: unknown,
  jobId: string
): Omit<DocumentVersionPayload, "format"> & { format?: ChunkFormat } => {
  if (!isRecord(payload)) {
    throw new TypeError(
      `pipeline: job ${jobId} documentVersion payload is not an object`
    );
  }
  const content = requiredString(payload, "content", jobId);
  const documentId = requiredString(payload, "documentId", jobId);
  const externalId = requiredString(payload, "externalId", jobId);
  const namespace = requiredString(payload, "namespace", jobId);
  const source = requiredString(payload, "source", jobId);
  const versionId = requiredString(payload, "versionId", jobId);
  const format = optionalFormat(payload, jobId);
  const title = optionalString(payload, "title", jobId);
  const url = optionalString(payload, "url", jobId);
  const provenance = optionalRecord(payload, "provenance", jobId);
  return {
    content,
    documentId,
    externalId,
    ...(format === undefined ? {} : { format }),
    namespace,
    provenance,
    source,
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    versionId,
  };
};

/** String field from provenance (git-source records `commitSha`/`ref`). */
const provenanceString = (
  payload: DocumentVersionPayload,
  key: string
): string | null =>
  payload.provenance === null ? null : stringOr(payload.provenance[key]);

/** Map a document source label onto the ledger's source kinds. */
const ledgerSourceKind = (sourceLabel: string): IngestSourceInput["kind"] => {
  if (sourceLabel === "git") {
    return "github";
  }
  if (
    sourceLabel === "file" ||
    sourceLabel === "url" ||
    sourceLabel === "web"
  ) {
    return sourceLabel;
  }
  return "url";
};

const tooLarge = (bytes: number, cap: number): Error =>
  new Error(
    `pipeline: fetched body is ${bytes}+ bytes, above the ${cap} byte cap`
  );

/** Reads at most `cap` bytes, cancelling the stream as soon as it runs over. */
const readCapped = async (
  response: Response,
  cap: number
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel();
    throw tooLarge(declared, cap);
  }
  if (response.body === null) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Leaving the loop early cancels the stream, so the rest is never read.
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > cap) {
      throw tooLarge(total, cap);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};

/** Fetch url/web content, capped at `maxContentBytes`; the caller verifies the hash. */
const fetchText = async (
  url: string,
  config: PipelineConfig,
  fetchImpl: typeof fetch
): Promise<string> => {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/plain;q=0.9, text/*;q=0.8, */*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    });
  } catch (error) {
    throw new Error(
      `pipeline: fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new Error(`pipeline: fetch returned HTTP ${response.status}`);
  }
  const body = await readCapped(response, config.maxContentBytes);
  return new TextDecoder("utf-8").decode(body);
};

const formatFor = (pathish: string): ChunkFormat =>
  classifyContent(pathish).contentKind;

export const createPipelineHandler = (deps: PipelineDeps): JobHandler => {
  const config = deps.config ?? {
    fetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
    maxContentBytes: DEFAULT_MAX_CONTENT_BYTES,
    sourceUrlPrefixes: DEFAULT_SOURCE_URL_PREFIXES,
  };
  const allowedUrl = (url: string, jobId: string): string => {
    if (!isAllowedSourceUrl(url, config.sourceUrlPrefixes)) {
      throw new Error(
        `pipeline: job ${jobId} source url is not under an allowed https prefix`
      );
    }
    return url;
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.logger;

  const ingest = async (
    doc: PipelineDocument,
    job: ClaimedJob,
    ledger: DocumentPayload
  ): Promise<{ chunksIngested: number; documentsIngested: number }> => {
    const outcome = await deps.sink.processDocumentVersion(doc);
    await deps.store.publishDocumentVersion(ledger, outcome.chunks);
    log?.info("pipeline ingested", {
      chunks: outcome.chunks,
      documentId: doc.documentId,
      jobId: job.jobId,
      kind: job.kind,
      namespace: doc.namespace,
      status: outcome.status,
      versionId: doc.versionId,
    });
    return { chunksIngested: outcome.chunks, documentsIngested: 1 };
  };

  const handleDocumentVersion = async (
    job: ClaimedJob
  ): Promise<{ chunksIngested: number; documentsIngested: number }> => {
    if (job.payload.kind !== "document-version") {
      throw new Error("pipeline: expected a document-version payload");
    }
    const payload = parseDocumentVersionPayload(
      job.payload.documentVersion,
      job.jobId
    );
    const doc: PipelineDocument = {
      content: payload.content,
      documentId: payload.documentId,
      externalId: payload.externalId,
      format:
        payload.format === undefined
          ? formatFor(payload.externalId)
          : payload.format,
      namespace: payload.namespace,
      source: payload.source,
      title: payload.title ?? null,
      url: payload.url ?? null,
      versionId: payload.versionId,
    };
    return await ingest(doc, job, {
      contentHash: sha256Hex(payload.content),
      externalId: payload.externalId,
      namespace: payload.namespace,
      provenance: {
        ingestedAt: new Date().toISOString(),
        ingestionEventId: job.jobId,
      },
      source: {
        kind: ledgerSourceKind(payload.source),
        path: payload.externalId,
        ref: provenanceString(payload, "ref"),
        repo: null,
        sourceId: job.sourceId,
        url: payload.url ?? null,
      },
      tags: [],
      title: payload.title ?? null,
      version: {
        commit: provenanceString(payload, "commitSha"),
        versionId: payload.versionId,
      },
    });
  };

  const handleDocument = async (
    job: ClaimedJob
  ): Promise<{ chunksIngested: number; documentsIngested: number }> => {
    if (job.payload.kind !== "document") {
      throw new Error("pipeline: expected a document payload");
    }
    const payload = job.payload.document;
    const { source } = payload;
    let content: string;
    let documentId: string;
    if (source.kind === "github") {
      const repositoryUrl =
        source.url ??
        (source.repo === null ? null : `https://github.com/${source.repo}`);
      const blob = await readGitHubBlob({
        maxBlobBytes: config.maxContentBytes,
        namespace: payload.namespace,
        path: source.path ?? payload.externalId,
        ref: source.ref ?? "main",
        repo: null,
        repositoryUrl:
          repositoryUrl === null ? null : allowedUrl(repositoryUrl, job.jobId),
      });
      ({ documentId, text: content } = blob);
    } else if (source.kind === "url" || source.kind === "web") {
      const { url } = source;
      if (url === null) {
        throw new Error(
          `pipeline: job ${job.jobId} url source has no url to fetch`
        );
      }
      content = await fetchText(allowedUrl(url, job.jobId), config, fetchImpl);
      documentId = `doc_${sha256Hex(
        `${payload.namespace}|${source.sourceId}|${payload.externalId}`
      ).slice(0, 40)}`;
    } else {
      throw new Error(
        `pipeline: source kind ${source.kind} requires a mounted filesystem; route the document through a git or url source instead`
      );
    }
    const contentHash = sha256Hex(content);
    if (contentHash !== payload.contentHash) {
      throw new Error(
        `pipeline: content hash mismatch for ${payload.externalId}: event says ${payload.contentHash.slice(0, 12)}, source now ${contentHash.slice(0, 12)} — the event is stale; the next source sync picks up the new version`
      );
    }
    const doc: PipelineDocument = {
      content,
      documentId,
      externalId: payload.externalId,
      format: formatFor(source.path ?? payload.externalId),
      namespace: payload.namespace,
      source: source.kind === "github" ? "git" : "url",
      title: payload.title,
      url: source.url,
      versionId: payload.version.versionId,
    };
    return await ingest(doc, job, payload);
  };

  const handleSourceSync = async (
    job: ClaimedJob
  ): Promise<{ chunksIngested: number; documentsIngested: number }> => {
    if (job.payload.kind !== "source_sync") {
      throw new Error("pipeline: expected a source_sync payload");
    }
    const { source } = job.payload.sync;
    if (source.kind !== "github") {
      // Only git sources have a crawler; others ingest via explicit events.
      log?.info("pipeline sync skipped (no crawler for source kind)", {
        jobId: job.jobId,
        kind: source.kind,
        sourceId: source.sourceId,
      });
      return { chunksIngested: 0, documentsIngested: 0 };
    }
    let report: GitSyncReport;
    try {
      report = await syncGitSourceDocuments({
        config: {
          namespace: job.namespace,
          ref: source.ref ?? "main",
          repositoryUrl:
            source.url === null ? null : allowedUrl(source.url, job.jobId),
        },
        ...(deps.gitSync === undefined ? {} : { gitSync: deps.gitSync }),
        manifests: deps.manifests,
        sink: deps.sink,
        sourceId: source.sourceId,
        store: deps.store,
      });
    } catch (error) {
      throw new Error(
        `pipeline: git sync failed for ${source.sourceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    log?.info("pipeline git sync complete", {
      added: report.added,
      deleted: report.deleted,
      jobId: job.jobId,
      modified: report.modified,
      renamed: report.renamed,
      skippedBinary: report.skippedBinary,
      skippedEmpty: report.skippedEmpty,
      skippedSecret: report.skippedSecret,
      skippedTooLarge: report.skippedTooLarge,
      sourceId: source.sourceId,
      unchanged: report.unchanged,
    });
    return {
      chunksIngested: 0,
      documentsIngested: report.added + report.modified + report.renamed,
    };
  };

  const handler: JobHandler = async (job) => {
    switch (job.kind) {
      case "document": {
        return await handleDocument(job);
      }
      case "document-version": {
        return await handleDocumentVersion(job);
      }
      case "source_sync": {
        return await handleSourceSync(job);
      }
      default: {
        throw new Error(`pipeline: cannot process job kind ${job.kind}`);
      }
    }
  };
  return handler;
};

/**
 * In-memory sink for DB-less dev. Uses the real chunker so counts are honest,
 * and is idempotent on version identity like the pg sink.
 */
export const createMemoryPipelineSink = (
  options: { maxChars?: number } = {}
): PipelineSink & {
  documents: Map<string, PipelineDocument>;
  tombstoned: string[];
} => {
  const documents = new Map<string, PipelineDocument>();
  const tombstoned: string[] = [];
  return {
    documents,
    processDocumentVersion: (doc) => {
      const key = `${doc.namespace}|${doc.source}|${doc.externalId}|${doc.versionId}`;
      const existed = documents.has(key);
      documents.set(key, doc);
      if (existed) {
        return Promise.resolve({ chunks: 0, status: "ok" });
      }
      const chunks = chunkDocumentVersion(
        {
          content: doc.content,
          documentId: doc.documentId,
          format: doc.format,
          namespace: doc.namespace,
          versionId: doc.versionId,
        },
        options.maxChars === undefined ? {} : { maxChars: options.maxChars }
      ).length;
      return Promise.resolve({ chunks, status: "ok" });
    },
    tombstoneDocument: (documentId) => {
      tombstoned.push(documentId);
      return Promise.resolve();
    },
    tombstoned,
  };
};
