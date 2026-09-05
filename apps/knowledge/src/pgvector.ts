/**
 * Semantic retrieval via pgvector (#62).
 *
 * Embeddings live in a `vector(384)` column (ADR-002 D6: local
 * `BAAI/bge-small-en-v1.5`, 384-d, cosine) and are ranked with the HNSW
 * approximate nearest neighbor index:
 *
 *   CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)
 *     WHERE valid_to IS NULL AND embedding IS NOT NULL;
 *   SELECT ..., embedding <=> $1::vector AS distance
 *     FROM chunks
 *     WHERE namespace = $2 AND embedding_model = $3
 *       AND embedding IS NOT NULL AND valid_to IS NULL
 *     ORDER BY embedding <=> $1::vector ASC LIMIT $4;
 *
 * Cosine distance (`<=>`, `vector_cosine_ops`) matches the selected embedding
 * model; scores are lower-is-better and ranks (1-based positions) are what the
 * fusion contract consumes. Namespace (the collection key, ADR-002 D9) and
 * active-version (`valid_to IS NULL`, i.e. the chunk is live in the current
 * document version) are parameterized predicates, never interpolated.
 *
 * Explicit behavior for edge cases:
 * - Query embedding empty/zero/wrong dimension/non-finite → throws before any
 *   database call, naming the expected model and dimension.
 * - Chunk rows with missing embeddings, a missing model tag, or another
 *   model's tag are never mixed into results (`embedding_model = $3` +
 *   `embedding IS NOT NULL`); they are surfaced by `countChunksNeedingBackfill`
 *   for the re-embed backfill job (ADR-002 D10: a model swap is a backfill,
 *   not an in-place rewrite).
 * - `includeSuperseded` drops the `valid_to IS NULL` predicate; because the
 *   partial HNSW index only covers live chunks, that mode scans sequentially
 *   and is therefore exact.
 *
 * An exact sequential-scan baseline (`searchPgvectorExact`, via
 * `SET LOCAL enable_indexscan = off`) exists for tests/evaluation on small
 * datasets; `hnswRecall` compares approximate top-k against it.
 *
 * Like `src/bm25.ts`, SQL construction and row mapping are pure and covered by
 * offline unit tests; `searchPgvector`/`searchPgvectorExact` take any
 * pg-compatible client, and `withPgvectorClientFromEnv` is the only piece that
 * touches `DATABASE_URL` / opens a connection.
 */

export const PGVECTOR_TABLE = "chunks";
export const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_METRIC = "cosine";
export const HNSW_OPERATOR_CLASS = "vector_cosine_ops";
export const DISTANCE_OPERATOR = "<=>";
export const DEFAULT_NAMESPACE = "default";
/** pgvector's built-in `hnsw.ef_search` default, pinned explicitly per query. */
export const DEFAULT_EF_SEARCH = 40;
/** Default candidate count when the caller does not specify `limit`. */
export const DEFAULT_VECTOR_LIMIT = 10;

/** Schema/migration version to record in eval provenance once applied. */
export const PGVECTOR_SCHEMA_VERSION = "1-pgvector-chunks";

/**
 * Idempotent migration: extension, `chunks` table (document version +
 * citation anchors denormalized for single-table retrieval), a plain
 * namespace index supporting pre-filtering, and the partial HNSW index this
 * module queries. The `vector(384)` typmod pins the model dimension — a model
 * whose dimension differs needs a new column/migration alongside the re-embed
 * backfill (ADR-002 D6/D10).
 */
export const PGVECTOR_MIGRATION_SQL = `CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  text TEXT NOT NULL,
  anchors JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding vector(384),
  embedding_model TEXT,
  valid_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_namespace_active
  ON chunks (namespace) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WHERE valid_to IS NULL AND embedding IS NOT NULL;`;

/** Citation anchor stored per chunk (JSONB), mirroring the #56 contract. */
export interface CitationAnchor {
  type: "offset" | "heading";
  start?: number;
  end?: number;
  value?: string;
}

