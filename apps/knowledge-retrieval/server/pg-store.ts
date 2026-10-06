/**
 * Postgres-backed `RetrievalStore` (#63/#64): the hybrid retrieval the
 * deployed service runs. Both channels rank the shared #56 `chunks` table
 * (apps/knowledge/src/schema.ts) through the pinned library queries —
 *
 * - BM25: `buildBm25SearchQuery` (pg_textsearch partial index, explicit
 *   index addressing, negative-score ordering),
 * - vector: `buildPgvectorSearchQuery` (partial HNSW cosine index, model-
 *   generation filter),
 *
 * and citations/provenance are resolved at query time by joining the chunk's
 * `document` + `document_version` rows (ADR-002 D3/D8): title, url, source
 * label, external id (path), version row id and created_at. The D8 live-join
 * guarantee is enforced in that join — a tombstoned document
 * (`deleted_at IS NOT NULL`) drops every chunk it owns from BOTH channels'
 * candidate sets before fusion, so no result can cite dead content.
 *
 * Mapping notes (the retrieval contract vs the #56 schema):
 * - `source.sourceId` is the stable `document.id` — version-independent, and
 *   the id a citation carries across re-ingests.
 * - `provenance.ingestionEventId` is the `document_version.id` the chunk
 *   cites: the durable pointer to the ingest that produced it
 *   (`ingestedAt` = that version's `created_at`).
 * - `tags` are always empty in phase one: the #56 schema has no tag column,
 *   so a tag filter returns no results (an honest empty, never fabricated
 *   matches).
 * - `version.commit` is null: the #56 `document_version` row records content
 *   identity, and the git commit lives in the ingestion queue's provenance;
 *   surfacing it on citations is a follow-up schema addition.
 *
 * Query embeddings come from the same shared provider configuration the
 * ingest worker uses (`KNOWLEDGE_EMBEDDING_*`, deterministic offline by
 * default), and the vector channel filters chunks by that provider's model
 * tag, so vectors from different model generations never mix (ADR-002 D6).
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
} from "../../knowledge/src/embedder.ts";
import type { CitationAnchor } from "../../knowledge/src/pgvector.ts";
import {
  parseAnchors,
  buildPgvectorSearchQuery,
  parsePgvectorRows,
} from "../../knowledge/src/pgvector.ts";
import type {
  ChannelResults,
  ChunkRecord,
  DocumentVersion,
  RankedCandidate,
  RetrievalStore,
  SearchOptions,
} from "./store.ts";
import { StoreUnavailableError } from "./store.ts";

/** The #56 source label → the contract's source kinds. */
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
   * Query-embedding provider; defaults to the shared env configuration. Its
   * `model` is also the vector channel's model filter, matching the tag the
   * ingest worker writes, so query and chunk vectors always share one
   * model generation.
   */
  env?: Record<string, string | undefined>;
  provider?: EmbeddingProvider;
}

/**
 * Citation + provenance join over the chunk ids the channels returned: the
 * live-document guarantee (`d.deleted_at IS NULL`) and the optional
 * source-id filter are applied here, before fusion. Parameterized; the
 * chunk-id array and source filter are bind parameters.
 */
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

  constructor(pool: Pool, options: PgStoreOptions = {}) {
    this.pool = pool;
    this.provider =
      options.provider ?? embeddingProviderFromEnv(options.env ?? process.env);
  }

  /**
   * Embed the query with the shared provider. A provider failure returns
   * null — the contract for "vector channel unavailable for this query",
   * never a failed search.
   */
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

  async search(options: SearchOptions): Promise<ChannelResults> {
    // No chunk carries tags in phase one (#56 schema has no tag column): an
    // explicit tag filter is an honest empty, never fabricated matches.
    if (options.filters.tags.length > 0) {
      return { bm25: [], vector: [] };
    }
    try {
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

  /** Readiness probe; throws (fast) when the database is unreachable. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
