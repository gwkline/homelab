import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { createMiddleware } from "hono/factory";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import {
  buildContract,
  errorBody,
  errorSchema,
  searchResponseSchema,
} from "./contract.js";
import type { RetrievalConfig } from "./config.js";
import type { Logger } from "./log.js";
import { reciprocalRankFusion } from "./rank.js";
import type { RankedCandidate, RetrievalStore } from "./store.js";

type AppEnv = { Variables: { requestId: string } };

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`retrieval exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    promise.catch(() => {});
  }
}

function tokenFingerprint(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function bearerTokenMatches(header: string, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/u.exec(header);
  if (!match?.[1]) {
    return false;
  }
  return timingSafeEqual(tokenFingerprint(match[1]), tokenFingerprint(expected));
}

const roundScore = (value: number): number => Number(value.toFixed(6));

export interface AppDeps {
  config: RetrievalConfig;
  store: RetrievalStore;
  logger: Logger;
}

export function createApp(deps: AppDeps): OpenAPIHono<AppEnv> {
  const { config, store, logger } = deps;
  const contract = buildContract(config);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        logger.warn("request validation failed", {
          issues: result.error.issues.length,
          path: c.req.path,
          requestId: c.get("requestId"),
        });
        return c.json(errorBody("invalid_request", "request body failed validation", c.get("requestId")), 422);
      }
    },
  });

  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const header = c.req.header("x-request-id") ?? "";
      c.set("requestId", /^[\w.-]{8,128}$/u.test(header) ? header : `req_${randomUUID()}`);
      await next();
    })
  );

  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const startedAt = performance.now();
      await next();
      logger.info("request", {
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        method: c.req.method,
        path: c.req.path,
        requestId: c.get("requestId"),
        status: c.res.status,
      });
    })
  );

  // Tailnet/internal-network constraint is enforced at the network layer
  // (ClusterIP + ingress policy); the bearer token from a mounted secret is
  // the application-layer check. Token compare is constant time.
  app.use(
    "/v1/*",
    createMiddleware<AppEnv>(async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      if (!bearerTokenMatches(header, config.token)) {
        logger.warn("unauthorized", { path: c.req.path, requestId: c.get("requestId") });
        return c.json(errorBody("unauthorized", "missing or invalid bearer token", null), 401);
      }
      await next();
    })
  );

  const searchRoute = createRoute({
    method: "post",
    operationId: "search",
    path: "/v1/search",
    request: {
      body: {
        content: { "application/json": { schema: contract.searchRequestSchema } },
        required: true,
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: searchResponseSchema } },
        description: "Ranked chunks with full citation provenance.",
      },
      401: {
        content: { "application/json": { schema: errorSchema } },
        description: "Missing or invalid bearer token.",
      },
      422: {
        content: { "application/json": { schema: errorSchema } },
        description: "Body failed schema validation (unknown mode, topK out of range, oversized query, malformed JSON).",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unexpected failure; nothing is returned without complete provenance.",
      },
      503: {
        content: { "application/json": { schema: errorSchema } },
        description: "Retrieval store (database) failed or is unreachable.",
      },
      504: {
        content: { "application/json": { schema: errorSchema } },
        description: `Retrieval exceeded the ${config.requestTimeoutMs}ms deadline.`,
      },
    },
    summary: "Retrieve ranked, cited knowledge chunks",
    tags: ["retrieval"],
  });

  app.openapi(searchRoute, async (c) => {
    const requestId = c.get("requestId");
    const body = c.req.valid("json");
    const query = body.query.trim();
    if (query.length === 0) {
      return c.json(errorBody("invalid_request", "query must not be blank", requestId), 422);
    }
    const mode = body.mode ?? config.defaultMode;
    const namespace = body.namespace ?? config.defaultNamespace;
    const topK = body.topK ?? config.defaultTopK;
    const runId = `run_${randomUUID()}`;
    const limitPerChannel = topK * config.channelWindowFactor;
    const startedAt = performance.now();

    try {
      const channels = await withTimeout(
        (async () => {
          const queryEmbedding =
            mode === "bm25" || typeof store.embedQuery !== "function"
              ? null
              : await store.embedQuery(query);
          return store.search({
            filters: {
              includeSuperseded: body.filters?.includeSuperseded ?? false,
              sourceIds: body.filters?.sourceIds ?? [],
              tags: body.filters?.tags ?? [],
            },
            limitPerChannel,
            namespace,
            query,
            queryEmbedding,
          });
        })(),
        config.requestTimeoutMs
      );

      const getId = (candidate: RankedCandidate): string => candidate.chunk.chunkId;
      const fused =
        mode === "bm25"
          ? reciprocalRankFusion([{ items: channels.bm25, key: "bm25" }], getId, config.rrfK)
          : mode === "vector"
            ? reciprocalRankFusion([{ items: channels.vector, key: "vector" }], getId, config.rrfK)
            : reciprocalRankFusion(
                [
                  { items: channels.bm25, key: "bm25" },
                  { items: channels.vector, key: "vector" },
                ],
                getId,
                config.rrfK
              );

      const payload = searchResponseSchema.parse({
        mode,
        namespace,
        results: fused.slice(0, topK).map((fusedCandidate, index) => {
          const chunk = fusedCandidate.item.chunk;
          return {
            anchors: chunk.anchors,
            chunkId: chunk.chunkId,
            documentId: chunk.documentId,
            namespace: chunk.namespace,
            provenance: chunk.provenance,
            scores: {
              bm25: fusedCandidate.bm25 && {
                rank: fusedCandidate.bm25.rank,
                score: roundScore(fusedCandidate.bm25.score),
              },
              fused: { rank: index + 1, score: roundScore(fusedCandidate.fusedScore) },
              vector: fusedCandidate.vector && {
                rank: fusedCandidate.vector.rank,
                score: roundScore(fusedCandidate.vector.score),
              },
            },
            source: chunk.source,
            tags: chunk.tags,
            text: chunk.text,
            title: chunk.title,
            version: {
              commit: chunk.version.commit,
              createdAt: chunk.version.createdAt,
              status: chunk.version.status,
              versionId: chunk.version.versionId,
            },
          };
        }),
        runId,
        topK,
        totalCandidates: fused.length,
      });

      logger.info("search", {
        candidates: fused.length,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        mode,
        namespace,
        queryLength: query.length,
        requestId,
        results: payload.results.length,
        runId,
        topK,
        ...(config.logQueries ? { query } : {}),
      });
      return c.json(payload, 200);
    } catch (error) {
      if (error instanceof TimeoutError) {
        logger.warn("search timeout", {
          durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
          mode,
          requestId,
          runId,
        });
        return c.json(errorBody("timeout", `retrieval exceeded ${config.requestTimeoutMs}ms`, runId), 504);
      }
      if (error instanceof z.ZodError) {
        logger.error("response contract violation", {
          issues: JSON.stringify(error.issues),
          requestId,
          runId,
        });
        return c.json(errorBody("internal_error", "retrieval produced an invalid response", runId), 500);
      }
      logger.error("store failure", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
        runId,
      });
      return c.json(errorBody("store_unavailable", "retrieval store unavailable", runId), 503);
    }
  });

  app.doc31("/openapi.json", {
    info: {
      description:
        "Cited knowledge retrieval. Returns ranked source chunks with traceable provenance; never prose answers. Authenticated with a secret-backed bearer token and intended for tailnet/internal networks only.",
      title: "Knowledge Retrieval API",
      version: "0.1.0",
    },
    openapi: "3.1.0",
    tags: [{ description: "Cited chunk retrieval", name: "retrieval" }],
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.notFound((c) =>
    c.json(errorBody("not_found", `${c.req.method} ${c.req.path} is not a defined route`, c.get("requestId")), 404)
  );

  app.onError((error, c) => {
    logger.error("unhandled error", {
      reason: error instanceof Error ? error.message : String(error),
      requestId: c.get("requestId"),
    });
    return c.json(errorBody("internal_error", "unexpected server error", c.get("requestId")), 500);
  });

  return app;
}
