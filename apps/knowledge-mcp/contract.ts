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

export const SearchToolInputSchema = z.object({
  mode: z
    .enum(["bm25", "vector", "hybrid"])
    .optional()
    .describe(
      "Retrieval mode. Defaults to hybrid (rank-based reciprocal rank fusion) upstream."
    ),
  namespace: z
    .string()
    .min(1)
    .max(NAMESPACE_MAX_LENGTH)
    .optional()
    .describe("Optional namespace/collection to restrict the search to."),
  query: z
    .string()
    .min(1)
    .max(QUERY_MAX_LENGTH)
    .describe(`Free-text search query, ${QUERY_MAX_LENGTH} characters max.`),
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

export const GetSourceToolInputSchema = z.object({
  source_id: z
    .string()
    .regex(SOURCE_ID_PATTERN)
    .describe(
      "source_id exactly as it appeared in a search_knowledge citation."
    ),
});

export type SearchToolInput = z.infer<typeof SearchToolInputSchema>;
export type GetSourceToolInput = z.infer<typeof GetSourceToolInputSchema>;

// ---- HTTP API contract (#64) ----

export const SEARCH_ENDPOINT = "/v1/search";
export const SOURCE_ENDPOINT = "/v1/sources";

export const SourceVersionSchema = z
  .object({
    commit: z.string().min(1),
    created_at: z.string().min(1),
    deleted: z.boolean().optional(),
    superseded_by: z.string().optional(),
  })
  .passthrough();

export const CitationSchema = z
  .object({
    citation_anchor: z.string().min(1),
    document_id: z.string().min(1),
    namespace: z.string().min(1),
    offsets: z
      .object({
        end: z.number().int().min(0),
        start: z.number().int().min(0),
      })
      .passthrough()
      .optional(),
    path: z.string().optional(),
    source_id: z.string().min(1),
    title: z.string().min(1),
    url: z.string().min(1),
    version: SourceVersionSchema,
  })
  .passthrough();

export const ScoreBreakdownSchema = z
  .object({
    // RRF fused score; bm25/vector ranks explain the fusion (#63).
    bm25_rank: z.number().int().min(1).optional(),
    fused: z.number(),
    vector_rank: z.number().int().min(1).optional(),
  })
  .passthrough();

export const SearchHitSchema = z
  .object({
    chunk_id: z.string().min(1),
    citation: CitationSchema,
    score: ScoreBreakdownSchema,
    text: z.string().min(1),
  })
  .passthrough();

export const SearchResponseSchema = z
  .object({
    results: z.array(SearchHitSchema).max(TOP_K_MAX),
  })
  .passthrough();

export const SourceDetailSchema = CitationSchema.extend({
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

export type SourceVersion = z.infer<typeof SourceVersionSchema>;
export type Citation = z.infer<typeof CitationSchema>;
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
