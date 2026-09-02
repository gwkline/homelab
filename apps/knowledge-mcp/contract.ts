// Pinned contract between this adapter and the knowledge retrieval HTTP API
// (#64). The HTTP service owns ranking (RRF fusion, #63); this module only
// fixes the wire shapes so tool inputs stay narrow and responses are
// validated before they reach an agent. Schemas are passthrough on purpose:
// provenance fields the adapter does not know about yet must survive the trip
// instead of being stripped by validation.
import { z } from "zod";

// ---- tool input limits (mirrored by the upstream API, #64) ----

export const QUERY_MAX_LENGTH = 512;
export const TOP_K_DEFAULT = 5;
export const TOP_K_MAX = 20;
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const NAMESPACE_MAX_LENGTH = 128;

// ---- tool inputs ----

export const SearchToolInput = z.object({
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .describe(`Free-text search query, ${QUERY_MAX_LENGTH} characters max.`),
  namespace: z
    .string()
    .min(1)
    .max(NAMESPACE_MAX_LENGTH)
    .optional()
    .describe("Optional namespace/collection to restrict the search to."),
  mode: z
    .enum(["bm25", "vector", "hybrid"])
    .optional()
    .describe(
      "Retrieval mode. Defaults to hybrid (rank-based reciprocal rank fusion) upstream."
    ),
  top_k: z
    .number()
    .int()
    .min(1)
    .max(TOP_K_MAX)
    .optional()
    .describe(
      `Maximum number of chunks to return, 1-${TOP_K_MAX}. Defaults to ${TOP_K_DEFAULT}.`
    ),
});

export const GetSourceToolInput = z.object({
  source_id: z
    .string()
    .regex(SOURCE_ID_PATTERN)
    .describe(
      "source_id exactly as it appeared in a search_knowledge citation."
    ),
});

export type SearchToolInput = z.infer<typeof SearchToolInput>;
export type GetSourceToolInput = z.infer<typeof GetSourceToolInput>;

// ---- HTTP API contract (#64) ----

export const SEARCH_ENDPOINT = "/v1/search";
export const SOURCE_ENDPOINT = "/v1/sources";

export const SourceVersion = z
  .object({
    commit: z.string().min(1),
    created_at: z.string().min(1),
    deleted: z.boolean().optional(),
    superseded_by: z.string().optional(),
  })
  .passthrough();

export const Citation = z
  .object({
    source_id: z.string().min(1),
    document_id: z.string().min(1),
    namespace: z.string().min(1),
    title: z.string().min(1),
    url: z.string().min(1),
    path: z.string().optional(),
    citation_anchor: z.string().min(1),
    offsets: z
      .object({
        start: z.number().int().min(0),
        end: z.number().int().min(0),
      })
      .passthrough()
      .optional(),
    version: SourceVersion,
  })
  .passthrough();

export const ScoreBreakdown = z
  .object({
    // RRF fused score; bm25/vector ranks explain the fusion (#63).
    fused: z.number(),
    bm25_rank: z.number().int().min(1).optional(),
    vector_rank: z.number().int().min(1).optional(),
  })
  .passthrough();

export const SearchHit = z
  .object({
    chunk_id: z.string().min(1),
    text: z.string().min(1),
    score: ScoreBreakdown,
    citation: Citation,
  })
  .passthrough();

export const SearchResponse = z
  .object({
    results: z.array(SearchHit).max(TOP_K_MAX),
  })
  .passthrough();

export const SourceDetail = Citation.extend({
  chunks: z
    .array(
      z
        .object({
          chunk_id: z.string().min(1),
          citation_anchor: z.string().min(1),
          text: z.string().min(1),
        })
        .passthrough()
    )
    .optional(),
});

export type SourceVersion = z.infer<typeof SourceVersion>;
export type Citation = z.infer<typeof Citation>;
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;
export type SearchHit = z.infer<typeof SearchHit>;
export type SearchResponse = z.infer<typeof SearchResponse>;
export type SourceDetail = z.infer<typeof SourceDetail>;
