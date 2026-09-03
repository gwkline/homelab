/**
 * BM25 keyword retrieval via pg_textsearch (#60).
 *
 * Single-column `USING bm25` index with `text_config = 'english'`, ranked
 * with the `text <@> query` operator (pg_textsearch v1.4.0 API). `<@>`
 * returns the *negative* BM25 score — Postgres only supports ASC index
 * scans on the operator — so the best match sorts first under plain
 * `ORDER BY ... ASC`.
 *
 * Query form (explicit index; the implicit `text <@> 'terms'` form cannot
 * address partial indexes, so this module always names the index):
 *
 *   SELECT id, content, content <@> to_bm25query($1, 'docs_content_bm25')
 *     FROM docs ORDER BY score ASC LIMIT $2;
 *
 * This module has no hard dependency on a live database: SQL construction
 * (`buildBm25SearchQuery`) and row mapping (`parseBm25Rows`) are pure and
 * covered by offline unit tests. `searchBm25` takes any pg-compatible client
 * (`{ query(text, params) }`), and `connectBm25FromEnv` is the only piece
 * that touches `DATABASE_URL` / opens a connection (integration path).
 */

export const BM25_TABLE = "docs";
export const BM25_COLUMN = "content";
export const BM25_ID_COLUMN = "id";
export const BM25_INDEX_NAME = "docs_content_bm25";
export const BM25_TEXT_CONFIG = "english";

/** Schema/migration version to record in eval provenance once applied. */
export const BM25_SCHEMA_VERSION = "1-bm25-docs";

/**
 * Idempotent migration: extension, `docs` table, and the single-column BM25
 * index this module queries. Run via `ensureBm25Schema` (integration path).
 */
export const BM25_MIGRATION_SQL = `CREATE EXTENSION IF NOT EXISTS pg_textsearch;
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_content_bm25
  ON docs USING bm25 (content)
  WITH (text_config = 'english');`;

/** Default candidate count when the caller does not specify `limit`. */
export const DEFAULT_BM25_LIMIT = 10;

/** One ranked keyword hit. `score` is negative BM25 (lower = better). */
export interface Bm25Hit {
  id: string;
  content: string;
  score: number;
}

export interface Bm25SearchOptions {
  /**
   * Max candidates to return. Must be an integer >= 1.
   * Defaults to `DEFAULT_BM25_LIMIT`.
   */
  limit?: number;
  /**
   * BM25 index named in `to_bm25query`. Defaults to `BM25_INDEX_NAME`.
   * Must be a bare identifier (letters, digits, underscore).
   */
  indexName?: string;
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

const validatedIndexName = (indexName: string | undefined): string => {
  const name = indexName ?? BM25_INDEX_NAME;
  if (!INDEX_NAME_PATTERN.test(name)) {
    throw new Error(`bm25: invalid index name ${JSON.stringify(name)}`);
  }
  return name;
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
 * without a database. The query text is bound as `$1` (never interpolated);
 * the index name is allow-list validated and inlined as a quoted literal
 * because `to_bm25query` resolves it as an index identity.
 */
export const buildBm25SearchQuery = (
  query: string,
  options: Bm25SearchOptions = {}
): Bm25SearchQuery => {
  const text = validatedQueryText(query);
  const indexName = validatedIndexName(options.indexName);
  const limit = validatedLimit(options.limit);
  const literal = `'${indexName.replaceAll("'", "''")}'`;
  return {
    params: [text, limit],
    text: `SELECT "${BM25_ID_COLUMN}", "${BM25_COLUMN}", ("${BM25_COLUMN}" <@> to_bm25query($1, ${literal})) AS score FROM "${BM25_TABLE}" ORDER BY score ASC LIMIT $2`,
  };
};

/**
 * Map raw driver rows to hits. Throws on malformed rows (missing id or
 * non-numeric score) rather than silently ranking garbage.
 */
export const parseBm25Rows = (rows: Record<string, unknown>[]): Bm25Hit[] =>
  rows.map((row, position) => {
    const id = row[BM25_ID_COLUMN];
    const content = row[BM25_COLUMN];
    const { score } = row;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`bm25: row ${position} has no string id`);
    }
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new TypeError(`bm25: row ${position} has no numeric score`);
    }
    return {
      content: typeof content === "string" ? content : "",
      id,
      score,
    };
  });

/**
 * Ranked keyword search over `docs`. Best match first (`score` ascending —
 * scores are negative BM25). Throws on empty query / bad limit before
 * touching the client.
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
