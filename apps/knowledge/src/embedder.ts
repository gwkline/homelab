/**
 * Embedding configuration, providers, and the batch engine (#57).
 *
 * Provider, model, and dimensions are configuration (env or explicit), and
 * the model identity is persisted per chunk by the ingest worker, so chunks
 * from different model generations are always distinguishable (ADR-002 D6:
 * different models never mix in one index — `src/pgvector.ts` filters on
 * `embedding_model`).
 *
 * The request engine is explicit and bounded:
 *
 * - **Batching** — chunk texts are grouped into `batchSize`-sized inputs per
 *   provider request (ADR-002 D5: batch, don't embed one-by-one).
 * - **Concurrency** — at most `concurrency` provider requests are in flight;
 *   results are keyed by input index, so completion order cannot matter.
 * - **Timeout** — every attempt runs under `AbortSignal.timeout(timeoutMs)`;
 *   providers forward the signal to their transport.
 * - **Retries** — retryable failures (timeouts, network errors, HTTP
 *   408/429/5xx) are retried up to `maxRetries` with exponential backoff
 *   `baseDelayMs * 2^(attempt-1)`; the sleep is injectable so tests need no
 *   real timers. Non-retryable failures (other HTTP 4xx) throw immediately.
 * - **Per-chunk isolation** — an invalid input or an invalid vector (wrong
 *   dimension, non-finite or zero entries) fails exactly that chunk; the
 *   valid chunks in the same batch still embed and persist.
 *
 * Dimension honesty: the configured provider dimension must equal the
 * `chunks` table's `vector(N)` typmod (`dbDimensions`, default 384 for the
 * local `BAAI/bge-small-en-v1.5`), and every returned vector is re-validated
 * before persistence. A model with a different dimension is a new column +
 * migration plus a re-embed backfill (ADR-002 D6/D10) — never a vector
 * written into the wrong-typed column.
 *
 * `createFakeEmbeddingProvider` is a fully deterministic, offline provider
 * (sha256-derived unit vectors) for tests and seed corpora — it must never
 * back real retrieval.
 */

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { DEFAULT_MAX_CHARS } from "./chunk.ts";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./pgvector.ts";

/** The provider surface every embedder implements. */
export interface EmbeddingProvider {
  /** Vector dimension this provider produces. */
  dimensions: number;
  /** Embed `inputs` in one request; returns one vector per input, in order. */
  embed: (
    inputs: string[],
    options?: { signal?: AbortSignal }
  ) => Promise<number[][]>;
  /** Model identifier persisted on every chunk this provider embeds. */
  model: string;
  /** Provider kind, e.g. `"fake"` or `"openai-compatible"`. */
  name: string;
}

/** Provider/transport failure with an explicit retryability verdict. */
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

/**
 * Decide whether a provider failure is worth retrying: transport errors,
 * timeouts/aborts, and HTTP 408/429/5xx are transient; other 4xx responses
 * are not.
 */
export const isRetryableEmbeddingError = (error: unknown): boolean => {
  if (error instanceof EmbeddingProviderError) {
    return error.retryable;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  return false;
};

/**
 * Deterministic offline provider: each vector is sha256-derived from
 * `(model, input)` and L2-normalized, so identical inputs embed identically
 * across runs, machines, and call orders. For tests and offline seed data
 * only — retrieval must run against a real provider.
 */
export const createFakeEmbeddingProvider = (
  model = "fake/deterministic-v1",
  dimensions = EMBEDDING_DIMENSIONS
): EmbeddingProvider => {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new TypeError(
      `embedder: fake provider dimensions must be an integer >= 1, got ${String(dimensions)}`
    );
  }
  const fakeVector = (input: string): number[] => {
    const vector: number[] = [];
    let block = 0;
    while (vector.length < dimensions) {
      const digest = createHash("sha256")
        .update(`${model}\u0000${input}\u0000${block}`, "utf-8")
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
    model,
    name: "fake",
  };
};

export interface OpenAICompatibleProviderOptions {
  /** Bearer token; omitted when unset (self-hosted servers need none). */
  apiKey?: string;
  /** API root, e.g. `http://tei.home.svc:80/v1` — `/embeddings` is appended. */
  baseUrl: string;
  dimensions: number;
  model: string;
}

/**
 * OpenAI-compatible `/embeddings` provider (self-hosted TEI/llama.cpp/
 * vLLM-style servers): `POST {model, input}` → `{data: [{index, embedding}]}`.
 * Batching is the engine's job; this layer sends exactly the inputs it is
 * given, forwards the abort signal, and validates the response shape before
 * returning — a short or misshapen batch is a provider error, never a silent
 * partial result.
 */
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
  /** Chunk texts per provider request. Default 32. */
  batchSize?: number;
  /** Exponential backoff base in milliseconds. Default 250. */
  baseDelayMs?: number;
  /** Max in-flight provider requests. Default 4. */
  concurrency?: number;
  /**
   * The `chunks` column's pinned `vector(N)` dimension. Default 384
   * (`EMBEDDING_DIMENSIONS`). A provider whose dimension differs is refused:
   * a model change needs a new column + migration and a re-embed backfill
   * (ADR-002 D6/D10), not vectors written into the wrong-typed column.
   */
  dbDimensions?: number;
  /** Chunker soft cap forwarded to the chunker. Default `DEFAULT_MAX_CHARS`. */
  maxChars?: number;
  /** Retries per provider request after the first attempt. Default 3. */
  maxRetries?: number;
  provider: EmbeddingProvider;
  /** Per-attempt timeout in milliseconds. Default 30_000. */
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

/** Validate and default the worker's explicit limits before any request runs. */
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
  /** Injectable sleep for deterministic tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * One provider request with explicit retry semantics: up to `maxRetries`
 * retries for retryable failures (timeout, network, 408/429/5xx) with
 * exponential backoff `baseDelayMs * 2^(attempt-1)`; non-retryable failures
 * throw immediately. Every attempt gets a fresh `AbortSignal.timeout`.
 */
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

/**
 * Validate one returned vector before persistence: finite numbers, the exact
 * expected dimension, non-zero (cosine is undefined on zero vectors).
 * Returns the failure reason, or null when the vector is usable.
 */
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

export interface EmbedBatchOutcome {
  /** Input index → validated embedding, for every chunk that embedded. */
  embeddings: Map<number, number[]>;
  /** Input index → failure reason, for every chunk that did not embed. */
  failures: Map<number, string>;
}

/**
 * Embed a list of chunk texts with explicit batching, bounded concurrency,
 * timeouts, retries, and per-chunk failure isolation:
 *
 * - Inputs that are unusable on their own (empty text) fail individually
 *   before any request.
 * - A provider request that keeps failing after its retries fails only the
 *   chunks in that batch.
 * - A malformed vector for one input fails only that chunk; every valid
 *   vector in the same batch is kept.
 */
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

/** String-typed view of the env keys this module reads. */
export type EmbeddingEnv = Record<string, string | undefined>;

const intFromEnv = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) ? value : Number.NaN;
};

/**
 * Select the embedding provider from configuration:
 * `KNOWLEDGE_EMBEDDING_PROVIDER` = `fake` (default, deterministic offline) or
 * `openai` (OpenAI-compatible HTTP against `KNOWLEDGE_EMBEDDING_BASE_URL`),
 * with `KNOWLEDGE_EMBEDDING_MODEL` / `KNOWLEDGE_EMBEDDING_DIMENSIONS` /
 * `KNOWLEDGE_EMBEDDING_API_KEY`.
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
    return createFakeEmbeddingProvider(model, dimensions);
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

/** Resolve the full worker configuration from env plus an optional provider. */
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