/**
 * One ranked semantic hit. Result shape matches the BM25 candidate contract:
 * the chunk (id + text), its document version, its rank/score, and citation
 * anchors. `distance` is cosine distance (lower = better); `rank` is the
 * 1-based position in the returned order.
 */
export interface PgvectorHit {
  anchors: CitationAnchor[];
  chunkId: string;
  distance: number;
  documentId: string;
  namespace: string;
  rank: number;
  text: string;
  versionId: string;
}

export interface PgvectorSearchOptions {
  /**
   * Max candidates to return. Must be an integer >= 1.
   * Defaults to `DEFAULT_VECTOR_LIMIT`.
   */
  limit?: number;
  /** Namespace (collection key) to search. Defaults to `DEFAULT_NAMESPACE`. */
  namespace?: string;
  /**
   * Include superseded chunks (`valid_to` set). Defaults to `false`; because
   * the partial HNSW index only covers live chunks, `true` scans sequentially.
   */
  includeSuperseded?: boolean;
  /**
   * Model generation to search. Defaults to `EMBEDDING_MODEL`; chunks tagged
   * with any other model are filtered out, never mixed (ADR-002 D6/D10).
   */
  embeddingModel?: string;
  /**
   * HNSW exploration breadth (`hnsw.ef_search`). Must be an integer >= 1.
   * Defaults to `DEFAULT_EF_SEARCH`; ignored by the exact path.
   */
  efSearch?: number;
}

/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface PgvectorDbClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Parameterized SELECT text plus bind params for `client.query`. */
export interface PgvectorSearchQuery {
  text: string;
  params: unknown[];
}

/**
 * Bucketed visibility report for the re-embed backfill job (#62): retrieval
 * only ever sees `ready` rows; the other buckets say exactly what is missing
 * and why, so empty results are diagnosable instead of mysterious.
 */
export interface PgvectorBackfillCounts {
  embeddingModel: string;
  /** Embedded under a different model (or untagged): generation mismatch. */
  modelMismatch: number;
  /** No embedding at all (never embedded or cleared for re-embed). */
  missingEmbedding: number;
  namespace: string;
  /** Embedded under `embeddingModel` — the only rows retrieval can see. */
  ready: number;
  total: number;
}

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;
const MODEL_PATTERN = /^[\w./-]{1,128}$/u;
const ANCHOR_TYPES = new Set(["offset", "heading"]);

const validatedNamespace = (namespace: string | undefined): string => {
  const value = namespace ?? DEFAULT_NAMESPACE;
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new Error(`pgvector: invalid namespace ${JSON.stringify(value)}`);
  }
  return value;
};

const validatedModel = (model: string | undefined): string => {
  const value = model ?? EMBEDDING_MODEL;
  if (!MODEL_PATTERN.test(value)) {
    throw new Error(
      `pgvector: invalid embedding model ${JSON.stringify(value)}`
    );
  }
  return value;
};

const validatedLimit = (limit: number | undefined): number => {
  const value = limit ?? DEFAULT_VECTOR_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`pgvector: limit must be an integer >= 1, got ${limit}`);
  }
  return value;
};

const validatedEfSearch = (efSearch: number | undefined): number => {
  const value = efSearch ?? DEFAULT_EF_SEARCH;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `pgvector: efSearch must be an integer >= 1, got ${efSearch}`
    );
  }
  return value;
};

/**
 * Validate a query embedding before it can reach the database: it must be a
 * finite, non-zero numeric vector whose dimension matches the indexed model.
 * Every failure names the expectation it violated so a mismatch between the
 * query embedder and the indexed chunks fails loudly, not silently.
 */
