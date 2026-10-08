import { existsSync, readFileSync } from "node:fs";

import type { RetrievalMode } from "./store.ts";

export interface RetrievalConfig {
  port: number;
  /** Admin bearer: every route, including the ingest passthrough. */
  token: string;
  /** Read-only bearer: `/v1/search` only. Null until it is provisioned. */
  searchToken: string | null;
  maxQueryLength: number;
  maxTopK: number;
  defaultTopK: number;
  defaultNamespace: string;
  defaultMode: RetrievalMode;
  /**
   * Request deadline, also the pool's `statement_timeout`, so the database
   * cancels the queries of a request that already answered 504.
   */
  requestTimeoutMs: number;
  /** Postgres pool size. */
  poolMax: number;
  rrfK: number;
  channelWindowFactor: number;
  logQueries: boolean;
  seedFile: string | null;
  /** Postgres connection string; null runs the in-memory store (dev/tests). */
  databaseUrl: string | null;
  /** In-cluster ingest API base for the sources/sync passthrough routes. */
  ingestBaseUrl: string | null;
  /** Bearer token for the ingest passthrough; defaults to the local token. */
  ingestToken: string | null;
  /** Timeout for the ingest passthrough requests. */
  ingestTimeoutMs: number;
}

export const CONFIG_DEFAULTS = {
  channelWindowFactor: 2,
  defaultMode: "hybrid" as RetrievalMode,
  defaultNamespace: "default",
  defaultTopK: 5,
  ingestTimeoutMs: 5000,
  logQueries: false,
  maxQueryLength: 2000,
  maxTopK: 50,
  poolMax: 10,
  port: 3000,
  requestTimeoutMs: 5000,
  rrfK: 60,
} as const;

const positiveInt = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Math.trunc(Number(raw));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`
    );
  }
  return value;
};

const readTokenFile = (path: string, envName: string): string => {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${envName} ${path} unreadable: ${reason}`, {
      cause: error,
    });
  }
};

// Fail closed: the service never starts without a secret-backed token.
const tokenFromEnv = (env: Record<string, string | undefined>): string => {
  if (env.KNOWLEDGE_RETRIEVAL_TOKEN?.trim()) {
    return env.KNOWLEDGE_RETRIEVAL_TOKEN.trim();
  }
  if (env.KNOWLEDGE_RETRIEVAL_TOKEN_FILE?.trim()) {
    return readTokenFile(
      env.KNOWLEDGE_RETRIEVAL_TOKEN_FILE.trim(),
      "KNOWLEDGE_RETRIEVAL_TOKEN_FILE"
    );
  }
  throw new Error(
    "no auth token configured: set KNOWLEDGE_RETRIEVAL_TOKEN or KNOWLEDGE_RETRIEVAL_TOKEN_FILE (secret-backed, required)"
  );
};

/**
 * Optional: the secret is mounted `optional`, so a missing or empty file
 * means the search token is not provisioned yet and only the admin token
 * works.
 */
const searchTokenFromEnv = (
  env: Record<string, string | undefined>,
  adminToken: string
): string | null => {
  let token: string | null =
    env.KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN?.trim() || null;
  const file = env.KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN_FILE?.trim();
  if (token === null && file && existsSync(file)) {
    token =
      readTokenFile(file, "KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN_FILE") || null;
  }
  if (token === adminToken) {
    throw new Error(
      "the search token must differ from the admin token, or it would carry admin scope"
    );
  }
  return token;
};

const modeFromEnv = (
  env: Record<string, string | undefined>
): RetrievalMode => {
  const raw = env.KNOWLEDGE_DEFAULT_MODE?.trim();
  return raw === "bm25" || raw === "vector" || raw === "hybrid"
    ? raw
    : CONFIG_DEFAULTS.defaultMode;
};

