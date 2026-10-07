import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";

import type { RetrievalConfig } from "./config.ts";
import {
  buildContract,
  errorBody,
  errorSchema,
  searchResponseSchema,
} from "./contract.ts";
import type { Logger } from "./log.ts";
import { renderMetrics } from "./metrics.ts";
import { reciprocalRankFusion } from "./rank.ts";
import type { FusedCandidate } from "./rank.ts";
import type {
  EmbeddingReport,
  RankedCandidate,
  RetrievalStore,
} from "./store.ts";

interface AppEnv {
  Variables: { requestId: string };
}

/** The search token may only search; everything else needs the admin token. */
const SEARCH_SCOPE_ROUTES = new Set(["/v1/search"]);

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

export const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number
): Promise<T> => {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new TimeoutError(`retrieval exceeded ${ms}ms`)),
    ms
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    void (async (): Promise<void> => {
      try {
        await promise;
      } catch {
        // The race already settled; swallow to avoid an unhandled rejection.
      }
    })();
  }
};

const tokenFingerprint = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

const bearerTokenMatches = (header: string, expected: string): boolean => {
  const match = /^Bearer\s+(?<token>.+)$/u.exec(header);
  const token = match?.groups?.["token"];
  if (!token) {
    return false;
  }
  return timingSafeEqual(tokenFingerprint(token), tokenFingerprint(expected));
};

const roundScore = (value: number): number => Number(value.toFixed(6));

const READY_TIMEOUT_MS = 2000;

const getId = (candidate: RankedCandidate): string => candidate.chunk.chunkId;

export interface AppDeps {
  config: RetrievalConfig;
  store: RetrievalStore;
  logger: Logger;
}

