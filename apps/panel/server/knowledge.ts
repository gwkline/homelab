// Knowledge API client for the panel (#65). The panel server is the only
// bearer-token holder: the browser talks to these panel routes, the panel
// talks to the knowledge API over HTTP. There are no database credentials in
// this path — sources, sync jobs, and cited search all come from the
// knowledge API (ADR-002 D2: the panel never queries Postgres directly).
//
// Pinned upstream surface (the ingest/sync contract from #58, retrieval from
// #64):
//   GET  /v1/sources                 → { sources: SourceStatus[] }
//   POST /v1/sources/:sourceId/sync  → 202 { jobId }
//   GET  /v1/sync-jobs/:jobId        → SyncJob
//   POST /v1/search                  → retrieval contract (apps/knowledge-retrieval/server/contract.ts)
import { readFileSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 5000;
const SOURCE_ID_MAX = 128;

export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const KNOWLEDGE_MODES = ["bm25", "vector", "hybrid"] as const;
export const KNOWLEDGE_MODE_SET: ReadonlySet<string> = new Set(KNOWLEDGE_MODES);
export const KNOWLEDGE_TOP_K_MAX = 50;
export const KNOWLEDGE_QUERY_MAX = 2000;

export interface KnowledgeConfig {
  base: string | null;
  timeoutMs: number;
  token: string;
}

export const loadKnowledgeConfig = (env = process.env): KnowledgeConfig => {
  const base = env.KNOWLEDGE_API_BASE?.trim() || null;
  let token = env.KNOWLEDGE_API_TOKEN?.trim() ?? "";
  const tokenFile = env.KNOWLEDGE_API_TOKEN_FILE?.trim();
  if (token === "" && tokenFile) {
    try {
      token = readFileSync(tokenFile, "utf-8").trim();
    } catch {
      token = "";
    }
  }
  const rawTimeout = Number(env.KNOWLEDGE_TIMEOUT_MS ?? "");
  const timeoutMs =
    Number.isInteger(rawTimeout) && rawTimeout > 0
      ? rawTimeout
      : DEFAULT_TIMEOUT_MS;
  return { base, timeoutMs, token };
};

// ── response shapes (normalized; upstream passthrough fields stay upstream) ──

export interface KnowledgeSourceJob {
  jobId: string;
  startedAt: string | null;
  status: string;
}

export interface KnowledgeSource {
  chunkCount: number;
  currentJob: KnowledgeSourceJob | null;
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

export interface KnowledgeSyncJob {
  attempts: number | null;
  chunksIngested: number | null;
  documentsIngested: number | null;
  error: string | null;
  finishedAt: string | null;
  jobId: string;
  sourceId: string | null;
  startedAt: string | null;
  status: string;
}

export interface KnowledgeSearchHit {
  anchors: { start: number | null; type: string; value: string | null }[];
  chunkId: string;
  namespace: string;
  scores: {
    bm25: { rank: number; score: number } | null;
    fused: { rank: number; score: number };
    vector: { rank: number; score: number } | null;
  };
  source: {
    kind: string;
    path: string | null;
    sourceId: string;
    url: string | null;
  };
  text: string;
  title: string;
  version: {
    commit: string | null;
    createdAt: string;
    status: string;
    versionId: string;
  };
}

export class KnowledgeApiError extends Error {
  override name = "KnowledgeApiError";
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// `error: unknown` / JSON field accessors — mirror the index.ts helpers but
// keep this module self-contained (it is unit-imported by tests directly).
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const asStr = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const asNum = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseSyncJob = (raw: unknown): KnowledgeSyncJob => {
  const rec = asRecord(raw);
  if (rec === null) {
    throw new KnowledgeApiError("knowledge API returned a malformed job", 502);
  }
  const jobId = asStr(rec.jobId);
  const status = asStr(rec.status);
  if (jobId === null || status === null) {
    throw new KnowledgeApiError("knowledge API returned a malformed job", 502);
  }
  const err = rec.error === undefined ? null : asStr(rec.error);
  return {
    attempts: rec.attempts === undefined ? null : asNum(rec.attempts),
    chunksIngested:
      rec.chunksIngested === undefined ? null : asNum(rec.chunksIngested),
    documentsIngested:
      rec.documentsIngested === undefined ? null : asNum(rec.documentsIngested),
    error: err,
    finishedAt: asStr(rec.finishedAt),
    jobId,
    sourceId: asStr(rec.sourceId),
    startedAt: asStr(rec.startedAt),
    status,
  };
};

const parseSources = (raw: unknown): KnowledgeSource[] => {
  const rec = asRecord(raw);
  const items = rec === null ? null : rec.sources;
  if (!Array.isArray(items)) {
    throw new KnowledgeApiError(
      "knowledge API returned a malformed source list",
      502
    );
  }
  return items.flatMap((item) => {
    const s = asRecord(item);
    if (s === null || asStr(s.sourceId) === null) {
      return [];
    }
    const jobRec =
      s.currentJob === undefined || s.currentJob === null
        ? null
        : asRecord(s.currentJob);
    const job =
      jobRec === null || asStr(jobRec.jobId) === null
        ? null
        : {
            jobId: asStr(jobRec.jobId) ?? "",
            startedAt: asStr(jobRec.startedAt),
            status: asStr(jobRec.status) ?? "unknown",
          };
    const errRec =
      s.lastError === undefined || s.lastError === null
        ? null
        : asRecord(s.lastError);
    return [
      {
        chunkCount: asNum(s.chunkCount) ?? 0,
        currentJob: job,
        documentCount: asNum(s.documentCount) ?? 0,
        kind: asStr(s.kind) ?? "unknown",
        lastError:
          errRec === null || asStr(errRec.message) === null
            ? null
            : {
                at: asStr(errRec.at),
                message: asStr(errRec.message) ?? "",
              },
        lastSyncAt: asStr(s.lastSyncAt),
        namespace: asStr(s.namespace) ?? "default",
        path: asStr(s.path),
        ref: asStr(s.ref),
        repo: asStr(s.repo),
        sourceId: asStr(s.sourceId) ?? "",
        url: asStr(s.url),
      },
    ];
  });
};

const parseChannelScore = (
  raw: unknown
): { rank: number; score: number } | null => {
  const rec = asRecord(raw);
  if (rec === null) {
    return null;
  }
  return { rank: asNum(rec.rank) ?? 0, score: asNum(rec.score) ?? 0 };
};

const parseAnchors = (raw: unknown): KnowledgeSearchHit["anchors"] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((item) => {
    const rec = asRecord(item);
    if (rec === null) {
      return [];
    }
    return [
      {
        start: asNum(rec.start),
        type: asStr(rec.type) ?? "offset",
        value: asStr(rec.value),
      },
    ];
  });
};

const parseScores = (raw: unknown): KnowledgeSearchHit["scores"] => {
  const rec = asRecord(raw) ?? {};
  const fused = parseChannelScore(rec.fused) ?? { rank: 0, score: 0 };
  return {
    bm25: parseChannelScore(rec.bm25),
    fused,
    vector: parseChannelScore(rec.vector),
  };
};

const parseHit = (item: unknown): KnowledgeSearchHit[] => {
  const h = asRecord(item);
  if (h === null || asStr(h.chunkId) === null) {
    return [];
  }
  const version = asRecord(h.version) ?? {};
  const source = asRecord(h.source) ?? {};
  return [
    {
      anchors: parseAnchors(h.anchors),
      chunkId: asStr(h.chunkId) ?? "",
      namespace: asStr(h.namespace) ?? "default",
      scores: parseScores(h.scores),
      source: {
        kind: asStr(source.kind) ?? "unknown",
        path: asStr(source.path),
        sourceId: asStr(source.sourceId) ?? "",
        url: asStr(source.url),
      },
      text: asStr(h.text) ?? "",
      title: asStr(h.title) ?? "",
      version: {
        commit: asStr(version.commit),
        createdAt: asStr(version.createdAt) ?? "",
        status: asStr(version.status) ?? "current",
        versionId: asStr(version.versionId) ?? "",
      },
    },
  ];
};

const parseSearch = (
  raw: unknown
): {
  results: KnowledgeSearchHit[];
  totalCandidates: number;
} => {
  const rec = asRecord(raw);
  const results = rec === null ? null : rec.results;
  if (!Array.isArray(results)) {
    throw new KnowledgeApiError(
      "knowledge API returned a malformed search response",
      502
    );
  }
  const hits = results.flatMap(parseHit);
  return {
    results: hits,
    totalCandidates: asNum(rec?.totalCandidates) ?? hits.length,
  };
};

export interface KnowledgeClient {
  listSources: () => Promise<KnowledgeSource[]>;
  search: (body: Record<string, unknown>) => Promise<{
    results: KnowledgeSearchHit[];
    totalCandidates: number;
  }>;
  syncJob: (jobId: string) => Promise<KnowledgeSyncJob>;
  triggerSync: (sourceId: string) => Promise<KnowledgeSyncJob>;
}

export const createKnowledgeClient = (
  config: KnowledgeConfig
): KnowledgeClient => {
  const { base, timeoutMs, token } = config;

  const redact = (text: string): string =>
    token === "" ? text : text.replaceAll(token, "[redacted]");

  const request = async (
    method: "GET" | "POST",
    route: string,
    body?: Record<string, unknown>
  ): Promise<unknown> => {
    if (base === null) {
      throw new KnowledgeApiError("knowledge API is not configured", 503);
    }
    let res: Response;
    try {
      res = await fetch(`${base}${route}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new KnowledgeApiError(
          `knowledge API timed out after ${timeoutMs}ms`,
          504
        );
      }
      throw new KnowledgeApiError(
        redact(`knowledge API unreachable: ${String(error)}`),
        502
      );
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`.trim();
      try {
        const raw: unknown = await res.json();
        const err = asRecord(raw)?.error;
        const nested = asRecord(err);
        const detail = nested === null ? asStr(err) : asStr(nested.message);
        if (detail !== null) {
          message = detail;
        }
      } catch {
        // non-JSON error body — keep the status text
      }
      throw new KnowledgeApiError(redact(message), res.status);
    }
    try {
      return (await res.json()) as unknown;
    } catch (error) {
      throw new KnowledgeApiError(
        `knowledge API returned invalid JSON: ${String(error)}`,
        502
      );
    }
  };

  return {
    listSources: async () => parseSources(await request("GET", "/v1/sources")),
    search: async (body) =>
      parseSearch(await request("POST", "/v1/search", body)),
    syncJob: async (jobId) =>
      parseSyncJob(
        await request(
          "GET",
          `/v1/sync-jobs/${encodeURIComponent(jobId.slice(0, SOURCE_ID_MAX))}`
        )
      ),
    triggerSync: async (sourceId) =>
      parseSyncJob(
        await request(
          "POST",
          `/v1/sources/${encodeURIComponent(sourceId)}/sync`
        )
      ),
  };
};