export const validateQueryEmbedding = (
  queryEmbedding: unknown,
  dimensions: number = EMBEDDING_DIMENSIONS
): number[] => {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    throw new TypeError(
      "pgvector: query embedding is required (non-empty array of numbers)"
    );
  }
  if (queryEmbedding.length !== dimensions) {
    throw new Error(
      `pgvector: query embedding has ${queryEmbedding.length} dimensions, expected ${dimensions} (${EMBEDDING_MODEL}); re-embed the query with the model the chunks were indexed under`
    );
  }
  let sumOfSquares = 0;
  for (const [index, value] of queryEmbedding.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new TypeError(
        `pgvector: query embedding entry ${index} is not a finite number`
      );
    }
    sumOfSquares += value * value;
  }
  if (sumOfSquares === 0) {
    throw new Error(
      "pgvector: query embedding is a zero vector; cosine distance is undefined — re-embed the query"
    );
  }
  return queryEmbedding;
};

/** Serialize an embedding to pgvector's text literal format (`[a,b,c]`). */
export const toPgvectorLiteral = (embedding: number[]): string =>
  `[${embedding.map(String).join(",")}]`;

/**
 * Build the parameterized ANN query (HNSW path). Pure — no I/O, safe to unit
 * test without a database. The embedding, namespace, model, and limit are
 * bind parameters; nothing caller-controlled is interpolated.
 */
export const buildPgvectorSearchQuery = (
  queryEmbedding: number[],
  options: PgvectorSearchOptions = {}
): PgvectorSearchQuery => {
  const embedding = validateQueryEmbedding(queryEmbedding);
  const namespace = validatedNamespace(options.namespace);
  const model = validatedModel(options.embeddingModel);
  const limit = validatedLimit(options.limit);
  const literal = toPgvectorLiteral(embedding);
  const activeOnly = options.includeSuperseded !== true;
  const params: unknown[] = [literal, namespace, model, limit];
  const text = `SELECT "chunk_id", "document_id", "version_id", "namespace", "text", "anchors", ("embedding" ${DISTANCE_OPERATOR} $1::vector) AS distance
FROM "${PGVECTOR_TABLE}"
WHERE "namespace" = $2
  AND "embedding_model" = $3
  AND "embedding" IS NOT NULL${
    activeOnly
      ? `
  AND "valid_to" IS NULL`
      : ""
  }
ORDER BY "embedding" ${DISTANCE_OPERATOR} $1::vector ASC
LIMIT $4`;
  return { params, text };
};

/**
 * Build the `SET LOCAL hnsw.ef_search = <n>` statement. `SET` cannot take
 * bind parameters, so the value is validated and inlined; SET LOCAL scopes it
 * to the search's transaction, leaving the session untouched.
 */
export const buildEfSearchStatement = (efSearch: number): string => {
  const value = validatedEfSearch(efSearch);
  return `SET LOCAL hnsw.ef_search = ${value}`;
};

/** Transaction prelude forcing a sequential scan for the exact baseline. */
export const PGVECTOR_EXACT_SCAN_GUARD = "SET LOCAL enable_indexscan = off";

const ANCHOR_NUMBER_KEYS = ["start", "end"] as const;

const parseAnchor = (raw: unknown, context: string): CitationAnchor => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError(`${context}: anchor entry is not an object`);
  }
  const record = raw as Record<string, unknown>;
  const { type } = record;
  if (typeof type !== "string" || !ANCHOR_TYPES.has(type)) {
    throw new TypeError(
      `${context}: anchor type must be "offset" or "heading"`
    );
  }
  const anchor: CitationAnchor = {
    type: type === "offset" ? "offset" : "heading",
  };
  for (const key of ANCHOR_NUMBER_KEYS) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new TypeError(`${context}: anchor ${key} must be an integer >= 0`);
    }
    anchor[key] = value;
  }
  const { value: heading } = record;
  if (heading !== undefined) {
    if (typeof heading !== "string" || heading.length === 0) {
      throw new TypeError(
        `${context}: anchor value must be a non-empty string`
      );
    }
    anchor["value"] = heading;
  }
  return anchor;
};

/**
 * Parse a chunk's citation anchors from its JSONB cell: an array of
 * well-formed anchors, never a fabricated one. Malformed provenance throws
 * rather than ranking an unciteable chunk.
 */
