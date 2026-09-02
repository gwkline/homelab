// Integration tests for the #70 GitHub App token service.
// The JWT/token exchange is fully mocked (no network, no real GitHub App
// needed); a throwaway RSA keypair is generated per run so no test key
// is ever committed. node --test + --experimental-strip-types, like panel.
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { parsePermissionSpec, normalizePrivateKeyPem } from "../mint.ts";
import { createTokenService, signAppJwt } from "../token-service.ts";
import type { PermissionRequest } from "../token-service.ts";

const APP_ID = "123456";
const INSTALLATION_ID = "987654";
const FIXED_NOW = 1_700_000_000_000;

const testCredentials = (privateKey: string) => ({
  appId: APP_ID,
  installationId: INSTALLATION_ID,
  privateKey,
});

const generateTestKey = (): { privatePem: string; publicPem: string } => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privatePem: privateKey, publicPem: publicKey };
};

const decodeSegment = (segment: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf-8")) as Record<
    string,
    unknown
  >;

interface ExchangeCall {
  url: string;
  init: RequestInit;
}

interface ResponseSpec {
  body: unknown;
  status?: number;
}

interface MockExchange {
  calls: ExchangeCall[];
  fetch: typeof fetch;
}

// Mocks the JWT/token exchange: records every call and answers with the
// given static spec, or a per-call spec produced by `response()` (used for
// dynamic expiry/token sequences). No network is touched.
const mockExchangeFactory = (
  response: ResponseSpec | (() => ResponseSpec)
): MockExchange => {
  const calls: ExchangeCall[] = [];
  const fetchImpl = (
    url: string | URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    calls.push({ init: init ?? {}, url: String(url) });
    const spec = typeof response === "function" ? response() : response;
    return Promise.resolve(
      Response.json(spec.body, { status: spec.status ?? 200 })
    );
  };
  return { calls, fetch: fetchImpl as typeof fetch };
};

const tokenResponse =
  (token: string, ttlMs: number, baseMs: number) => (): ResponseSpec => ({
    body: {
      expires_at: new Date(baseMs + ttlMs).toISOString(),
      token,
    },
  });

const serialTokenResponse = (baseMs: number) => {
  let serial = 0;
  return (): ResponseSpec => {
    serial += 1;
    return {
      body: {
        expires_at: new Date(baseMs + 3_600_000).toISOString(),
        token: `ghs_token_${serial}`,
      },
    };
  };
};

test("signAppJwt emits an RS256 JWT with GitHub-compliant claims", () => {
  const { privatePem, publicPem } = generateTestKey();
  const nowMs = FIXED_NOW;
  const jwt = signAppJwt(testCredentials(privatePem), nowMs);
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature, "JWT has three segments");
  assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });
  const claims = decodeSegment(payload);
  assert.equal(claims.iss, APP_ID);
  // Backdated 60s for clock skew, expires within GitHub's 10-minute cap.
  assert.equal(claims.iat, 1_700_000_000 - 60);
  const exp = claims.exp as number;
  assert.ok(exp > (claims.iat as number));
  assert.ok(exp - (claims.iat as number) <= 600);
  const signatureOk = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    createPublicKey(publicPem),
    Buffer.from(signature, "base64url")
  );
  assert.equal(signatureOk, true);
});

