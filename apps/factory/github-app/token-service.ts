// GitHub App installation-token service for the software factory (#70).
//
// Replaces long-lived writer PATs with short-lived installation tokens:
// an RS256 app JWT is exchanged once per (permission set, expiry window)
// for an installation token that GitHub expires after one hour. Tokens
// are cached in memory only — never written to disk, logs, manifests, or
// a database — and refreshed `refreshMarginMs` before expiry.
//
// Permission narrowing: each request may pass a subset of the app's
// installed permissions (e.g. the read-only collector asks for
// metadata/issues/contents read, the publisher for contents RW + PRs RW);
// GitHub issues a token carrying exactly what was requested.
import { createSign } from "node:crypto";

export interface AppCredentials {
  appId: string;
  installationId: string;
  /** PEM-encoded PKCS#1 or PKCS#8 private key (from the 1Password item). */
  privateKey: string;
}

export type PermissionLevel = "read" | "write";
export type PermissionRequest = Record<string, PermissionLevel>;

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  /** The permission set this token was minted for ({} = full app grant). */
  permissions: PermissionRequest;
}

export interface TokenServiceOptions {
  /** GitHub REST API root. Override for tests / GHES. */
  apiBase?: string;
  /** Injectable fetch so tests can mock the JWT/token exchange. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms since epoch) for expiry-aware cache tests. */
  now?: () => number;
  /** Refresh a cached token this long before its expiry (default 5 min). */
  refreshMarginMs?: number;
}

export interface TokenService {
  getToken: (request?: PermissionRequest) => Promise<InstallationToken>;
  /** Drop every cached token (e.g. after a revocation). */
  clear: () => void;
}

interface ResolvedOptions {
  apiBase: string;
  fetchImpl: typeof fetch;
  now: () => number;
  refreshMarginMs: number;
}

// GitHub caps app JWT lifetime at 10 minutes; 9 leaves headroom for skew.
const JWT_TTL_S = 540;
const JWT_CLOCK_SKEW_S = 60;
const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

const encodeBase64Url = (value: string | Buffer): string =>
  (typeof value === "string" ? Buffer.from(value, "utf-8") : value).toString(
    "base64url"
  );

/**
 * Signs a GitHub App JWT (RS256) valid from `nowMs - 60s` for 9 minutes.
 * Claim shape per https://docs.github.com/en/apps/creating-github-apps
 */
export const signAppJwt = (app: AppCredentials, nowMs: number): string => {
  const header = { alg: "RS256", typ: "JWT" };
  const issuedAt = Math.floor(nowMs / 1000) - JWT_CLOCK_SKEW_S;
  const payload = {
    exp: issuedAt + JWT_TTL_S,
    iat: issuedAt,
    iss: app.appId,
  };
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(app.privateKey);
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

const cacheKey = (request: PermissionRequest): string =>
  Object.keys(request)
    .toSorted()
    .map((name) => `${name}:${request[name]}`)
    .join(",");

interface TokenExchangeResponse {
  expires_at?: string;
  token?: string;
}

/**
 * Mints one installation token via
 * POST /app/installations/{id}/access_tokens. Error messages carry only
 * fixed strings and HTTP status codes — never the JWT, the minted token,
 * or response bodies — so failures are safe to log.
 */
export const mintInstallationToken = async (
  app: AppCredentials,
  request: PermissionRequest | undefined,
  options: ResolvedOptions
): Promise<InstallationToken> => {
  const jwt = signAppJwt(app, options.now());
  const base = options.apiBase.replace(/\/+$/u, "");
  const url = `${base}/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`;
  const init: RequestInit = {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    method: "POST",
  };
  if (request) {
    init.body = JSON.stringify({ permissions: request });
  }
  let response: Response;
  try {
    response = await options.fetchImpl(url, init);
  } catch {
    throw new Error(
      `github app token exchange failed: network error reaching ${base}`
    );
  }
  if (!response.ok) {
    throw new Error(
      `github app token exchange failed (HTTP ${response.status})`
    );
  }
  const data = (await response.json()) as TokenExchangeResponse;
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("github app token exchange returned no token");
  }
  const expiresAt = data.expires_at ? new Date(data.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    throw new Error("github app token exchange returned no valid expiry");
  }
  return { expiresAt, permissions: request ?? {}, token: data.token };
};

const resolveCredentials = (app: AppCredentials): AppCredentials => {
  if (typeof app.appId !== "string" || app.appId.length === 0) {
    throw new Error("github app credentials: appId is required");
  }
  if (
    typeof app.installationId !== "string" ||
    app.installationId.length === 0
  ) {
    throw new Error("github app credentials: installationId is required");
  }
  if (
    typeof app.privateKey !== "string" ||
    !app.privateKey.includes("PRIVATE KEY")
  ) {
    throw new Error("github app credentials: PEM private key is required");
  }
  return app;
};

const resolveOptions = (options: TokenServiceOptions): ResolvedOptions => ({
  apiBase: options.apiBase ?? DEFAULT_API_BASE,
  fetchImpl: options.fetchImpl ?? fetch,
  now: options.now ?? Date.now,
  refreshMarginMs: options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS,
});

export const createTokenService = (
  app: AppCredentials,
  options: TokenServiceOptions = {}
): TokenService => {
  const credentials = resolveCredentials(app);
  const resolved = resolveOptions(options);
  const cache = new Map<string, InstallationToken>();
  return {
    clear: (): void => {
      cache.clear();
    },
    getToken: async (request = {}): Promise<InstallationToken> => {
      const key = cacheKey(request);
      const cached = cache.get(key);
      if (
        cached &&
        resolved.now() < cached.expiresAt.getTime() - resolved.refreshMarginMs
      ) {
        return cached;
      }
      const narrowed = Object.keys(request).length > 0 ? request : undefined;
      const minted = await mintInstallationToken(
        credentials,
        narrowed,
        resolved
      );
      const entry: InstallationToken = {
        expiresAt: minted.expiresAt,
        permissions: request,
        token: minted.token,
      };
      cache.set(key, entry);
      return entry;
    },
  };
};
