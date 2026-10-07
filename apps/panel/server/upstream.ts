import { log } from "./log.js";

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

// Every outbound call gives up after this long. The UI polls every 10–30 s,
// so a hung upstream must fail requests rather than let them pile up.
export const UPSTREAM_TIMEOUT_MS = positiveInt(
  process.env.PANEL_UPSTREAM_TIMEOUT_MS,
  10_000
);
// Ceiling on a whole /api request, which may chain several upstream calls.
export const REQUEST_TIMEOUT_MS = positiveInt(
  process.env.PANEL_REQUEST_TIMEOUT_MS,
  30_000
);

export type UpstreamError = Error & { status: number };

// Logs a failed upstream call and returns the error a route should surface:
// 504 when the call timed out, the upstream's own status when it answered,
// 502 when it could not be reached.
export const upstreamError = (
  upstream: string,
  call: { method: string; path: string },
  cause: unknown,
  status?: number
): UpstreamError => {
  const timedOut =
    cause instanceof Error &&
    (cause.name === "TimeoutError" || cause.name === "AbortError");
  let message = cause instanceof Error ? cause.message : String(cause);
  if (timedOut) {
    message = `${upstream} timed out after ${UPSTREAM_TIMEOUT_MS}ms`;
  } else if (status === undefined) {
    message = `${upstream} unreachable: ${message}`;
  }
  const error = Object.assign(new Error(message), {
    status: timedOut ? 504 : (status ?? 502),
  });
  log("warn", "upstream error", {
    error: message,
    method: call.method,
    path: call.path,
    status: error.status,
    upstream,
  });
  return error;
};
