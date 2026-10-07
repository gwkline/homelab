/**
 * Postgres `RetrievalStore`: BM25 (pg_textsearch) and vector (HNSW) channels
 * over the shared `chunks` table. Citations join live `document` rows, so a
 * tombstoned document drops out of both channels before fusion (ADR-002 D8).
 * The vector channel filters on the embedding model tag so generations never
 * mix (ADR-002 D6).
 *
 * knowledge-ingest owns the schema. Until it has applied
 * `KNOWLEDGE_SCHEMA_VERSION`, search and readiness fail as unavailable.
 *
 * `source.sourceId` is the version-independent `document.id`;
 * `provenance.ingestionEventId` is the cited `document_version.id`. `tags`
 * are always empty and `version.commit` is null: the schema stores neither.
 */

import type { Pool } from "pg";

import {
  buildBm25SearchQuery,
  parseBm25Rows,
} from "../../knowledge/src/bm25.ts";
import type { EmbeddingProvider } from "../../knowledge/src/embedder.ts";
import {
  embeddingProviderFromEnv,
  embeddingVectorProblem,
  isFakeEmbeddingProvider,
} from "../../knowledge/src/embedder.ts";
import type { CitationAnchor } from "../../knowledge/src/pgvector.ts";
import {
  EMBEDDING_MODEL_COUNT_SQL,
  parseAnchors,
  parseEmbeddingModelCounts,
  buildPgvectorSearchQuery,
  parsePgvectorRows,
} from "../../knowledge/src/pgvector.ts";
import {
  KNOWLEDGE_SCHEMA_VERSION,
  readKnowledgeSchemaVersion,
} from "../../knowledge/src/schema.ts";
import type {
  ChannelResults,
  ChunkRecord,
  DocumentVersion,
  EmbeddingReport,
  RankedCandidate,
  RetrievalStore,
  SearchOptions,
} from "./store.ts";
import { StoreUnavailableError } from "./store.ts";

/** Document source label → contract source kind. */
const contractSourceKind = (
  sourceLabel: string
): ChunkRecord["source"]["kind"] => {
  if (sourceLabel === "git") {
    return "git";
  }
  if (sourceLabel === "url" || sourceLabel === "web") {
    return "url";
  }
  if (sourceLabel === "note") {
    return "note";
  }
  return "file";
};

const asIso = (value: unknown, context: string): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new TypeError(`${context}: created_at is not a timestamp`);
};

const asString = (value: unknown, context: string): string => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new TypeError(`${context}: expected a non-empty string`);
};

export interface PgStoreOptions {
  /**
   * Query-embedding provider; defaults to the shared env config. Its `model`
   * is also the vector channel's model filter.
   */
  env?: Record<string, string | undefined>;
  provider?: EmbeddingProvider;
}

/** Citation join; enforces live documents and the source filter before fusion. */
const buildMetadataQuery = (
  chunkIds: string[],
  sourceIds: string[]
): { params: unknown[]; text: string } => ({
  params: [chunkIds, sourceIds],
  text: `SELECT c.chunk_id, c.document_id, c.namespace, c.text, c.anchors,
       c.valid_to, d.title, d.url, d.source, d.external_id,
       v.id AS version_row_id, v.created_at
FROM chunks c
JOIN document d ON d.id = c.document_id
JOIN document_version v ON v.id = c.version_id
WHERE c.chunk_id = ANY($1::text[])
  AND d.deleted_at IS NULL
  AND (cardinality($2::text[]) = 0 OR d.id = ANY($2))`,
});

export class PgRetrievalStore implements RetrievalStore {
  private readonly pool: Pool;
  private readonly provider: EmbeddingProvider;
  private schemaReady = false;
  readonly vectorSearch: boolean;

  constructor(pool: Pool, options: PgStoreOptions = {}) {
    this.pool = pool;
    this.provider =
      options.provider ?? embeddingProviderFromEnv(options.env ?? process.env);
    // Fake vectors carry no meaning; ranking by them only adds noise.
    this.vectorSearch = !isFakeEmbeddingProvider(this.provider);
  }

  /** Embed the query; a provider failure disables the vector channel instead of failing the search. */
  async embedQuery(query: string): Promise<number[] | null> {
    try {
      const [vector] = await this.provider.embed([query]);
      if (vector === undefined) {
        return null;
      }
      const problem = embeddingVectorProblem(vector, this.provider.dimensions);
      return problem === null ? vector : null;
    } catch {
      return null;
    }
  }

  /** Once the schema is current it stays current, so only misses re-check. */
  private async assertSchemaReady(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    const version = await readKnowledgeSchemaVersion(this.pool);
    if (version < KNOWLEDGE_SCHEMA_VERSION) {
      throw new StoreUnavailableError(
        `knowledge schema is at version ${version}, this build needs ${KNOWLEDGE_SCHEMA_VERSION}; knowledge-ingest applies migrations`
      );
    }
    this.schemaReady = true;
  }

