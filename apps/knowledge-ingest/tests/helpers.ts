import { createHash } from "node:crypto";

import { createApp } from "../server/app.ts";
import { baseConfig } from "../server/config.ts";
import type { WorkerConfig } from "../server/config.ts";
import type { LogFields, LogLevel, Logger } from "../server/log.ts";
import { createMemoryIngestStore } from "../server/memory-store.ts";
import type { IngestRequestInput, IngestStore } from "../server/store.ts";

export const TEST_TOKEN = "ingest-test-token-1234567890";

/** Recording logger: silent by default, but tests can assert on entries. */
export const recordedLogs: {
  fields?: LogFields;
  level: LogLevel;
  msg: string;
}[] = [];

export const noopLogger: Logger = {
  debug: (msg, fields) => {
    recordedLogs.push({ ...(fields ? { fields } : {}), level: "debug", msg });
  },
  error: (msg, fields) => {
    recordedLogs.push({ ...(fields ? { fields } : {}), level: "error", msg });
  },
  info: (msg, fields) => {
    recordedLogs.push({ ...(fields ? { fields } : {}), level: "info", msg });
  },
  warn: (msg, fields) => {
    recordedLogs.push({ ...(fields ? { fields } : {}), level: "warn", msg });
  },
};

/** Pinned clock the tests advance manually to drive leases and backoff. */
export interface TestClock {
  advance: (ms: number) => void;
  now: () => Date;
}

export const createTestClock = (
  start = "2026-09-14T00:00:00.000Z"
): TestClock => {
  let current = new Date(start).getTime();
  return {
    advance: (ms: number): void => {
      current += ms;
    },
    now: (): Date => new Date(current),
  };
};

const hex = (seed: number): string =>
  createHash("sha256").update(String(seed)).digest("hex");

export const makeIngestInput = (
  overrides: Partial<IngestRequestInput> = {}
): IngestRequestInput => ({
  contentHash: hex(1),
  externalId: "docs/runbook.md",
  idempotencyKey: null,
  namespace: "homelab-docs",
  provenance: {
    ingestedAt: "2026-09-13T10:00:00Z",
    ingestionEventId: null,
  },
  source: {
    kind: "github",
    path: "docs/runbook.md",
    ref: "main",
    repo: "gwkline/homelab",
    sourceId: "homelab-docs",
    url: "https://github.com/gwkline/homelab",
  },
  tags: ["ops"],
  title: "Runbook",
  version: { commit: "abc123", versionId: "v1" },
  ...overrides,
});

export const makeIngestBody = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
  const input = makeIngestInput();
  return {
    contentHash: input.contentHash,
    externalId: input.externalId,
    namespace: input.namespace,
    provenance: { ingestedAt: input.provenance.ingestedAt },
    source: input.source,
    tags: input.tags,
    title: input.title,
    version: input.version,
    ...overrides,
  };
};

export const makeWorkerConfig = (
  overrides: Partial<{
    claimBatchSize: number;
    heartbeatIntervalMs: number;
    leaseSeconds: number;
    maxAttempts: number;
    pollIntervalMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  }> = {}
): WorkerConfig => ({
  claimBatchSize: 5,
  heartbeatIntervalMs: 15_000,
  leaseSeconds: 60,
  maxAttempts: 3,
  pollIntervalMs: 10,
  retryBaseMs: 1000,
  retryMaxMs: 60_000,
  ...overrides,
});

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  store: IngestStore;
}

export const createHarness = (
  options: {
    store?: IngestStore;
  } = {}
): TestHarness => {
  const store = options.store ?? createMemoryIngestStore();
  const app = createApp({
    config: baseConfig(TEST_TOKEN),
    logger: noopLogger,
    store,
  });
  return { app, store };
};

export const getJson = async (
  response: Response
): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

export const bearer = (token = TEST_TOKEN): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
