import type { PgClient, PgPool } from "../src/pg-client.ts";
import { withTransaction } from "../src/pg-client.ts";

export interface ChunkFixture {
  chunkId: string;
  documentId: string;
  /** pgvector literal, e.g. `[1,0,0]`. */
  embedding?: string | null;
  embeddingModel?: string | null;
  namespace: string;
  superseded?: boolean;
  text: string;
}

/** Each fixture document has exactly one version, `<documentId>:v1`. */
export const fixtureVersionId = (documentId: string): string =>
  `${documentId}:v1`;

/**
 * Inserts raw chunk rows together with the namespace, document, and version
 * rows the schema's foreign keys demand, in a handful of set-based
 * statements so large corpora stay fast. Parents that already exist are
 * reused.
 */
export const insertChunkFixtures = async (
  client: PgClient,
  chunks: readonly ChunkFixture[]
): Promise<void> => {
  const documents = new Map(
    chunks.map((chunk) => [chunk.documentId, chunk.namespace])
  );
  await client.query(
    `INSERT INTO knowledge_namespace (name)
SELECT DISTINCT unnest($1::text[])
ON CONFLICT DO NOTHING`,
    [[...new Set(documents.values())]]
  );
  await client.query(
    `INSERT INTO document (id, namespace, source, external_id, content_hash)
SELECT d.id, d.namespace, 'test', d.id, md5(d.id)
FROM unnest($1::text[], $2::text[]) AS d(id, namespace)
ON CONFLICT DO NOTHING`,
    [[...documents.keys()], [...documents.values()]]
  );
  await client.query(
    `INSERT INTO document_version (id, document_id, version, content_hash)
SELECT d.id || ':v1', d.id, 1, md5(d.id)
FROM unnest($1::text[]) AS d(id)
ON CONFLICT DO NOTHING`,
    [[...documents.keys()]]
  );
  await client.query(
    `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, text, content_hash, chunker_version, embedding, embedding_model, valid_to)
SELECT c.chunk_id, c.document_id, c.document_id || ':v1', c.namespace, c.text,
       md5(c.chunk_id), 'test-fixture', c.embedding::vector, c.model,
       CASE WHEN c.superseded THEN now() END
FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[])
  AS c(chunk_id, document_id, namespace, text, embedding, model, superseded)`,
    [
      chunks.map((chunk) => chunk.chunkId),
      chunks.map((chunk) => chunk.documentId),
      chunks.map((chunk) => chunk.namespace),
      chunks.map((chunk) => chunk.text),
      chunks.map((chunk) => chunk.embedding ?? null),
      chunks.map((chunk) => chunk.embeddingModel ?? null),
      chunks.map((chunk) => chunk.superseded === true),
    ]
  );
};

/**
 * Installs the extensions in `public`, outside any scratch schema a test may
 * drop. Concurrent `CREATE EXTENSION IF NOT EXISTS` races on a fresh
 * database, so this queues on the migration lock like ingest does.
 */
export const ensurePublicExtensions = (pool: PgPool): Promise<void> =>
  withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowledge_schema_migration'))",
      []
    );
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS vector SCHEMA public",
      []
    );
    await client.query(
      "CREATE EXTENSION IF NOT EXISTS pg_textsearch SCHEMA public",
      []
    );
  });