export const parseAnchors = (
  raw: unknown,
  context: string
): CitationAnchor[] => {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new TypeError(`${context}: anchors are not valid JSON`, {
        cause: error,
      });
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${context}: anchors must be a JSON array`);
  }
  return parsed.map((entry) => parseAnchor(entry, context));
};

/**
 * Map raw driver rows to hits, assigning 1-based ranks in returned order.
 * Throws on malformed rows (missing ids, non-numeric distance, broken
 * anchors) rather than silently ranking garbage; missing chunk text coerces
 * to "" exactly like the BM25 mapper (the column is NOT NULL anyway).
 */
export const parsePgvectorRows = (
  rows: Record<string, unknown>[]
): PgvectorHit[] =>
  rows.map((row, position) => {
    const context = `pgvector: row ${position}`;
    const { anchors, chunk_id: chunkId, distance } = row;
    const { document_id: documentId, namespace, version_id: versionId } = row;
    const { text } = row;
    if (typeof chunkId !== "string" || chunkId.length === 0) {
      throw new TypeError(`${context} has no string chunk_id`);
    }
    if (typeof documentId !== "string" || documentId.length === 0) {
      throw new TypeError(`${context} (${chunkId}) has no string document_id`);
    }
    if (typeof versionId !== "string" || versionId.length === 0) {
      throw new TypeError(`${context} (${chunkId}) has no string version_id`);
    }
    if (typeof namespace !== "string" || namespace.length === 0) {
      throw new TypeError(`${context} (${chunkId}) has no string namespace`);
    }
    if (typeof distance !== "number" || !Number.isFinite(distance)) {
      throw new TypeError(`${context} (${chunkId}) has no numeric distance`);
    }
    return {
      anchors: parseAnchors(anchors, `${context} (${chunkId})`),
      chunkId,
      distance,
      documentId,
      namespace,
      rank: position + 1,
      text: typeof text === "string" ? text : "",
      versionId,
    };
  });

const runVectorQuery = async (
  client: PgvectorDbClient,
  prelude: string | null,
  built: PgvectorSearchQuery
): Promise<PgvectorHit[]> => {
  await client.query("BEGIN", []);
  try {
    if (prelude !== null) {
      await client.query(prelude, []);
    }
    const result = await client.query(built.text, built.params);
    await client.query("COMMIT", []);
    return parsePgvectorRows(result.rows);
  } catch (error) {
    try {
      await client.query("ROLLBACK", []);
    } catch {
      // The original failure is the one worth surfacing.
    }
    throw error;
  }
};

/**
 * Approximate (HNSW) semantic search. Runs `SET LOCAL hnsw.ef_search` inside
 * the search transaction so `efSearch` applies to exactly this query and is
 * recordable per eval run. Requires a dedicated client (single connection);
 * do not share a pooled connection across concurrent searches.
 */
export const searchPgvector = async (
  client: PgvectorDbClient,
  queryEmbedding: number[],
  options: PgvectorSearchOptions = {}
): Promise<PgvectorHit[]> => {
  const built = buildPgvectorSearchQuery(queryEmbedding, options);
  const efSearchStatement = buildEfSearchStatement(
    options.efSearch ?? DEFAULT_EF_SEARCH
  );
  return await runVectorQuery(client, efSearchStatement, built);
};

/**
 * Exact baseline: the identical ranking query executed under
 * `SET LOCAL enable_indexscan = off`, forcing a sequential scan that computes
 * true cosine distances for every indexed row. Intended for tests/evaluation
 * on small datasets; `hnswRecall` measures the approximate channel against it.
 */
export const searchPgvectorExact = async (
  client: PgvectorDbClient,
  queryEmbedding: number[],
  options: PgvectorSearchOptions = {}
): Promise<PgvectorHit[]> => {
  const built = buildPgvectorSearchQuery(queryEmbedding, options);
  return await runVectorQuery(client, PGVECTOR_EXACT_SCAN_GUARD, built);
};

/**
 * HNSW recall vs exact ground truth: |approximate ∩ exact| / |exact| over the
 * two top-k id lists. An empty exact list is vacuously perfect (nothing to
 * find); duplicate ids count once. Deterministic — pure set arithmetic.
 */
export const hnswRecall = (approximate: string[], exact: string[]): number => {
  const truth = new Set(exact);
  if (truth.size === 0) {
    return 1;
  }
  const found = new Set<string>();
  for (const chunkId of approximate) {
    if (truth.has(chunkId)) {
      found.add(chunkId);
    }
  }
  return found.size / truth.size;
};

/**
 * Build the visibility count query backing `countChunksNeedingBackfill`:
 * one pass over a namespace bucketing rows by embedding readiness.
 */
export const buildBackfillCountQuery = (
  namespace: string,
  embeddingModel: string = EMBEDDING_MODEL
): PgvectorSearchQuery => {
  const validNamespace = validatedNamespace(namespace);
  const validModel = validatedModel(embeddingModel);
  return {
    params: [validNamespace, validModel],
    text: `SELECT count(*) AS total,
  count(*) FILTER (WHERE "embedding" IS NULL) AS missing_embedding,
  count(*) FILTER (WHERE "embedding" IS NOT NULL AND ("embedding_model" IS NULL OR "embedding_model" <> $2)) AS model_mismatch,
  count(*) FILTER (WHERE "embedding" IS NOT NULL AND "embedding_model" = $2) AS ready
FROM "${PGVECTOR_TABLE}"
WHERE "namespace" = $1`,
  };
};

const validatedCount = (value: unknown, context: string): number => {
  // `count(*)` is bigint: node-postgres hands it back as a string.
  let parsed = Number.NaN;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d+$/u.test(value)) {
    parsed = Number(value);
  }
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${context} is not a non-negative integer count`);
  }
  return parsed;
};

