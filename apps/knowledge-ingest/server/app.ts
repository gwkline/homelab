import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";

import type { IngestConfig } from "./config.ts";
import {
  errorBody,
  errorSchema,
  ingestRequestSchema,
  ingestResponseSchema,
  readinessSchema,
  sourcesResponseSchema,
  syncJobResponseSchema,
  syncTriggerResponseSchema,
} from "./contract.ts";
import type { Logger } from "./log.ts";
import type {
  IngestJobRecord,
  IngestRequestInput,
  IngestStore,
} from "./store.ts";
import { SourceNotFoundError, StoreUnavailableError } from "./store.ts";

interface AppEnv {
  Variables: { requestId: string };
}

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

const withPingTimeout = async (
  store: IngestStore,
  timeoutMs: number
): Promise<void> => {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => reject(new Error(`readiness probe exceeded ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    return await Promise.race([store.ping(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Normalize a validated body into the storage input (nullish → null). */
export const ingestInputFromBody = (
  body: z.infer<typeof ingestRequestSchema>,
  receivedAt: string
): IngestRequestInput => ({
  contentHash: body.contentHash,
  externalId: body.externalId,
  idempotencyKey: body.idempotencyKey ?? null,
  namespace: body.namespace,
  provenance: {
    ingestedAt: body.provenance?.ingestedAt ?? receivedAt,
    ingestionEventId: body.provenance?.ingestionEventId ?? null,
  },
  source: {
    kind: body.source.kind,
    path: body.source.path ?? null,
    ref: body.source.ref ?? null,
    repo: body.source.repo ?? null,
    sourceId: body.source.sourceId,
    url: body.source.url ?? null,
  },
  tags: body.tags ?? [],
  title: body.title ?? null,
  version: {
    commit: body.version.commit ?? null,
    versionId: body.version.versionId,
  },
});

const jobBody = (
  job: IngestJobRecord,
  duplicate?: boolean
): Record<string, unknown> => ({
  attempts: job.attempts,
  chunksIngested: job.chunksIngested,
  ...(duplicate === undefined ? {} : { duplicate }),
  documentsIngested: job.documentsIngested,
  enqueuedAt: job.enqueuedAt,
  error: job.error,
  finishedAt: job.finishedAt,
  jobId: job.jobId,
  kind: job.kind,
  maxAttempts: job.maxAttempts,
  namespace: job.namespace,
  priority: job.priority,
  provenance: job.provenance,
  sourceId: job.sourceId,
  startedAt: job.startedAt,
  status: job.status,
});

export interface AppDeps {
  config: IngestConfig;
  store: IngestStore;
  logger: Logger;
}

const READY_TIMEOUT_MS = 2000;

export const createApp = (deps: AppDeps): OpenAPIHono<AppEnv> => {
  const { config, store, logger } = deps;
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
            "request failed schema validation",
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

  // Tailnet/internal-network constraint is enforced at the network layer
  // (ClusterIP + ingress policy); the bearer token from a mounted secret is
  // the application-layer check. Token compare is constant time.
  app.use(
    "/v1/*",
    createMiddleware<AppEnv>(async (c, next) => {
      const header = c.req.header("authorization") ?? "";
      if (!bearerTokenMatches(header, config.token)) {
        logger.warn("unauthorized", {
          path: c.req.path,
          requestId: c.get("requestId"),
        });
        return c.json(
          errorBody("unauthorized", "missing or invalid bearer token", null),
          401
        );
      }
      return await next();
    })
  );

  const ingestRoute = createRoute({
    method: "post",
    operationId: "ingest",
    path: "/v1/ingest",
    request: {
      body: {
        content: {
          "application/json": { schema: ingestRequestSchema },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ingestResponseSchema } },
        description:
          "Duplicate request: an existing job already covers this source event/version.",
      },
      202: {
        content: { "application/json": { schema: ingestResponseSchema } },
        description: "Accepted; a fresh job was enqueued for the worker pool.",
      },
      401: {
        content: { "application/json": { schema: errorSchema } },
        description: "Missing or invalid bearer token.",
      },
      422: {
        content: { "application/json": { schema: errorSchema } },
        description:
          "Body failed schema validation (bad namespace, malformed hash, oversized field, invalid JSON).",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unexpected failure; the job was not enqueued.",
      },
      503: {
        content: { "application/json": { schema: errorSchema } },
        description: "Ingest store (database) failed or is unreachable.",
      },
    },
    summary: "Enqueue one document-ingest event",
    tags: ["ingestion"],
  });

  app.openapi(ingestRoute, async (c) => {
    const requestId = c.get("requestId");
    const input = ingestInputFromBody(
      c.req.valid("json"),
      new Date().toISOString()
    );
    try {
      const { duplicate, job } = await store.enqueueIngest(input);
      logger.info("ingest accepted", {
        duplicate,
        jobId: job.jobId,
        namespace: job.namespace,
        requestId,
        sourceId: job.sourceId,
        status: job.status,
      });
      return c.json(
        ingestResponseSchema.parse(jobBody(job, duplicate)),
        duplicate ? 200 : 202
      );
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        logger.warn("store failure", { requestId });
        return c.json(
          errorBody("store_unavailable", "ingest store unavailable", requestId),
          503
        );
      }
      logger.error("enqueue failed", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return c.json(
        errorBody("internal_error", "failed to enqueue ingest job", requestId),
        500
      );
    }
  });

  const syncJobRoute = createRoute({
    method: "get",
    operationId: "getSyncJob",
    path: "/v1/sync-jobs/{jobId}",
    request: {
      params: z.object({
        jobId: z
          .string()
          .regex(/^[\w.:-]{1,128}$/u)
          .describe("Ingestion job id."),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: syncJobResponseSchema } },
        description: "Current job record.",
      },
      401: {
        content: { "application/json": { schema: errorSchema } },
        description: "Missing or invalid bearer token.",
      },
      404: {
        content: { "application/json": { schema: errorSchema } },
        description: "No job with this id.",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unexpected failure; the job state is unchanged.",
      },
      503: {
        content: { "application/json": { schema: errorSchema } },
        description: "Ingest store (database) failed or is unreachable.",
      },
    },
    summary: "Fetch one ingestion job's status",
    tags: ["ingestion"],
  });

  app.openapi(syncJobRoute, async (c) => {
    const requestId = c.get("requestId");
    const { jobId } = c.req.valid("param");
    try {
      const job = await store.getJob(jobId);
      if (job === null) {
        return c.json(
          errorBody("not_found", `no job ${jobId}`, requestId),
          404
        );
      }
      return c.json(syncJobResponseSchema.parse(jobBody(job)), 200);
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        return c.json(
          errorBody("store_unavailable", "ingest store unavailable", requestId),
          503
        );
      }
      logger.error("job lookup failed", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return c.json(
        errorBody("internal_error", "unexpected server error", requestId),
        500
      );
    }
  });

  const sourcesRoute = createRoute({
    method: "get",
    operationId: "listSources",
    path: "/v1/sources",
    responses: {
      200: {
        content: { "application/json": { schema: sourcesResponseSchema } },
        description: "Registered sources with ingestion health.",
      },
      401: {
        content: { "application/json": { schema: errorSchema } },
        description: "Missing or invalid bearer token.",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unexpected failure; the source list is not served.",
      },
      503: {
        content: { "application/json": { schema: errorSchema } },
        description: "Ingest store (database) failed or is unreachable.",
      },
    },
    summary: "List registered sources and their ingestion health",
    tags: ["ingestion"],
  });

  app.openapi(sourcesRoute, async (c) => {
    const requestId = c.get("requestId");
    try {
      const sources = await store.listSources();
      return c.json(sourcesResponseSchema.parse({ sources }), 200);
    } catch (error) {
      if (error instanceof StoreUnavailableError) {
        return c.json(
          errorBody("store_unavailable", "ingest store unavailable", requestId),
          503
        );
      }
      logger.error("source list failed", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return c.json(
        errorBody("internal_error", "unexpected server error", requestId),
        500
      );
    }
  });

  const syncTriggerRoute = createRoute({
    method: "post",
    operationId: "triggerSync",
    path: "/v1/sources/{sourceId}/sync",
    request: {
      params: z.object({
        sourceId: z
          .string()
          .regex(/^[\w.:-]{1,128}$/u)
          .describe("Registered source identity."),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: syncTriggerResponseSchema } },
        description:
          "A sync job for this source is already active; its existing job is returned.",
      },
      202: {
        content: { "application/json": { schema: syncTriggerResponseSchema } },
        description: "Accepted; a fresh sync job was enqueued.",
      },
      401: {
        content: { "application/json": { schema: errorSchema } },
        description: "Missing or invalid bearer token.",
      },
      404: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unknown source.",
      },
      500: {
        content: { "application/json": { schema: errorSchema } },
        description: "Unexpected failure; no sync job was enqueued.",
      },
      503: {
        content: { "application/json": { schema: errorSchema } },
        description: "Ingest store (database) failed or is unreachable.",
      },
    },
    summary: "Trigger a source resync (panel-facing)",
    tags: ["ingestion"],
  });

  app.openapi(syncTriggerRoute, async (c) => {
    const requestId = c.get("requestId");
    const { sourceId } = c.req.valid("param");
    try {
      const { duplicate, job } = await store.enqueueSourceSync(sourceId);
      return c.json(
        syncTriggerResponseSchema.parse(jobBody(job, duplicate)),
        duplicate ? 200 : 202
      );
    } catch (error) {
      if (error instanceof SourceNotFoundError) {
        return c.json(
          errorBody("not_found", `unknown source ${sourceId}`, requestId),
          404
        );
      }
      if (error instanceof StoreUnavailableError) {
        return c.json(
          errorBody("store_unavailable", "ingest store unavailable", requestId),
          503
        );
      }
      logger.error("sync trigger failed", {
        reason: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return c.json(
        errorBody("internal_error", "unexpected server error", requestId),
        500
      );
    }
  });

  // Liveness: the process is up. Readiness (below) is what distinguishes
  // database unavailability.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.openapi(
    createRoute({
      method: "get",
      operationId: "readiness",
      path: "/readyz",
      responses: {
        200: {
          content: { "application/json": { schema: readinessSchema } },
          description: "The backing store answered the readiness probe.",
        },
        503: {
          content: { "application/json": { schema: readinessSchema } },
          description:
            "Database check failed or timed out; the API is not ready.",
        },
      },
      summary: "Readiness with a distinct database check",
      tags: ["health"],
    }),
    async (c) => {
      try {
        await withPingTimeout(store, READY_TIMEOUT_MS);
        return c.json(
          readinessSchema.parse({
            backend: store.backend,
            checks: { database: "up" },
            status: "ok",
          }),
          200
        );
      } catch (error) {
        logger.warn("readiness check failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          readinessSchema.parse({
            backend: store.backend,
            checks: { database: "down" },
            status: "unavailable",
          }),
          503
        );
      }
    }
  );

  app.doc31("/openapi.json", {
    info: {
      description:
        "Knowledge ingestion API and durable work queue (#58). Accepts source ingestion events, persists idempotent jobs, and hands them to SKIP LOCKED workers. Authenticated with a secret-backed bearer token and intended for tailnet/internal networks only.",
      title: "Knowledge Ingest API",
      version: "0.1.0",
    },
    openapi: "3.1.0",
    tags: [
      { description: "Enqueue and observe ingestion work", name: "ingestion" },
      { description: "Liveness and readiness", name: "health" },
    ],
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
    // Malformed JSON thrown by the body parsers is untrusted input, not a
    // server fault: answer the 422 validation envelope.
    if (thrown instanceof SyntaxError || thrown instanceof HTTPException) {
      return c.json(
        errorBody(
          "invalid_request",
          "request body is not valid JSON",
          c.get("requestId")
        ),
        422
      );
    }
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