export const createApp = (deps: AppDeps): OpenAPIHono<AppEnv> => {
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
        return c.json(
          errorBody(
            "invalid_request",
            "request body failed validation",
            c.get("requestId")
          ),
          422
        );
      }
    },
  });

  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const header = c.req.header("x-request-id") ?? "";
      c.set(
        "requestId",
        /^[\w.-]{8,128}$/u.test(header) ? header : `req_${randomUUID()}`
      );
      return await next();
    })
  );

  app.use(
    "*",
    createMiddleware<AppEnv>(async (c, next) => {
      const startedAt = performance.now();
      // eslint-disable-next-line node/callback-return -- hono middleware intentionally logs after next() resolves
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

  // Network policy limits reachability; this constant-time bearer check is
  // the application-layer gate. Scope is deny-by-default: the search token
  // reaches only the routes listed for it.
  app.use(
    "/v1/*",
    createMiddleware<AppEnv>(async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      if (bearerTokenMatches(header, config.token)) {
        return await next();
      }
      const searchScoped =
        config.searchToken !== null &&
        bearerTokenMatches(header, config.searchToken);
      if (!searchScoped) {
        logger.warn("unauthorized", {
          path: c.req.path,
          requestId: c.get("requestId"),
        });
        return c.json(
          errorBody("unauthorized", "missing or invalid bearer token", null),
          401
        );
      }
      if (!SEARCH_SCOPE_ROUTES.has(c.req.path)) {
        logger.warn("forbidden", {
          path: c.req.path,
          requestId: c.get("requestId"),
        });
        return c.json(
          errorBody(
            "forbidden",
            "the search token cannot use this route",
            c.get("requestId")
          ),
          403
        );
      }
      return await next();
    })
  );

  const searchRoute = createRoute({
    method: "post",
    operationId: "search",
    path: "/v1/search",
    request: {
      body: {
        content: {
          "application/json": { schema: contract.searchRequestSchema },
        },
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
        description:
          "Body failed schema validation (unknown mode, topK out of range, oversized query, malformed JSON).",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description:
          "Unexpected failure; nothing is returned without complete provenance.",
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
      return c.json(
        errorBody("invalid_request", "query must not be blank", requestId),
        422
      );
    }
    const requestedMode = body.mode ?? config.defaultMode;
    // Without a real embedding model the vector channel is noise.
    const mode = store.vectorSearch === false ? "bm25" : requestedMode;
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

      let fused: FusedCandidate<RankedCandidate>[];
      if (mode === "bm25") {
        fused = reciprocalRankFusion(
          [{ items: channels.bm25, key: "bm25" }],
          getId,
          config.rrfK
        );
      } else if (mode === "vector") {
        fused = reciprocalRankFusion(
          [{ items: channels.vector, key: "vector" }],
          getId,
          config.rrfK
        );
      } else {
        fused = reciprocalRankFusion(
          [
            { items: channels.bm25, key: "bm25" },
            { items: channels.vector, key: "vector" },
          ],
          getId,
          config.rrfK
        );
      }

      const payload = searchResponseSchema.parse({
        mode,
        namespace,
        results: fused.slice(0, topK).map((fusedCandidate, index) => {
          const { chunk } = fusedCandidate.item;
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
              fused: {
                rank: index + 1,
                score: roundScore(fusedCandidate.fusedScore),
              },
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
        requestedMode,
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
        return c.json(
          errorBody(
            "timeout",
            `retrieval exceeded ${config.requestTimeoutMs}ms`,
            runId
          ),
          504
        );
      }
      if (error instanceof z.ZodError) {
        logger.error("response contract violation", {
          issues: JSON.stringify(error.issues),
          requestId,
          runId,
        });
        return c.json(
          errorBody(
            "internal_error",
            "retrieval produced an invalid response",
            runId
          ),
          500
        );
      }
      logger.error("store failure", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
        runId,
      });
      return c.json(
        errorBody("store_unavailable", "retrieval store unavailable", runId),
        503
      );
    }
  });

  // Ingest passthrough: the panel and MCP use one knowledge base URL, so the
  // ingest routes are proxied verbatim. The proxy uses its own ingest token;
  // caller (retrieval) tokens are never forwarded.
  const ID_PATTERN = /^[\w.:-]{1,128}$/u;

  const passthrough = async (upstream: {
    method: "GET" | "POST";
    path: string;
  }): Promise<Response> => {
    if (config.ingestBaseUrl === null) {
      throw new Error("ingest API not configured");
    }
    const response = await withTimeout(
      fetch(`${config.ingestBaseUrl.replace(/\/+$/u, "")}${upstream.path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.ingestToken ?? config.token}`,
        },
        method: upstream.method,
      }),
      config.ingestTimeoutMs
    );
    const body: unknown = await response.json().catch(() => null);
    return Response.json(body, { status: response.status });
  };

  const passthroughError = (
    c: {
      get: (key: "requestId") => string;
      json: (body: unknown, status: number) => Response;
    },
    error: unknown
  ): Response => {
    if (error instanceof TimeoutError) {
      return c.json(
        errorBody(
          "timeout",
          `ingest passthrough exceeded ${config.ingestTimeoutMs}ms`,
          c.get("requestId")
        ),
        504
      );
    }
    logger.warn("ingest passthrough failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      errorBody(
        "store_unavailable",
        error instanceof Error && error.message === "ingest API not configured"
          ? "knowledge ingest API is not configured"
          : "ingest passthrough failed",
        c.get("requestId")
      ),
      503
    );
  };

  app.get("/v1/sources", async (c) => {
    try {
      return await passthrough({ method: "GET", path: "/v1/sources" });
    } catch (error) {
      return passthroughError(c, error);
    }
  });

  app.post("/v1/sources/:sourceId/sync", async (c) => {
    const { sourceId } = c.req.param();
    if (!ID_PATTERN.test(sourceId)) {
      return c.json(
        errorBody("invalid_request", "invalid source id", c.get("requestId")),
        422
      );
    }
    try {
      return await passthrough({
        method: "POST",
        path: `/v1/sources/${encodeURIComponent(sourceId)}/sync`,
      });
    } catch (error) {
      return passthroughError(c, error);
    }
  });

  app.get("/v1/sync-jobs/:jobId", async (c) => {
    const { jobId } = c.req.param();
    if (!ID_PATTERN.test(jobId)) {
      return c.json(
        errorBody("invalid_request", "invalid job id", c.get("requestId")),
        422
      );
    }
    try {
      return await passthrough({
        method: "GET",
        path: `/v1/sync-jobs/${encodeURIComponent(jobId)}`,
      });
    } catch (error) {
      return passthroughError(c, error);
    }
  });

  app.doc31("/openapi.json", {
    info: {
      description:
        "Cited knowledge retrieval. Returns ranked source chunks with traceable provenance; never prose answers. Sources and sync-job endpoints are passthroughs to the ingest service (same base URL, shared bearer). Authenticated with a secret-backed bearer token and intended for tailnet/internal networks only.",
      title: "Knowledge Retrieval API",
      version: "0.1.0",
    },
    openapi: "3.1.0",
    tags: [{ description: "Cited chunk retrieval", name: "retrieval" }],
  });

  // Liveness only; /readyz checks the database.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.get("/readyz", async (c) => {
    if (store.ping === undefined) {
      return c.json({ status: "ok" }, 200);
    }
    try {
      await withTimeout(store.ping(), READY_TIMEOUT_MS);
      return c.json({ status: "ok" }, 200);
    } catch (error) {
      logger.warn("readiness check failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return c.json({ status: "unavailable" }, 503);
    }
  });

  app.get("/metrics", async (c) => {
    let report: EmbeddingReport | null = null;
    if (store.embeddingReport !== undefined) {
      try {
        report = await store.embeddingReport();
      } catch (error) {
        logger.warn("metrics unavailable", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return c.text("embedding report unavailable\n", 503);
      }
    }
    return c.text(renderMetrics(store.vectorSearch !== false, report), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  app.notFound((c) =>
    c.json(
      errorBody(
        "not_found",
        `${c.req.method} ${c.req.path} is not a defined route`,
        c.get("requestId")
      ),
      404
    )
  );

  app.onError((thrown, c) => {
    logger.error("unhandled error", {
      reason: thrown instanceof Error ? thrown.message : String(thrown),
      requestId: c.get("requestId"),
    });
    return c.json(
      errorBody(
        "internal_error",
        "unexpected server error",
        c.get("requestId")
      ),
      500
    );
  });

  return app;
};
