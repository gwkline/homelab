/**
 * BM25 keyword retrieval via pg_textsearch (#60).
 *
 * The keyword channel ranks the shared knowledge `chunks` table (ADR-002 D3;
 * the base schema/migration lives in `src/pgvector.ts`) with a partial
 * single-column BM25 index — the "final index shape" from ADR-002 D7:
 *
 *   CREATE INDEX chunks_text_bm25 ON chunks USING bm25 (text)
 *     WITH (text_config = 'english') WHERE valid_to IS NULL;
 *
 * The partial predicate keeps superseded chunks out of the corpus statistics
 * (document counts, average length, per-term IDF), so rankings always reflect
 * the live chunk corpus. Because the index is partial — and because this
 * module always sends a `WHERE` clause — every query names the index
 * explicitly with `to_bm25query($1, 'chunks_text_bm25')`: pg_textsearch skips
 * partial indexes when resolving the implicit `text <@> 'terms'` form, and
 * explicit naming is required for WHERE-clause scoring.
 *
 * Query form (always ORDER BY + LIMIT so Block-Max WAND can drive the scan):
 *
 *   SELECT chunk_id, document_id, version_id, namespace, text, anchors,
 *          (text <@> to_bm25query($1, 'chunks_text_bm25')) AS score
 *   FROM chunks
 *   WHERE namespace = $2 AND valid_to IS NULL
 *   ORDER BY (text <@> to_bm25query($1, 'chunks_text_bm25')) ASC
 *   LIMIT $3;
 *
 * Scores: `<@>` returns the *negative* BM25 score — Postgres only supports
 * ASC index scans on the operator — so the best match sorts first and has the
 * most negative `score`. Raw scores are query-dependent (they depend on the
 * query's IDF and length normalization) and are therefore NOT comparable
 * across queries; the 1-based `rank` field is the stable ordering contract
 * the fusion consumes (ADR-002 D7: "ranks are all the fusion consumes").
 *
 * Namespace filtering (the collection key, ADR-002 D9) is a validated bind
 * parameter supported by the `chunks_namespace_active` B-tree index. With a
 * B-tree-backed filter the planner chooses between pg_textsearch's two
 * documented filter paths:
 *
 * - **Pre-filter** (selective namespaces): the B-tree reduces rows to the
 *   namespace before BM25 scoring — the best case when the filter matches
 *   <10% of the corpus. The EXPLAIN integration test proves this plan on a
 *   sparse namespace fixture.
 * - **Post-filter** (wide namespaces): the BM25 index scan returns rows in
 *   score order and rechecks the namespace predicate during the scan. Because
 *   the top-k is computed against the indexed corpus before filtering,
 *   pg_textsearch may return FEWER than LIMIT rows when a post-filter
 *   eliminates most candidates — increase `limit` and re-limit in the caller
 *   if a guaranteed row count matters. The EXPLAIN integration test proves
 *   the BM25 index path on a wide namespace fixture.
 *
 * `includeSuperseded: true` drops the `valid_to IS NULL` predicate; the
 * partial BM25 index cannot serve that query, so it degrades to a sequential
 * scan (exact, like the pgvector channel's equivalent mode).
 *
 * This module has no hard dependency on a live database: SQL construction
 * (`buildBm25SearchQuery`) and row mapping (`parseBm25Rows`) are pure and
 * covered by offline unit tests. `searchBm25` takes any pg-compatible client
 * (`{ query(text, params) }`), and `withBm25ClientFromEnv` is the only piece
 * that touches `DATABASE_URL` / opens a connection (integration path).
 */

import { parseAnchors } from "./pgvector.ts";
import type { CitationAnchor } from "./pgvector.ts";

export const BM25_TABLE = "chunks";
export const BM25_COLUMN = "text";
export const BM25_ID_COLUMN = "chunk_id";
export const BM25_INDEX_NAME = "chunks_text_bm25";
export const BM25_TEXT_CONFIG = "english";
export const DEFAULT_NAMESPACE = "default";

