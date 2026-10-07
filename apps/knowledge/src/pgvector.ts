/**
 * Semantic retrieval over a partial HNSW index on `vector(384)` cosine
 * embeddings (ADR-002 D6). Rows embedded under another model, or not at all,
 * are never mixed into results; `countChunksNeedingBackfill` reports them.
 */

import type { PgClient, PgPool } from "./pg-client.ts";
import { withTransaction } from "./pg-client.ts";

export const PGVECTOR_TABLE = "chunks";
export const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_METRIC = "cosine";
export const HNSW_OPERATOR_CLASS = "vector_cosine_ops";
export const DISTANCE_OPERATOR = "<=>";
export const DEFAULT_NAMESPACE = "default";
/** pgvector's built-in `hnsw.ef_search` default, pinned explicitly per query. */
export const DEFAULT_EF_SEARCH = 40;
export const DEFAULT_VECTOR_LIMIT = 10;

export interface CitationAnchor {
  type: "offset" | "heading";
  start?: number;
  end?: number;
  value?: string;
}

/** `distance` is cosine distance (lower is better); `rank` is 1-based. */
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
  limit?: number;
  namespace?: string;
  /** The partial HNSW index covers only live chunks, so this scans sequentially. */
  includeSuperseded?: boolean;
  embeddingModel?: string;
  /** `hnsw.ef_search`; ignored by the exact path. */
  efSearch?: number;
}

export interface PgvectorSearchQuery {
  text: string;
  params: unknown[];
}

/** Retrieval only sees `ready` rows; the other buckets explain empty results. */
export interface PgvectorBackfillCounts {
  embeddingModel: string;
  /** Embedded under a different model, or untagged. */
  modelMismatch: number;
  missingEmbedding: number;
  namespace: string;
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

export const toPgvectorLiteral = (embedding: number[]): string =>
  `[${embedding.map(String).join(",")}]`;

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

/** `SET` cannot take bind parameters, so the validated value is inlined. */
export const buildEfSearchStatement = (efSearch: number): string => {
  const value = validatedEfSearch(efSearch);
  return `SET LOCAL hnsw.ef_search = ${value}`;
};

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

/** Malformed anchors throw rather than ranking an unciteable chunk. */
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

const runVectorQuery = (
  pool: PgPool,
  prelude: string,
  built: PgvectorSearchQuery
): Promise<PgvectorHit[]> =>
  withTransaction(pool, async (client) => {
    await client.query(prelude, []);
    const result = await client.query(built.text, built.params);
    return parsePgvectorRows(result.rows);
  });

/** HNSW search; `efSearch` is `SET LOCAL`, scoped to its own transaction. */
export const searchPgvector = async (
  pool: PgPool,
  queryEmbedding: number[],
  options: PgvectorSearchOptions = {}
): Promise<PgvectorHit[]> => {
  const built = buildPgvectorSearchQuery(queryEmbedding, options);
  const efSearchStatement = buildEfSearchStatement(
    options.efSearch ?? DEFAULT_EF_SEARCH
  );
  return await runVectorQuery(pool, efSearchStatement, built);
};

/** Same query forced to a sequential scan: the ground truth for `hnswRecall`. */
export const searchPgvectorExact = async (
  pool: PgPool,
  queryEmbedding: number[],
  options: PgvectorSearchOptions = {}
): Promise<PgvectorHit[]> => {
  const built = buildPgvectorSearchQuery(queryEmbedding, options);
  return await runVectorQuery(pool, PGVECTOR_EXACT_SCAN_GUARD, built);
};

/** |approximate ∩ exact| / |exact|; an empty exact list is vacuously 1. */
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

export const countChunksNeedingBackfill = async (
  client: PgClient,
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

/** `pg` is imported lazily so offline consumers never need the driver. */
export const withPgvectorClientFromEnv = async <T>(
  fn: (pool: PgPool) => Promise<T>
): Promise<T> => {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "pgvector: DATABASE_URL is not set (integration path needs a live Postgres with pgvector)"
    );
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
};
