import { readFileSync } from "node:fs";

export interface IngestConfig {
  port: number;
  /** Secret-backed bearer token (required; the service fails closed). */
  token: string;
  /** Postgres connection string; null runs the in-memory store (dev/tests). */
  databaseUrl: string | null;
  /** Serve readiness only once the schema is applied. */
  applySchemaOnBoot: boolean;
  workerEnabled: boolean;
  worker: WorkerConfig;
}

export interface WorkerConfig {
  claimBatchSize: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export const CONFIG_DEFAULTS = {
  applySchemaOnBoot: true,
  claimBatchSize: 10,
  heartbeatIntervalMs: 15_000,
  leaseSeconds: 60,
  maxAttempts: 5,
  pollIntervalMs: 1000,
  port: 3100,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
  workerEnabled: true,
} as const;

const positiveInt = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  { max = Number.POSITIVE_INFINITY }: { max?: number } = {}
): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Math.trunc(Number(raw));
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(
      `${name} must be a positive integer${
        max === Number.POSITIVE_INFINITY ? "" : ` <= ${max}`
      }, got ${JSON.stringify(raw)}`
    );
  }
  return value;
};

const readTokenFile = (path: string): string => {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `KNOWLEDGE_INGEST_TOKEN_FILE ${path} unreadable: ${reason}`,
      { cause: error }
    );
  }
};

// The bearer token must come from a secret: an env var injected from a
// Kubernetes Secret, or a mounted token file. Fail closed when neither is
// present so the service can never start unauthenticated.
export const configFromEnv = (
  env: Record<string, string | undefined>
): IngestConfig => {
  let token = "";
  if (env.KNOWLEDGE_INGEST_TOKEN?.trim()) {
    token = env.KNOWLEDGE_INGEST_TOKEN.trim();
  } else if (env.KNOWLEDGE_INGEST_TOKEN_FILE?.trim()) {
    token = readTokenFile(env.KNOWLEDGE_INGEST_TOKEN_FILE.trim());
  }
  if (!token) {
    throw new Error(
      "no auth token configured: set KNOWLEDGE_INGEST_TOKEN or KNOWLEDGE_INGEST_TOKEN_FILE (secret-backed, required)"
    );
  }
  const maxAttempts = positiveInt(
    env,
    "KNOWLEDGE_INGEST_MAX_ATTEMPTS",
    CONFIG_DEFAULTS.maxAttempts
  );
  const retryBaseMs = positiveInt(
    env,
    "KNOWLEDGE_INGEST_RETRY_BASE_MS",
    CONFIG_DEFAULTS.retryBaseMs
  );
  const retryMaxMs = positiveInt(
    env,
    "KNOWLEDGE_INGEST_RETRY_MAX_MS",
    CONFIG_DEFAULTS.retryMaxMs
  );
  if (retryMaxMs < retryBaseMs) {
    throw new Error(
      `KNOWLEDGE_INGEST_RETRY_MAX_MS (${retryMaxMs}) must not be below KNOWLEDGE_INGEST_RETRY_BASE_MS (${retryBaseMs})`
    );
  }
  const worker: WorkerConfig = {
    claimBatchSize: positiveInt(
      env,
      "KNOWLEDGE_INGEST_CLAIM_BATCH",
      CONFIG_DEFAULTS.claimBatchSize
    ),
    heartbeatIntervalMs: positiveInt(
      env,
      "KNOWLEDGE_INGEST_HEARTBEAT_MS",
      CONFIG_DEFAULTS.heartbeatIntervalMs
    ),
    leaseSeconds: positiveInt(
      env,
      "KNOWLEDGE_INGEST_LEASE_SECONDS",
      CONFIG_DEFAULTS.leaseSeconds
    ),
    maxAttempts,
    pollIntervalMs: positiveInt(
      env,
      "KNOWLEDGE_INGEST_POLL_MS",
      CONFIG_DEFAULTS.pollIntervalMs
    ),
    retryBaseMs,
    retryMaxMs,
  };
  return {
    applySchemaOnBoot:
      env.KNOWLEDGE_INGEST_APPLY_SCHEMA !== "0" &&
      env.KNOWLEDGE_INGEST_APPLY_SCHEMA !== "false",
    databaseUrl: env.KNOWLEDGE_INGEST_DATABASE_URL?.trim() || null,
    port: positiveInt(env, "PORT", CONFIG_DEFAULTS.port),
    token,
    worker,
    workerEnabled:
      env.KNOWLEDGE_INGEST_WORKER !== "0" &&
      env.KNOWLEDGE_INGEST_WORKER !== "false",
  };
};

// Test/default instance: production-shaped defaults, caller supplies the rest.
export const baseConfig = (
  token: string,
  overrides: Partial<IngestConfig> = {}
): IngestConfig => ({
  applySchemaOnBoot: CONFIG_DEFAULTS.applySchemaOnBoot,
  databaseUrl: null,
  port: CONFIG_DEFAULTS.port,
  token,
  worker: {
    claimBatchSize: CONFIG_DEFAULTS.claimBatchSize,
    heartbeatIntervalMs: CONFIG_DEFAULTS.heartbeatIntervalMs,
    leaseSeconds: CONFIG_DEFAULTS.leaseSeconds,
    maxAttempts: CONFIG_DEFAULTS.maxAttempts,
    pollIntervalMs: CONFIG_DEFAULTS.pollIntervalMs,
    retryBaseMs: CONFIG_DEFAULTS.retryBaseMs,
    retryMaxMs: CONFIG_DEFAULTS.retryMaxMs,
  },
  workerEnabled: CONFIG_DEFAULTS.workerEnabled,
  ...overrides,
});