/** Search limits (topK/query length) with their cross-field invariant. */
const searchLimitsFromEnv = (env: Record<string, string | undefined>) => {
  const maxQueryLength = positiveInt(
    env,
    "KNOWLEDGE_MAX_QUERY_LENGTH",
    CONFIG_DEFAULTS.maxQueryLength
  );
  const maxTopK = positiveInt(
    env,
    "KNOWLEDGE_MAX_TOP_K",
    CONFIG_DEFAULTS.maxTopK
  );
  const defaultTopK = positiveInt(
    env,
    "KNOWLEDGE_DEFAULT_TOP_K",
    CONFIG_DEFAULTS.defaultTopK
  );
  if (defaultTopK > maxTopK) {
    throw new Error(
      `KNOWLEDGE_DEFAULT_TOP_K (${defaultTopK}) must not exceed KNOWLEDGE_MAX_TOP_K (${maxTopK})`
    );
  }
  return { defaultTopK, maxQueryLength, maxTopK };
};

export const configFromEnv = (
  env: Record<string, string | undefined>
): RetrievalConfig => {
  const token = tokenFromEnv(env);
  const { defaultTopK, maxQueryLength, maxTopK } = searchLimitsFromEnv(env);
  const defaultMode = modeFromEnv(env);
  const port = positiveInt(env, "PORT", CONFIG_DEFAULTS.port);
  return {
    channelWindowFactor: CONFIG_DEFAULTS.channelWindowFactor,
    databaseUrl:
      env.KNOWLEDGE_RETRIEVAL_DATABASE_URL?.trim() ||
      env.DATABASE_URL?.trim() ||
      null,
    defaultMode,
    defaultNamespace:
      env.KNOWLEDGE_DEFAULT_NAMESPACE?.trim() ||
      CONFIG_DEFAULTS.defaultNamespace,
    defaultTopK,
    ingestBaseUrl: env.KNOWLEDGE_INGEST_BASE_URL?.trim() || null,
    ingestTimeoutMs: positiveInt(
      env,
      "KNOWLEDGE_INGEST_TIMEOUT_MS",
      CONFIG_DEFAULTS.ingestTimeoutMs
    ),
    ingestToken:
      env.KNOWLEDGE_INGEST_TOKEN?.trim() ||
      (env.KNOWLEDGE_INGEST_TOKEN_FILE?.trim()
        ? readTokenFile(
            env.KNOWLEDGE_INGEST_TOKEN_FILE.trim(),
            "KNOWLEDGE_INGEST_TOKEN_FILE"
          )
        : token),
    logQueries:
      env.KNOWLEDGE_LOG_QUERIES === "1" || env.KNOWLEDGE_LOG_QUERIES === "true",
    maxQueryLength,
    maxTopK,
    poolMax: positiveInt(env, "KNOWLEDGE_PG_POOL_MAX", CONFIG_DEFAULTS.poolMax),
    port,
    requestTimeoutMs: positiveInt(
      env,
      "KNOWLEDGE_TIMEOUT_MS",
      CONFIG_DEFAULTS.requestTimeoutMs
    ),
    rrfK: positiveInt(env, "KNOWLEDGE_RRF_K", CONFIG_DEFAULTS.rrfK),
    searchToken: searchTokenFromEnv(env, token),
    seedFile: env.KNOWLEDGE_SEED_FILE?.trim() || null,
    token,
  };
};

/** Production defaults with a caller-supplied token; used by tests. */
export const baseConfig = (
  token: string,
  overrides: Partial<RetrievalConfig> = {}
): RetrievalConfig => ({
  channelWindowFactor: CONFIG_DEFAULTS.channelWindowFactor,
  databaseUrl: null,
  defaultMode: CONFIG_DEFAULTS.defaultMode,
  defaultNamespace: CONFIG_DEFAULTS.defaultNamespace,
  defaultTopK: CONFIG_DEFAULTS.defaultTopK,
  ingestBaseUrl: null,
  ingestTimeoutMs: CONFIG_DEFAULTS.ingestTimeoutMs,
  ingestToken: null,
  logQueries: CONFIG_DEFAULTS.logQueries,
  maxQueryLength: CONFIG_DEFAULTS.maxQueryLength,
  maxTopK: CONFIG_DEFAULTS.maxTopK,
  poolMax: CONFIG_DEFAULTS.poolMax,
  port: CONFIG_DEFAULTS.port,
  requestTimeoutMs: CONFIG_DEFAULTS.requestTimeoutMs,
  rrfK: CONFIG_DEFAULTS.rrfK,
  searchToken: null,
  seedFile: null,
  token,
  ...overrides,
});
