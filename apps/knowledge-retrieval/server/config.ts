import { readFileSync } from "node:fs";

import type { RetrievalMode } from "./store.js";

export interface RetrievalConfig {
  port: number;
  token: string;
  maxQueryLength: number;
  maxTopK: number;
  defaultTopK: number;
  defaultNamespace: string;
  defaultMode: RetrievalMode;
  requestTimeoutMs: number;
  rrfK: number;
  channelWindowFactor: number;
  logQueries: boolean;
  seedFile: string | null;
}

export const CONFIG_DEFAULTS = {
  port: 3000,
  maxQueryLength: 2000,
  maxTopK: 50,
  defaultTopK: 5,
  defaultNamespace: "default",
  defaultMode: "hybrid" as RetrievalMode,
  requestTimeoutMs: 5000,
  rrfK: 60,
  channelWindowFactor: 2,
  logQueries: false,
} as const;

function positiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`KNOWLEDGE_RETRIEVAL_TOKEN_FILE ${path} unreadable: ${reason}`);
  }
}

// The bearer token must come from a secret: an env var injected from a
// Kubernetes Secret, or a mounted token file. Fail closed when neither is
// present so the service can never start unauthenticated.
export function configFromEnv(env: Record<string, string | undefined>): RetrievalConfig {
  const token = env.KNOWLEDGE_RETRIEVAL_TOKEN?.trim()
    ? env.KNOWLEDGE_RETRIEVAL_TOKEN.trim()
    : env.KNOWLEDGE_RETRIEVAL_TOKEN_FILE?.trim()
      ? readTokenFile(env.KNOWLEDGE_RETRIEVAL_TOKEN_FILE.trim())
      : "";
  if (!token) {
    throw new Error(
      "no auth token configured: set KNOWLEDGE_RETRIEVAL_TOKEN or KNOWLEDGE_RETRIEVAL_TOKEN_FILE (secret-backed, required)"
    );
  }
  const port = positiveInt(env, "PORT", CONFIG_DEFAULTS.port);
  const maxQueryLength = positiveInt(
    env,
    "KNOWLEDGE_MAX_QUERY_LENGTH",
    CONFIG_DEFAULTS.maxQueryLength
  );
  const maxTopK = positiveInt(env, "KNOWLEDGE_MAX_TOP_K", CONFIG_DEFAULTS.maxTopK);
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
  const defaultModeRaw = env.KNOWLEDGE_DEFAULT_MODE?.trim();
  const defaultMode =
    defaultModeRaw === "bm25" || defaultModeRaw === "vector" || defaultModeRaw === "hybrid"
      ? defaultModeRaw
      : CONFIG_DEFAULTS.defaultMode;
  return {
    channelWindowFactor: CONFIG_DEFAULTS.channelWindowFactor,
    defaultMode,
    defaultNamespace: env.KNOWLEDGE_DEFAULT_NAMESPACE?.trim() || CONFIG_DEFAULTS.defaultNamespace,
    defaultTopK,
    logQueries: env.KNOWLEDGE_LOG_QUERIES === "1" || env.KNOWLEDGE_LOG_QUERIES === "true",
    maxQueryLength,
    maxTopK,
    port,
    requestTimeoutMs: positiveInt(env, "KNOWLEDGE_TIMEOUT_MS", CONFIG_DEFAULTS.requestTimeoutMs),
    rrfK: positiveInt(env, "KNOWLEDGE_RRF_K", CONFIG_DEFAULTS.rrfK),
    seedFile: env.KNOWLEDGE_SEED_FILE?.trim() || null,
    token,
  };
}

// Test/default instance: same limits as production defaults, caller supplies the token.
export function baseConfig(token: string, overrides: Partial<RetrievalConfig> = {}): RetrievalConfig {
  return {
    channelWindowFactor: CONFIG_DEFAULTS.channelWindowFactor,
    defaultMode: CONFIG_DEFAULTS.defaultMode,
    defaultNamespace: CONFIG_DEFAULTS.defaultNamespace,
    defaultTopK: CONFIG_DEFAULTS.defaultTopK,
    logQueries: CONFIG_DEFAULTS.logQueries,
    maxQueryLength: CONFIG_DEFAULTS.maxQueryLength,
    maxTopK: CONFIG_DEFAULTS.maxTopK,
    port: CONFIG_DEFAULTS.port,
    requestTimeoutMs: CONFIG_DEFAULTS.requestTimeoutMs,
    rrfK: CONFIG_DEFAULTS.rrfK,
    seedFile: null,
    token,
    ...overrides,
  };
}