/** Map one raw count row to the backfill report. */
export const parseBackfillCounts = (
  namespace: string,
  embeddingModel: string,
  row: Record<string, unknown>
): PgvectorBackfillCounts => ({
  embeddingModel,
  missingEmbedding: validatedCount(
    row["missing_embedding"],
    "missing_embedding"
  ),
  modelMismatch: validatedCount(row["model_mismatch"], "model_mismatch"),
  namespace,
  ready: validatedCount(row["ready"], "ready"),
  total: validatedCount(row["total"], "total"),
});

/**
 * Report how many chunks in `namespace` are missing embeddings or tagged with
 * another model generation — the explicit contract for empty/missing
 * embeddings and model migrations (#62): such rows can never appear in
 * results, and this says how many are waiting on the backfill job.
 */
export const countChunksNeedingBackfill = async (
  client: PgvectorDbClient,
  namespace: string,
  embeddingModel: string = EMBEDDING_MODEL
): Promise<PgvectorBackfillCounts> => {
  const built = buildBackfillCountQuery(namespace, embeddingModel);
  const result = await client.query(built.text, built.params);
  const [row] = result.rows;
  if (!row) {
    throw new TypeError("pgvector: backfill count query returned no rows");
  }
  return parseBackfillCounts(namespace, embeddingModel, row);
};

/** Run the idempotent migration (`PGVECTOR_MIGRATION_SQL`) on `client`. */
export const ensurePgvectorSchema = async (
  client: PgvectorDbClient
): Promise<void> => {
  await client.query(PGVECTOR_MIGRATION_SQL, []);
};

/**
 * Integration path: connect with `DATABASE_URL`, check out a single client
 * (the transactional searches need one connection), hand it to `fn`, always
 * release + close afterwards. `pg` is imported lazily so unit tests and
 * offline consumers never need the driver installed.
 */
export const withPgvectorClientFromEnv = async <T>(
  fn: (client: PgvectorDbClient) => Promise<T>
): Promise<T> => {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "pgvector: DATABASE_URL is not set (integration path needs a live Postgres with pgvector)"
    );
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
};
