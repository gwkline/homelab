import { z } from "@hono/zod-openapi";

import type { RetrievalConfig } from "./config.js";

export type ApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "internal_error"
  | "store_unavailable"
  | "timeout";

export const errorSchema = z
  .object({
    error: z.object({
      code: z.enum([
        "invalid_request",
        "unauthorized",
        "not_found",
        "internal_error",
        "store_unavailable",
        "timeout",
      ]),
      message: z.string(),
      runId: z.string().nullable(),
    }),
  })
  .describe("Consistent error envelope; runId correlates with the request log line.");

export const errorBody = (
  code: ApiErrorCode,
  message: string,
  runId: string | null
): z.infer<typeof errorSchema> => ({ error: { code, message, runId } });

const retrievalModeSchema = z
  .enum(["bm25", "vector", "hybrid"])
  .describe("Retrieval channel(s) to use. hybrid fuses BM25 and vector ranks with RRF.");

const channelScoreSchema = z.object({
  rank: z.number().int().min(1),
  score: z.number(),
});

const scoreBreakdownSchema = z
  .object({
    bm25: channelScoreSchema.nullable().describe("BM25 channel rank/score; null when the mode did not use it."),
    fused: channelScoreSchema.describe("Final rank after reciprocal rank fusion (or the single channel rank)."),
    vector: channelScoreSchema.nullable().describe("Vector channel rank/score; null when the mode did not use it."),
  })
  .describe("Per-channel rank/score breakdown; raw BM25 and cosine scores are not comparable across channels.");

const citationAnchorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("offset"),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("heading"),
    value: z.string().min(1),
  }),
]);

const versionSchema = z.object({
  commit: z
    .string()
    .nullable()
    .describe("Immutable source commit the chunk was produced from; null when the source has no commit."),
  createdAt: z.string().describe("When this document version was ingested (ISO-8601)."),
  status: z.enum(["current", "superseded"]),
  versionId: z.string(),
});

const sourceSchema = z.object({
  kind: z.enum(["github", "file", "url", "web"]),
  path: z.string().nullable().describe("Repository or filesystem path of the source; null when meaningless."),
  sourceId: z.string().describe("Stable external source identity, independent of document versions."),
  url: z.string().nullable().describe("Resolvable source URL; null when the source has none."),
});

const provenanceSchema = z.object({
  ingestionEventId: z.string().describe("Ingestion job/event that produced this chunk."),
  ingestedAt: z.string().describe("When the producing ingestion event ran (ISO-8601)."),
});

const searchResultSchema = z.object({
  anchors: z
    .array(citationAnchorSchema)
    .min(1)
    .describe("Citation anchors locating the chunk inside the source (offsets and/or headings)."),
  chunkId: z.string(),
  documentId: z.string(),
  namespace: z.string(),
  provenance: provenanceSchema,
  scores: scoreBreakdownSchema,
  source: sourceSchema,
  tags: z.array(z.string()),
  text: z.string().min(1),
  title: z.string(),
  version: versionSchema,
});

export const searchResponseSchema = z.object({
  mode: retrievalModeSchema,
  namespace: z.string(),
  results: z.array(searchResultSchema).describe("Ranked results, best first."),
  runId: z.string().describe("Identifies this retrieval run in logs; safe to cite."),
  topK: z.number().int().min(1),
  totalCandidates: z.number().int().min(0).describe("Fused candidates before applying topK."),
});

// Schemas depend on deployment limits, so they are built per config. The same
// instances validate requests and generate the OpenAPI document.
export function buildContract(config: RetrievalConfig) {
  const searchRequestSchema = z.object({
    filters: z
      .object({
        includeSuperseded: z
          .boolean()
          .optional()
          .describe("Re-include superseded document versions. Deleted versions are never returned."),
        sourceIds: z.array(z.string().min(1)).max(50).optional().describe("Restrict to these source identities."),
        tags: z.array(z.string().min(1)).max(10).optional().describe("Chunk must carry every listed tag."),
      })
      .optional(),
    mode: retrievalModeSchema.optional(),
    namespace: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
      .optional()
      .describe("Namespace/collection to search; defaults to the deployment default."),
    query: z
      .string()
      .min(1)
      .max(config.maxQueryLength)
      .describe("Query text. Leading/trailing whitespace is trimmed; whitespace-only is invalid."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(config.maxTopK)
      .optional()
      .describe(`Results to return (1-${config.maxTopK}); defaults to ${config.defaultTopK}.`),
  });
  return { searchRequestSchema };
}

export type SearchRequest = z.infer<ReturnType<typeof buildContract>["searchRequestSchema"]>;
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