test("tampered JWT payloads fail signature verification", () => {
  const { privatePem, publicPem } = generateTestKey();
  const jwt = signAppJwt(testCredentials(privatePem), FIXED_NOW);
  const [header, , signature] = jwt.split(".");
  assert.ok(header && signature);
  const forged = Buffer.from(
    JSON.stringify({ exp: 9_999_999_999, iat: 0, iss: APP_ID })
  ).toString("base64url");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${forged}`),
      createPublicKey(publicPem),
      Buffer.from(signature, "base64url")
    ),
    false
  );
});

test("exchanges the app JWT for an installation token", async () => {
  const { privatePem } = generateTestKey();
  const exchange = mockExchangeFactory(
    tokenResponse("ghs_minted_token", 3_600_000, FIXED_NOW)
  );
  const service = createTokenService(testCredentials(privatePem), {
    apiBase: "https://api.github.test/",
    fetchImpl: exchange.fetch,
    now: () => FIXED_NOW,
  });
  const minted = await service.getToken({ contents: "read" });
  assert.equal(exchange.calls.length, 1);
  const [call] = exchange.calls;
  assert.ok(call);
  assert.equal(
    call.url,
    "https://api.github.test/app/installations/987654/access_tokens"
  );
  assert.equal(call.init.method, "POST");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.equal(headers["x-github-api-version"], "2022-11-28");
  assert.ok(headers.authorization, "authorization header present");
  const jwt = headers.authorization.slice("Bearer ".length);
  const [jwtHeader, jwtPayload] = jwt.split(".");
  assert.ok(jwtHeader && jwtPayload);
  assert.deepEqual(decodeSegment(jwtHeader), { alg: "RS256", typ: "JWT" });
  assert.equal(decodeSegment(jwtPayload).iss, APP_ID);
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    permissions: { contents: "read" },
  });
  assert.equal(minted.token, "ghs_minted_token");
  assert.equal(
    minted.expiresAt.toISOString(),
    new Date(FIXED_NOW + 3_600_000).toISOString()
  );
  assert.deepEqual(minted.permissions, { contents: "read" });
});

test("omits the request body when no narrowing is requested", async () => {
  const { privatePem } = generateTestKey();
  const exchange = mockExchangeFactory(
    tokenResponse("ghs_full_grant", 3_600_000, FIXED_NOW)
  );
  const service = createTokenService(testCredentials(privatePem), {
    fetchImpl: exchange.fetch,
    now: () => FIXED_NOW,
  });
  const minted = await service.getToken();
  assert.equal(minted.token, "ghs_full_grant");
  assert.equal(exchange.calls.length, 1);
  assert.equal(exchange.calls[0]?.init.body, undefined);
});

test("caches within validity and refreshes before expiry", async () => {
  const { privatePem } = generateTestKey();
  let now = FIXED_NOW;
  let serial = 0;
  const exchange = mockExchangeFactory(() => {
    serial += 1;
    return {
      body: {
        expires_at: new Date(now + 3_600_000).toISOString(),
        token: `ghs_token_${serial}`,
      },
    };
  });
  const service = createTokenService(testCredentials(privatePem), {
    fetchImpl: exchange.fetch,
    now: () => now,
  });
  const first = await service.getToken({ contents: "read" });
  const cached = await service.getToken({ contents: "read" });
  assert.equal(exchange.calls.length, 1);
  assert.equal(cached.token, first.token);
  // 56 minutes later: 4 minutes to expiry (< 5 min margin) → refresh.
  now += 56 * 60_000;
  const refreshed = await service.getToken({ contents: "read" });
  assert.equal(exchange.calls.length, 2);
  assert.notEqual(refreshed.token, first.token);
});

test("mints separately per permission set (least-privilege narrowing)", async () => {
  const { privatePem } = generateTestKey();
  let serial = 0;
  const exchange = mockExchangeFactory(() => {
    serial += 1;
    return {
      body: {
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(),
        token: `ghs_token_${serial}`,
      },
    };
  });
  const service = createTokenService(testCredentials(privatePem), {
    fetchImpl: exchange.fetch,
    now: () => FIXED_NOW,
  });
  const collector: PermissionRequest = {
    contents: "read",
    issues: "read",
    metadata: "read",
  };
  const publisher: PermissionRequest = {
    contents: "write",
    pull_requests: "write",
  };
  await service.getToken(collector);
  await service.getToken(publisher);
  assert.equal(exchange.calls.length, 2);
  assert.deepEqual(
    JSON.parse(String(exchange.calls[0]?.init.body)).permissions,
    collector
  );
  assert.deepEqual(
    JSON.parse(String(exchange.calls[1]?.init.body)).permissions,
    publisher
  );
  // A repeated read-only request is served from cache.
  await service.getToken(collector);
  assert.equal(exchange.calls.length, 2);
});

test("error messages never carry the JWT, token, or response body", async () => {
  const { privatePem } = generateTestKey();
  const exchange = mockExchangeFactory({
    body: {
      message: "boom ghs_secret_token_value Bearer leaked.jwt.value",
    },
    status: 500,
  });
  const service = createTokenService(testCredentials(privatePem), {
    fetchImpl: exchange.fetch,
    now: () => FIXED_NOW,
  });
  let failureMessage = "";
  try {
    await service.getToken({ contents: "read" });
    assert.fail("expected the exchange to fail");
  } catch (error) {
    failureMessage = String((error as Error).message);
  }
  assert.match(failureMessage, /HTTP 500/u);
  assert.ok(!failureMessage.includes("boom"), "no response body in errors");
  assert.ok(!failureMessage.includes("ghs_secret_token_value"));
  assert.ok(!failureMessage.includes("leaked.jwt.value"));
  const [call] = exchange.calls;
  assert.ok(call);
  const failedJwt =
    (call.init.headers as Record<string, string>).authorization?.slice(
      "Bearer ".length
    ) ?? "";
  assert.ok(failedJwt.length > 0);
  assert.ok(!failureMessage.includes(failedJwt), "no JWT in errors");
  // Network-level failure: the thrown message omits the cause text too.
  const failingService = createTokenService(testCredentials(privatePem), {
    fetchImpl: (() =>
      Promise.reject(
        new Error("ECONNRESET ghs_secret_token_value")
      )) as unknown as typeof fetch,
    now: () => FIXED_NOW,
  });
  await assert.rejects(
    () => failingService.getToken({ contents: "read" }),
    (error: Error) => {
      const message = String(error.message);
      assert.ok(!message.includes("ghs_secret_token_value"));
      assert.ok(!message.includes("ECONNRESET"));
      return true;
    }
  );
});

test("clear() drops cached tokens and forces a fresh exchange", async () => {
  const { privatePem } = generateTestKey();
  const exchange = mockExchangeFactory(serialTokenResponse(FIXED_NOW));
  const service = createTokenService(testCredentials(privatePem), {
    fetchImpl: exchange.fetch,
    now: () => FIXED_NOW,
  });
  await service.getToken({ contents: "write" });
  service.clear();
  await service.getToken({ contents: "write" });
  assert.equal(exchange.calls.length, 2);
});

test("rejects incomplete credentials before any exchange", () => {
  const { privatePem } = generateTestKey();
  assert.throws(
    () =>
      createTokenService({
        appId: "",
        installationId: "1",
        privateKey: privatePem,
      }),
    /appId is required/u
  );
  assert.throws(
    () =>
      createTokenService({
        appId: "1",
        installationId: "",
        privateKey: privatePem,
      }),
    /installationId is required/u
  );
  assert.throws(
    () =>
      createTokenService({
        appId: "1",
        installationId: "2",
        privateKey: "not-a-pem",
      }),
    /private key is required/u
  );
});

test("CLI helpers: permission spec parsing and PEM normalization", () => {
  assert.deepEqual(parsePermissionSpec("contents:read, issues:read"), {
    contents: "read",
    issues: "read",
  });
  assert.deepEqual(parsePermissionSpec("contents:write"), {
    contents: "write",
  });
  assert.throws(
    () => parsePermissionSpec("contents:admin"),
    /invalid --permissions/u
  );
  assert.throws(
    () => parsePermissionSpec("contents:read,contents:write"),
    /duplicate --permissions/u
  );
  assert.throws(() => parsePermissionSpec("  "), /empty --permissions/u);
  assert.equal(
    normalizePrivateKeyPem(
      "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----"
    ),
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
  );
  const alreadyReal =
    "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  assert.equal(normalizePrivateKeyPem(alreadyReal), alreadyReal);
});
