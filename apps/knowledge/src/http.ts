/** HTTP plumbing shared by the ingest and retrieval services. */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { createMiddleware } from "hono/factory";

import type { Logger } from "./log.ts";

export interface RequestEnv {
  Variables: { requestId: string };
}

const tokenFingerprint = (token: string): Buffer =>
  createHash("sha256").update(token).digest();

/** Compares fixed-length digests, so the check leaks neither length nor content. */
export const bearerTokenMatches = (
  header: string,
  expected: string
): boolean => {
  const match = /^Bearer\s+(?<token>.+)$/u.exec(header);
  const token = match?.groups?.["token"];
  if (!token) {
    return false;
  }
  return timingSafeEqual(tokenFingerprint(token), tokenFingerprint(expected));
};

/** Keeps a well-formed caller `x-request-id` for log correlation, else mints one. */
export const requestIdMiddleware = () =>
  createMiddleware<RequestEnv>(async (c, next) => {
    const header = c.req.header("x-request-id") ?? "";
    c.set(
      "requestId",
      /^[\w.-]{8,128}$/u.test(header) ? header : `req_${randomUUID()}`
    );
    return await next();
  });

/** One log line per request, written once the handler has answered. */
export const requestLogMiddleware = (logger: Logger) =>
  createMiddleware<RequestEnv>(async (c, next) => {
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
  });
