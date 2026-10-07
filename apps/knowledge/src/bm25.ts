/**
 * BM25 keyword retrieval via pg_textsearch over a partial index on live
 * chunks (ADR-002 D7), so superseded text never skews corpus statistics.
 *
 * pg_textsearch skips partial indexes for the implicit `text <@> 'terms'`
 * form, so every query names the index via `to_bm25query`. `<@>` returns the
 * negative BM25 score (best first) and raw scores are not comparable across
 * queries; fusion consumes only the 1-based `rank`.
 *
 * On wide namespaces the planner may post-filter, which can return fewer than
 * `limit` rows; over-fetch if a guaranteed count matters.
 */

import type { PgClient, PgPool } from "./pg-client.ts";
import { parseAnchors } from "./pgvector.ts";
import type { CitationAnchor } from "./pgvector.ts";

export const BM25_TABLE = "chunks";
export const BM25_COLUMN = "text";
export const BM25_ID_COLUMN = "chunk_id";
export const BM25_INDEX_NAME = "chunks_text_bm25";
export const BM25_TEXT_CONFIG = "english";
export const DEFAULT_NAMESPACE = "default";

export const DEFAULT_BM25_LIMIT = 10;

/** `score` is the raw negative BM25 value (lower is better); `rank` is 1-based. */
export interface Bm25Hit {
  anchors: CitationAnchor[];
  chunkId: string;
  documentId: string;
  namespace: string;
  rank: number;
  score: number;
  text: string;
  versionId: string;
}

export interface Bm25SearchOptions {
  limit?: number;
  namespace?: string;
  indexName?: string;
  /** The partial BM25 index covers only live chunks, so this scans sequentially. */
  includeSuperseded?: boolean;
}

export interface Bm25SearchQuery {
  text: string;
  params: unknown[];
}

const INDEX_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;

const validatedIndexName = (indexName: string | undefined): string => {
  const name = indexName ?? BM25_INDEX_NAME;
  if (!INDEX_NAME_PATTERN.test(name)) {
    throw new Error(`bm25: invalid index name ${JSON.stringify(name)}`);
  }
  return name;
};

const validatedNamespace = (namespace: string | undefined): string => {
  const value = namespace ?? DEFAULT_NAMESPACE;
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new Error(`bm25: invalid namespace ${JSON.stringify(value)}`);
  }
  return value;
};

const validatedLimit = (limit: number | undefined): number => {
  const value = limit ?? DEFAULT_BM25_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`bm25: limit must be an integer >= 1, got ${limit}`);
  }
  return value;
};

const validatedQueryText = (query: string): string => {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("bm25: query must be a non-empty string");
  }
  return query;
};

/**
 * The index name is allow-listed and inlined because `to_bm25query` resolves
 * it as an index identity; everything else is a bind parameter.
 */
export const buildBm25SearchQuery = (
  query: string,
  options: Bm25SearchOptions = {}
): Bm25SearchQuery => {
  const text = validatedQueryText(query);
  const namespace = validatedNamespace(options.namespace);
  const indexName = validatedIndexName(options.indexName);
  const limit = validatedLimit(options.limit);
  const literal = `'${indexName.replaceAll("'", "''")}'`;
  const activeOnly = options.includeSuperseded !== true;
  return {
    params: [text, namespace, limit],
    text: `SELECT "${BM25_ID_COLUMN}", "document_id", "version_id", "namespace", "${BM25_COLUMN}", "anchors", ("${BM25_COLUMN}" <@> to_bm25query($1, ${literal})) AS score
FROM "${BM25_TABLE}"
WHERE "namespace" = $2${
      activeOnly
        ? `
  AND "valid_to" IS NULL`
        : ""
    }
ORDER BY ("${BM25_COLUMN}" <@> to_bm25query($1, ${literal})) ASC
LIMIT $3`,
  };
};

export const parseBm25Rows = (rows: Record<string, unknown>[]): Bm25Hit[] =>
  rows.map((row, position) => {
    const context = `bm25: row ${position}`;
    const { anchors, chunk_id: chunkId, document_id: documentId } = row;
    const { namespace, score, text, version_id: versionId } = row;
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
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new TypeError(`${context} (${chunkId}) has no numeric score`);
    }
    return {
      anchors: parseAnchors(anchors, `${context} (${chunkId})`),
      chunkId,
      documentId,
      namespace,
      rank: position + 1,
      score,
      text: typeof text === "string" ? text : "",
      versionId,
    };
  });

export const searchBm25 = async (
  client: PgClient,
  query: string,
  options: Bm25SearchOptions = {}
): Promise<Bm25Hit[]> => {
  const built = buildBm25SearchQuery(query, options);
  const result = await client.query(built.text, built.params);
  return parseBm25Rows(result.rows);
};

/** `pg` is imported lazily so offline consumers never need the driver. */
export const withBm25ClientFromEnv = async <T>(
  fn: (pool: PgPool) => Promise<T>
): Promise<T> => {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "bm25: DATABASE_URL is not set (integration path needs a live Postgres with pg_textsearch)"
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