/** Default candidate count when the caller does not specify `limit`. */
export const DEFAULT_BM25_LIMIT = 10;

/** Schema/migration version to record in eval provenance once applied. */
export const BM25_SCHEMA_VERSION = "1-bm25-chunks";

/**
 * Idempotent migration: extension, the namespace B-tree supporting the
 * collection filter, and the partial BM25 index this module queries.
 *
 * The `chunks` table itself is the shared knowledge schema (ADR-002 D3/#56,
 * applied by `ensurePgvectorSchema` in src/pgvector.ts) — run this migration
 * after it. Both indexes are `IF NOT EXISTS` with definitions matching the
 * base schema, so re-applying against a fully migrated cluster is a no-op.
 */
export const BM25_MIGRATION_SQL = `CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE INDEX IF NOT EXISTS chunks_namespace_active
  ON chunks (namespace) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS chunks_text_bm25
  ON chunks USING bm25 (text)
  WITH (text_config = 'english')
  WHERE valid_to IS NULL;`;

/**
 * One ranked keyword hit. Result shape matches the vector channel's candidate
 * contract: the chunk (id + text), its document version, its rank/score, and
 * citation anchors. `score` is the raw negative BM25 value (lower = better);
 * `rank` is the 1-based position in the returned order.
 */
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
  /**
   * Max candidates to return. Must be an integer >= 1.
   * Defaults to `DEFAULT_BM25_LIMIT`.
   */
  limit?: number;
  /** Namespace (collection key) to search. Defaults to `DEFAULT_NAMESPACE`. */
  namespace?: string;
  /**
   * BM25 index named in `to_bm25query`. Defaults to `BM25_INDEX_NAME`.
   * Must be a bare identifier (letters, digits, underscore).
   */
  indexName?: string;
  /**
   * Include superseded chunks (`valid_to` set). Defaults to `false`; because
   * the partial BM25 index only covers live chunks, `true` scans sequentially.
   */
  includeSuperseded?: boolean;
}

/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface Bm25DbClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** Parameterized SELECT text plus bind params for `client.query`. */
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
 * Build the parameterized keyword query. Pure — no I/O, safe to unit test
 * without a database. The query text, namespace, and limit are bind
 * parameters (never interpolated); the index name is allow-list validated and
 * inlined as a quoted literal because `to_bm25query` resolves it as an index
 * identity. Ranking/order uses the exact expression the partial BM25 index
 * serves; the same expression in the SELECT list exposes the raw score.
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

/**
 * Map raw driver rows to hits, assigning 1-based ranks in returned order.
 * Throws on malformed rows (missing ids, non-numeric score, broken anchors)
 * rather than silently ranking garbage; missing chunk text coerces to ""
 * exactly like the vector mapper (the column is NOT NULL anyway).
 */
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

/**
 * Ranked keyword search over the live chunks of one namespace. Best match
 * first (`score` ascending — scores are negative BM25). Throws on empty
 * query / bad namespace / bad limit before touching the client.
 */
export const searchBm25 = async (
  client: Bm25DbClient,
  query: string,
  options: Bm25SearchOptions = {}
): Promise<Bm25Hit[]> => {
  const built = buildBm25SearchQuery(query, options);
  const result = await client.query(built.text, built.params);
  return parseBm25Rows(result.rows);
};

/** Run the idempotent migration (`BM25_MIGRATION_SQL`) on `client`. */
export const ensureBm25Schema = async (client: Bm25DbClient): Promise<void> => {
  await client.query(BM25_MIGRATION_SQL, []);
};

/**
 * Integration path: connect with `DATABASE_URL`, hand the live client to
 * `fn`, always close afterwards. `pg` is imported lazily so unit tests and
 * offline consumers never need the driver installed.
 */
export const withBm25ClientFromEnv = async <T>(
  fn: (client: Bm25DbClient) => Promise<T>
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