  async search(options: SearchOptions): Promise<ChannelResults> {
    // The schema has no tags, so a tag filter matches nothing.
    if (options.filters.tags.length > 0) {
      return { bm25: [], vector: [] };
    }
    try {
      await this.assertSchemaReady();
      const { includeSuperseded } = options.filters;
      const bm25 = buildBm25SearchQuery(options.query, {
        includeSuperseded,
        limit: options.limitPerChannel,
        namespace: options.namespace,
      });
      const bm25Result = await this.pool.query(bm25.text, bm25.params);
      const bm25Hits = parseBm25Rows(
        bm25Result.rows as Record<string, unknown>[]
      );

      let vectorHits: ReturnType<typeof parsePgvectorRows> = [];
      if (options.queryEmbedding !== null) {
        const vector = buildPgvectorSearchQuery(options.queryEmbedding, {
          embeddingModel: this.provider.model,
          includeSuperseded,
          limit: options.limitPerChannel,
          namespace: options.namespace,
        });
        const vectorResult = await this.pool.query(vector.text, vector.params);
        vectorHits = parsePgvectorRows(
          vectorResult.rows as Record<string, unknown>[]
        );
      }

      const candidates = new Map<string, { bm25?: number; vector?: number }>();
      for (const hit of bm25Hits) {
        // `<@>` returns the NEGative BM25 score; the contract reports BM25.
        candidates.set(hit.chunkId, { bm25: -hit.score });
      }
      for (const hit of vectorHits) {
        const existing = candidates.get(hit.chunkId) ?? {};
        // Cosine similarity: 1 - cosine distance.
        candidates.set(hit.chunkId, { ...existing, vector: 1 - hit.distance });
      }

      const ids = [...candidates.keys()];
      const metadataQuery = buildMetadataQuery(ids, options.filters.sourceIds);
      const metadata = await this.pool.query(
        metadataQuery.text,
        metadataQuery.params
      );
      const rows = metadata.rows as Record<string, unknown>[];
      const byChunkId = new Map<string, ChunkRecord>();
      for (const [index, row] of rows.entries()) {
        const context = `pg-store: citation row ${index}`;
        const chunkId = asString(row["chunk_id"], context);
        const documentId = asString(row["document_id"], context);
        const versionRowId = asString(row["version_row_id"], context);
        const createdAt = asIso(row["created_at"], context);
        const externalId = asString(row["external_id"], context);
        const sourceLabel = asString(row["source"], context);
        const anchors: CitationAnchor[] = parseAnchors(
          row["anchors"],
          `${context} (${chunkId})`
        );
        const version: DocumentVersion = {
          commit: null,
          createdAt,
          status: row["valid_to"] === null ? "current" : "superseded",
          versionId: versionRowId,
        };
        byChunkId.set(chunkId, {
          anchors,
          chunkId,
          documentId,
          embedding: null,
          namespace: asString(row["namespace"], context),
          provenance: {
            ingestedAt: createdAt,
            ingestionEventId: versionRowId,
          },
          source: {
            kind: contractSourceKind(sourceLabel),
            path: externalId,
            sourceId: documentId,
            url: typeof row["url"] === "string" ? row["url"] : null,
          },
          tags: [],
          text: asString(row["text"], context),
          title:
            typeof row["title"] === "string" && row["title"].length > 0
              ? row["title"]
              : externalId,
          version,
        });
      }

      const toCandidate = (
        chunkId: string,
        channel: "bm25" | "vector"
      ): RankedCandidate | null => {
        const chunk = byChunkId.get(chunkId);
        const scores = candidates.get(chunkId);
        if (chunk === undefined || scores === undefined) {
          return null;
        }
        return {
          bm25Score: channel === "bm25" ? (scores.bm25 ?? null) : null,
          chunk,
          vectorScore: channel === "vector" ? (scores.vector ?? null) : null,
        };
      };

      const bm25Candidates = bm25Hits
        .map((hit) => toCandidate(hit.chunkId, "bm25"))
        .filter(
          (candidate): candidate is RankedCandidate => candidate !== null
        );
      const vectorCandidates = vectorHits
        .map((hit) => toCandidate(hit.chunkId, "vector"))
        .filter(
          (candidate): candidate is RankedCandidate => candidate !== null
        );
      return { bm25: bm25Candidates, vector: vectorCandidates };
    } catch (error) {
      throw new StoreUnavailableError(
        `retrieval store unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  async embeddingReport(): Promise<EmbeddingReport> {
    try {
      await this.assertSchemaReady();
      const { rows } = await this.pool.query(EMBEDDING_MODEL_COUNT_SQL);
      return {
        configuredModel: this.provider.model,
        storedModels: parseEmbeddingModelCounts(
          rows as Record<string, unknown>[]
        ),
      };
    } catch (error) {
      throw new StoreUnavailableError(
        `retrieval store unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /** Readiness probe; throws (fast) when the database is unreachable or not migrated. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
    await this.assertSchemaReady();
  }
}
