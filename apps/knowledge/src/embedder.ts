/**
 * Embedding providers and the batch engine: batched requests with bounded
 * concurrency, per-attempt timeouts, and exponential-backoff retries. A bad
 * input or vector fails only its own chunk, never its batchmates.
 *
 * The provider dimension must match the `chunks` column's `vector(N)`; a
 * different model dimension needs a new column and a re-embed backfill.
 */

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_MAX_CHARS } from "./chunk.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./pgvector.ts";

export interface EmbeddingProvider {
  dimensions: number;
  /** One request; returns one vector per input, in order. */
  embed: (
    inputs: string[],
    options?: { signal?: AbortSignal }
  ) => Promise<number[][]>;
  /** Persisted on every chunk this provider embeds. */
  model: string;
  name: string;
}

export class EmbeddingProviderError extends Error {
  override name = "EmbeddingProviderError";
  retryable: boolean;
  status: number | null;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number }
  ) {
    super(message);
    this.retryable = options.retryable;
    this.status = options.status ?? null;
  }
}

const isRetryStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

export const isRetryableEmbeddingError = (error: unknown): boolean => {
  if (error instanceof EmbeddingProviderError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
};

const FAKE_MODEL_PREFIX = "fake/";

/** The model tag fake vectors are stored under. */
export const fakeEmbeddingModel = (dimensions: number): string =>
  `${FAKE_MODEL_PREFIX}${dimensions}`;

export const isFakeEmbeddingProvider = (provider: EmbeddingProvider): boolean =>
  provider.name === "fake";

/**
 * Deterministic sha256-derived unit vectors for tests; never for real
 * retrieval. The model tag must sit under `fake/`, so stored fake vectors can
 * never pass for a real model's and a re-embed always replaces them.
 */
export const createFakeEmbeddingProvider = (
  model?: string,
  dimensions: number = EMBEDDING_DIMENSIONS
): EmbeddingProvider => {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new TypeError(
      `embedder: fake provider dimensions must be an integer >= 1, got ${String(dimensions)}`
    );
  }
  const tag = model ?? fakeEmbeddingModel(dimensions);
  if (!tag.startsWith(FAKE_MODEL_PREFIX)) {
    throw new TypeError(
      `embedder: fake provider model ${JSON.stringify(tag)} must start with ${FAKE_MODEL_PREFIX}`
    );
  }
  const fakeVector = (input: string): number[] => {
    const vector: number[] = [];
    let block = 0;
    while (vector.length < dimensions) {
      const digest = createHash("sha256")
        .update(`${tag}\u0000${input}\u0000${block}`, "utf-8")
        .digest();
      for (let offset = 0; offset + 1 < digest.length; offset += 2) {
        if (vector.length === dimensions) {
          break;
        }
        const unit = digest.readUInt16LE(offset);
        vector.push((unit / 65_535) * 2 - 1);
      }
      block += 1;
    }
    let sumOfSquares = 0;
    for (const value of vector) {
      sumOfSquares += value * value;
    }
    const norm = Math.sqrt(sumOfSquares);
    if (norm === 0) {
      const unitVector: number[] = Array.from({ length: dimensions }, () => 0);
      unitVector[0] = 1;
      return unitVector;
    }
    return vector.map((value) => value / norm);
  };
  return {
    dimensions,
    embed: (inputs): Promise<number[][]> =>
      Promise.resolve(inputs.map(fakeVector)),
    model: tag,
    name: "fake",
  };
};

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  /** API root; `/embeddings` is appended. */
  baseUrl: string;
  dimensions: number;
  model: string;
}

