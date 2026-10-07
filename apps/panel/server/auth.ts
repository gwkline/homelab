import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { HttpBindings } from "@hono/node-server";
import type { Context, MiddlewareHandler } from "hono";

export interface AuthEnv {
  Bindings: HttpBindings;
  Variables: { caller: string };
}

// Kubernetes label-value safe: the caller rides the Job's requested-by label.
const CALLER_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const readPairs = (file: string): { credential: string; name: string }[] => {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    // Secret not mounted: nobody may mutate.
    return [];
  }
  return text.split(/[\n,]/u).flatMap((entry) => {
    const eq = entry.indexOf("=");
    const name = entry.slice(0, eq).trim();
    const credential = entry.slice(eq + 1).trim();
    return eq > 0 && CALLER_NAME_RE.test(name) && credential !== ""
      ? [{ credential, name }]
      : [];
  });
};

const sha256 = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

const tokenCaller = (dir: string, token: string): string | null => {
  const presented = sha256(token);
  let caller: string | null = null;
  // Fixed-length digests compared in constant time, over every entry.
  for (const { credential, name } of readPairs(path.join(dir, "tokens"))) {
    if (timingSafeEqual(sha256(credential), presented) && caller === null) {
      caller = name;
    }
  }
  return caller;
};

const userCaller = (dir: string, login: string): string | null =>
  readPairs(path.join(dir, "users")).find(
    ({ credential }) => credential.toLowerCase() === login.toLowerCase()
  )?.name ?? null;

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

// "same-origin" only on proof from the browser; "unknown" for clients that
// send neither header (curl, Executor).
const requestSite = (c: Context): "same-origin" | "cross-site" | "unknown" => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite !== undefined) {
    return fetchSite === "same-origin" ? "same-origin" : "cross-site";
  }
  const origin = c.req.header("origin");
  if (origin === undefined) {
    return "unknown";
  }
  const host = hostOf(origin);
  const served = [c.req.header("host"), c.req.header("x-forwarded-host")];
  return host !== null && served.includes(host) ? "same-origin" : "cross-site";
};

const mediaType = (contentType: string | undefined): string =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

// Caller identity and cross-site protection for every mutating /api route.
//
// The panel listens twice. PORT serves in-cluster callers (Executor, homepage,
// the stats CronJob, probes). PANEL_TAILNET_PORT serves the Tailscale Ingress,
// and the NetworkPolicy admits only the panel's own Tailscale proxy pod to it.
// `tailscale serve` deletes client-sent Tailscale-User-* headers and sets
// Tailscale-User-Login from WhoIs for user-owned devices, so that header is
// trusted on the tailnet port and ignored everywhere else. Tagged devices get
// no identity header and authenticate like machines, with a bearer token.
//
// Tailscale identity is ambient: the proxy attaches it to every request from
// the user's device, including ones a malicious page triggers. Those requests
// must prove they come from the panel page itself (Sec-Fetch-Site or Origin).
// A bearer token is explicit, and a cross-site page cannot attach one without
// a CORS preflight, which the panel never grants.
//
// Credentials live in PANEL_AUTH_DIR (Secret panel-auth) and are re-read on
// every mutation, so rotations apply without a restart:
//   users   name=tailscale-login pairs allowed to act through the UI
//   tokens  name=bearer-token pairs for machine callers
// Pairs are separated by commas or newlines. The name is the caller identity
// the factory records as "requested by"; logins and tokens never leave here.
export const requireCaller =
  (opts: {
    authDir: string;
    tailnetPort: number | null;
  }): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      return await next();
    }
    const site = requestSite(c);
    if (site === "cross-site") {
      return c.json({ error: "cross-site request refused" }, 403);
    }
    if (mediaType(c.req.header("content-type")) !== "application/json") {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    const authorization = c.req.header("authorization");
    if (authorization !== undefined) {
      const token = /^Bearer\s+(?<token>\S+)$/iu.exec(authorization)?.groups
        ?.token;
      const caller =
        token === undefined ? null : tokenCaller(opts.authDir, token);
      if (caller === null) {
        return c.json({ error: "invalid bearer token" }, 401);
      }
      c.set("caller", caller);
      return await next();
    }
    const viaTailnet =
      opts.tailnetPort !== null &&
      c.env.incoming.socket.localPort === opts.tailnetPort;
    const login = viaTailnet ? c.req.header("tailscale-user-login") : undefined;
    if (login === undefined || login === "") {
      return c.json(
        { error: "sign in through the tailnet or send a bearer token" },
        401
      );
    }
    if (site !== "same-origin") {
      return c.json(
        { error: "browser requests must come from the panel page" },
        403
      );
    }
    const caller = userCaller(opts.authDir, login);
    if (caller === null) {
      return c.json({ error: `${login} may not make changes here` }, 403);
    }
    c.set("caller", caller);
    return await next();
  };