/** A short or misshapen response is a provider error, never a partial result. */
export const createOpenAICompatibleProvider = (
  config: OpenAICompatibleProviderOptions
): EmbeddingProvider => {
  if (typeof config.baseUrl !== "string" || config.baseUrl.trim() === "") {
    throw new TypeError("embedder: baseUrl must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(`${config.baseUrl.replace(/\/+$/u, "")}/embeddings`);
  } catch {
    throw new TypeError(
      `embedder: baseUrl is not a valid URL: ${JSON.stringify(config.baseUrl)}`
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      `embedder: baseUrl must be http(s), got ${url.protocol}`
    );
  }
  if (typeof config.model !== "string" || config.model.length === 0) {
    throw new TypeError("embedder: model must be a non-empty string");
  }
  if (!Number.isInteger(config.dimensions) || config.dimensions < 1) {
    throw new TypeError(
      `embedder: dimensions must be an integer >= 1, got ${String(config.dimensions)}`
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey === undefined
      ? {}
      : { authorization: `Bearer ${config.apiKey}` }),
  };
  return {
    dimensions: config.dimensions,
    embed: async (inputs, { signal } = {}) => {
      let response: Response;
      try {
        response = await fetch(url, {
          body: JSON.stringify({ input: inputs, model: config.model }),
          headers,
          method: "POST",
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw new EmbeddingProviderError(
          `embedding request to ${url.origin} failed: ${String(error)}`,
          { retryable: true }
        );
      }
      if (!response.ok) {
        throw new EmbeddingProviderError(
          `embedding provider returned HTTP ${response.status}`,
          {
            retryable: isRetryStatus(response.status),
            status: response.status,
          }
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new EmbeddingProviderError(
          `embedding provider returned invalid JSON: ${String(error)}`,
          { retryable: true }
        );
      }
      const { data } = (payload ?? {}) as { data?: unknown };
      if (!Array.isArray(data) || data.length !== inputs.length) {
        throw new EmbeddingProviderError(
          `embedding provider returned ${Array.isArray(data) ? data.length : "no"} vectors for ${inputs.length} inputs`,
          { retryable: true }
        );
      }
      return inputs.map((_, position) => {
        const entry = (data[position] ?? {}) as { embedding?: unknown };
        const vector = entry.embedding;
        if (!Array.isArray(vector)) {
          throw new EmbeddingProviderError(
            `embedding provider response entry ${position} has no embedding`,
            { retryable: true }
          );
        }
        return vector.map(Number);
      });
    },
    model: config.model,
    name: "openai-compatible",
  };
};

export interface EmbeddingWorkerOptions {
  /** Default 32. */
  batchSize?: number;
  /** Default 250. */
  baseDelayMs?: number;
  /** Max in-flight requests. Default 4. */
  concurrency?: number;
  /** The `chunks` column's `vector(N)`; a mismatched provider is refused. */
  dbDimensions?: number;
  maxChars?: number;
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number;
  provider: EmbeddingProvider;
  /** Per attempt. Default 30_000. */
  timeoutMs?: number;
}

export interface EmbeddingWorkerConfig {
  batchSize: number;
  baseDelayMs: number;
  concurrency: number;
  dbDimensions: number;
  maxChars: number;
  maxRetries: number;
  provider: EmbeddingProvider;
  timeoutMs: number;
}

const validatedInt = (
  value: number | undefined,
  fallback: number,
  label: string,
  minimum: number
): number => {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum) {
    throw new TypeError(
      `embedder: ${label} must be an integer >= ${minimum}, got ${String(value)}`
    );
  }
  return resolved;
};

export const resolveEmbeddingWorkerConfig = (
  options: EmbeddingWorkerOptions
): EmbeddingWorkerConfig => {
  const { provider } = options;
  if (typeof provider !== "object" || provider === null) {
    throw new TypeError("embedder: provider is required");
  }
  if (typeof provider.embed !== "function") {
    throw new TypeError("embedder: provider must implement embed(inputs)");
  }
  if (typeof provider.name !== "string" || provider.name.length === 0) {
    throw new TypeError("embedder: provider.name must be a non-empty string");
  }
  if (typeof provider.model !== "string" || provider.model.length === 0) {
    throw new TypeError("embedder: provider.model must be a non-empty string");
  }
  if (
    !Number.isInteger(provider.dimensions) ||
    provider.dimensions < 1 ||
    provider.dimensions !== (options.dbDimensions ?? EMBEDDING_DIMENSIONS)
  ) {
    const dbDimensions = options.dbDimensions ?? EMBEDDING_DIMENSIONS;
    const dimensions = Number.isInteger(provider.dimensions)
      ? provider.dimensions
      : "invalid";
    throw new Error(
      `embedder: provider ${String(provider.name)}/${String(provider.model)} produces ${String(dimensions)} dimensions but the chunks column is vector(${dbDimensions}) — a different dimension needs its own column and migration plus a re-embed backfill (ADR-002 D6/D10), not vectors written into this column`
    );
  }
  return {
    baseDelayMs: validatedInt(options.baseDelayMs, 250, "baseDelayMs", 0),
    batchSize: validatedInt(options.batchSize, 32, "batchSize", 1),
    concurrency: validatedInt(options.concurrency, 4, "concurrency", 1),
    dbDimensions: options.dbDimensions ?? EMBEDDING_DIMENSIONS,
    maxChars: validatedInt(options.maxChars, DEFAULT_MAX_CHARS, "maxChars", 1),
    maxRetries: validatedInt(options.maxRetries, 3, "maxRetries", 0),
    provider,
    timeoutMs: validatedInt(options.timeoutMs, 30_000, "timeoutMs", 1),
  };
};

export interface EmbedRetryOptions {
  baseDelayMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export const embedWithRetries = async (
  provider: EmbeddingProvider,
  inputs: string[],
  options: {
    baseDelayMs?: number;
    maxRetries?: number;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {}
): Promise<number[][]> => {
  const maxRetries = validatedInt(options.maxRetries, 3, "maxRetries", 0);
  const timeoutMs = validatedInt(options.timeoutMs, 30_000, "timeoutMs", 1);
  const baseDelayMs = validatedInt(options.baseDelayMs, 250, "baseDelayMs", 0);
  const waitFor = options.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await provider.embed(inputs, {
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      attempt += 1;
      if (attempt > maxRetries || !isRetryableEmbeddingError(error)) {
        throw error;
      }
      await waitFor(baseDelayMs * 2 ** (attempt - 1));
    }
  }
};

/** Returns the failure reason, or null when the vector is usable. */
export const embeddingVectorProblem = (
  vector: unknown,
  dimensions: number
): string | null => {
  if (!Array.isArray(vector)) {
    return "embedding is not an array";
  }
  if (vector.length !== dimensions) {
    return `embedding has ${vector.length} dimensions, expected ${dimensions}`;
  }
  let sumOfSquares = 0;
  for (const [index, value] of vector.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `embedding entry ${index} is not a finite number`;
    }
    sumOfSquares += value * value;
  }
  if (sumOfSquares === 0) {
    return "embedding is a zero vector; cosine distance is undefined";
  }
  return null;
};

/** Both maps are keyed by input index. */
export interface EmbedBatchOutcome {
  embeddings: Map<number, number[]>;
  failures: Map<number, string>;
}

export const embedChunkTexts = async (
  texts: string[],
  config: EmbeddingWorkerConfig,
  hooks: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<EmbedBatchOutcome> => {
  const embeddings = new Map<number, number[]>();
  const failures = new Map<number, string>();
  const validIndexes: number[] = [];
  for (const [index, text] of texts.entries()) {
    if (typeof text !== "string" || text.trim().length === 0) {
      failures.set(index, "chunk text is empty");
      continue;
    }
    validIndexes.push(index);
  }
  const batches: number[][] = [];
  for (let start = 0; start < validIndexes.length; start += config.batchSize) {
    batches.push(validIndexes.slice(start, start + config.batchSize));
  }
  let cursor = 0;
  const runBatch = async (): Promise<void> => {
    for (;;) {
      const batch = batches[cursor];
      cursor += 1;
      if (batch === undefined) {
        return;
      }
      try {
        const vectors = await embedWithRetries(
          config.provider,
          batch.map((index) => texts[index] ?? ""),
          {
            baseDelayMs: config.baseDelayMs,
            maxRetries: config.maxRetries,
            ...(hooks.sleep === undefined ? {} : { sleep: hooks.sleep }),
            timeoutMs: config.timeoutMs,
          }
        );
        for (const [position, index] of batch.entries()) {
          const vector = vectors[position];
          if (vector === undefined) {
            failures.set(index, "embedding is not an array");
            continue;
          }
          const problem = embeddingVectorProblem(
            vector,
            config.provider.dimensions
          );
          if (problem !== null) {
            failures.set(index, problem);
            continue;
          }
          embeddings.set(index, vector);
        }
      } catch (error) {
        const reason = `embedding request failed after ${config.maxRetries + 1} attempts: ${
          error instanceof Error ? error.message : String(error)
        }`;
        for (const index of batch) {
          failures.set(index, reason);
        }
      }
    }
  };
  const workers = Math.max(1, Math.min(config.concurrency, batches.length));
  await Promise.all(Array.from({ length: workers }, () => runBatch()));
  return { embeddings, failures };
};

export type EmbeddingEnv = Record<string, string | undefined>;

const intFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : Number.NaN;
};

/**
 * `KNOWLEDGE_EMBEDDING_PROVIDER` is `fake` (default) or `openai`. The fake
 * provider ignores `KNOWLEDGE_EMBEDDING_MODEL` and tags its vectors
 * `fake/<dims>`; retrieval serves BM25 only while it is configured.
 */
export const embeddingProviderFromEnv = (
  env: EmbeddingEnv = process.env
): EmbeddingProvider => {
  const provider = env.KNOWLEDGE_EMBEDDING_PROVIDER ?? "fake";
  const model = env.KNOWLEDGE_EMBEDDING_MODEL ?? EMBEDDING_MODEL;
  const dimensions = intFromEnv(
    env.KNOWLEDGE_EMBEDDING_DIMENSIONS,
    EMBEDDING_DIMENSIONS
  );
  if (provider === "fake") {
    return createFakeEmbeddingProvider(
      fakeEmbeddingModel(dimensions),
      dimensions
    );
  }
  if (provider === "openai") {
    const baseUrl = env.KNOWLEDGE_EMBEDDING_BASE_URL;
    if (baseUrl === undefined || baseUrl.trim() === "") {
      throw new Error(
        "embedder: KNOWLEDGE_EMBEDDING_BASE_URL is required when KNOWLEDGE_EMBEDDING_PROVIDER=openai"
      );
    }
    const apiKey = env.KNOWLEDGE_EMBEDDING_API_KEY;
    return createOpenAICompatibleProvider({
      baseUrl,
      dimensions,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
  }
  throw new Error(
    `embedder: unknown KNOWLEDGE_EMBEDDING_PROVIDER ${JSON.stringify(provider)} (expected "fake" or "openai")`
  );
};

export const embeddingWorkerConfigFromEnv = (
  env: EmbeddingEnv = process.env,
  provider: EmbeddingProvider = embeddingProviderFromEnv(env)
): EmbeddingWorkerConfig =>
  resolveEmbeddingWorkerConfig({
    baseDelayMs: intFromEnv(env.KNOWLEDGE_EMBEDDING_BASE_DELAY_MS, 250),
    batchSize: intFromEnv(env.KNOWLEDGE_EMBEDDING_BATCH_SIZE, 32),
    concurrency: intFromEnv(env.KNOWLEDGE_EMBEDDING_CONCURRENCY, 4),
    maxRetries: intFromEnv(env.KNOWLEDGE_EMBEDDING_MAX_RETRIES, 3),
    provider,
    timeoutMs: intFromEnv(env.KNOWLEDGE_EMBEDDING_TIMEOUT_MS, 30_000),
  });
