// Client tests for the collector's GitHub REST layer (#78).
// The GitHub API is faked with an in-memory request router (a fake server
// behind fetch) — no network, no real tokens. Covers the acceptance cases:
// pagination (Link-following + page dedupe + cap), conditional requests
// (ETag/If-None-Match/304), rate limits (Retry-After + reset honoring), and
// transient failures (5xx + network retries). Client errors must NOT retry.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GitHubClient, nextPageUrl } from "../github-client.ts";
import type { GitHubClientOptions } from "../github-client.ts";
import { GitHubApiError } from "../github-errors.ts";

interface FakeRequest {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

interface FakeResponseSpec {
  body?: unknown;
  headers?: Record<string, string>;
  status: number;
}

type Handler = (
  request: FakeRequest
) => FakeResponseSpec | Promise<FakeResponseSpec>;

const issue = (
  number: number,
  updatedAt: string,
  extra: Record<string, unknown> = {}
) => ({
  number,
  state: "open",
  title: `issue ${number}`,
  updated_at: updatedAt,
  ...extra,
});

const client = (
  handler: Handler,
  overrides: Partial<GitHubClientOptions> = {}
): { client: GitHubClient; requests: FakeRequest[]; sleeps: number[] } => {
  const requests: FakeRequest[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (
    url: string | URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers[key] = value;
    }
    const request: FakeRequest = {
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
      method: init?.method ?? "GET",
      url: String(url),
    };
    requests.push(request);
    const spec = await handler(request);
    return new Response(
      spec.body === undefined ? null : JSON.stringify(spec.body),
      {
        status: spec.status,
        headers: spec.headers ?? {},
      }
    );
  }) as typeof fetch;
  const githubClient = new GitHubClient({
    apiBase: "https://github.example/api/v3",
    tokenProvider: async () => "test-token",
    fetchImpl,
    backoffMs: 1,
    maxWaitMs: 5,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { client: githubClient, requests, sleeps };
};

const listPage = (issues: unknown[], nextPage?: number): FakeResponseSpec => ({
  body: issues,
  headers: {
    etag: '"etag-list"',
    ...(nextPage === undefined
      ? {}
      : {
          link: `<https://github.example/api/v3/repos/o/r/issues?page=${nextPage}>; rel="next"`,
        }),
  },
  status: 200,
});

test("pagination follows Link rel=next and aggregates every page", async () => {
  const { client: c, requests } = client((request) => {
    if (request.url.includes("page=2")) {
      return listPage([issue(3, "2026-09-03T00:00:00Z")]);
    }
    return listPage(
      [issue(1, "2026-09-01T00:00:00Z"), issue(2, "2026-09-02T00:00:00Z")],
      2
    );
  });
  const result = await c.listOpenIssues("o/r");
  assert.deepEqual(
    result.issues.map((i) => i.number),
    [1, 2, 3]
  );
  assert.equal(result.pages, 2);
  assert.equal(result.etag, '"etag-list"');
  assert.equal(requests.length, 2);
});

test("pagination dedupes an issue listed on two pages (newest wins)", async () => {
  const { client: c } = client((request) => {
    if (request.url.includes("page=2")) {
      // Issue 1 was updated again between page fetches: the newer copy on
      // page 2 must win and the issue must be listed exactly once.
      return listPage([
        issue(1, "2026-09-05T00:00:00Z"),
        issue(3, "2026-09-03T00:00:00Z"),
      ]);
    }
    return listPage([issue(1, "2026-09-01T00:00:00Z")], 2);
  });
  const result = await c.listOpenIssues("o/r");
  assert.deepEqual(
    result.issues.map((i) => i.number),
    [1, 3]
  );
  assert.equal(result.issues[0]?.updatedAt, "2026-09-05T00:00:00Z");
});

test("pagination cap stops unbounded listing", async () => {
  const { client: c, requests } = client((request) => {
    const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
    return listPage([issue(page, "2026-09-01T00:00:00Z")], page + 1);
  });
  const result = await c.listOpenIssues("o/r");
  assert.equal(result.pages, 10);
  // default maxPages cap
  assert.ok(requests.length <= 10);
});

test("conditional request: ETag sent and 304 short-circuits", async () => {
  let calls = 0;
  const { client: c, requests } = client((request) => {
    calls += 1;
    if (request.headers["if-none-match"] === '"etag-list"') {
      return { status: 304 };
    }
    return listPage([issue(1, "2026-09-01T00:00:00Z")]);
  });
  const first = await c.listOpenIssues("o/r");
  assert.equal(first.notModified, false);
  assert.equal(calls, 1);
  const second = await c.listOpenIssues("o/r", { etag: first.etag });
  assert.equal(second.notModified, true);
  assert.deepEqual(second.issues, []);
  assert.equal(second.pages, 0);
  assert.equal(calls, 2);
  assert.equal(requests[1]?.headers["if-none-match"], '"etag-list"');
});

test("since parameter rides on the listing query", async () => {
  const { client: c, requests } = client(() =>
    listPage([issue(1, "2026-09-02T00:00:00Z")])
  );
  await c.listOpenIssues("o/r", { since: "2026-09-01T00:00:00Z" });
  const url = new URL(requests[0]?.url ?? "");
  assert.equal(url.searchParams.get("since"), "2026-09-01T00:00:00Z");
  assert.equal(url.searchParams.get("state"), "open");
  assert.equal(url.searchParams.get("per_page"), "100");
});

test("primary rate limit honors reset header then succeeds", async () => {
  let calls = 0;
  const { client: c, sleeps } = client(() => {
    calls += 1;
    if (calls === 1) {
      return {
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" },
        status: 403,
      };
    }
    return listPage([issue(1, "2026-09-01T00:00:00Z")]);
  });
  const result = await c.listOpenIssues("o/r");
  assert.equal(result.issues.length, 1);
  assert.equal(calls, 2);
  // reset epoch 1s is in the past → falls back to the capped backoff wait
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] !== undefined && sleeps[0] <= 5);
});

test("429 with Retry-After waits the requested seconds then succeeds", async () => {
  let calls = 0;
  const { client: c, sleeps } = client(
    () => {
      calls += 1;
      if (calls === 1) {
        return {
          body: { message: "slow down" },
          headers: { "retry-after": "2" },
          status: 429,
        };
      }
      return listPage([]);
    },
    { maxWaitMs: 10_000 }
  );
  const result = await c.listOpenIssues("o/r");
  assert.equal(result.pages, 1);
  assert.deepEqual(sleeps, [2000]);
});

test("5xx errors retry with capped exponential backoff then succeed", async () => {
  let calls = 0;
  const { client: c, sleeps } = client(() => {
    calls += 1;
    if (calls <= 2) {
      return { status: 502 };
    }
    return listPage([issue(7, "2026-09-01T00:00:00Z")]);
  });
  const result = await c.listOpenIssues("o/r");
  assert.equal(result.issues[0]?.number, 7);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1, 2]);
});

test("network errors retry and eventually throw", async () => {
  const { client: c, sleeps } = client(() => {
    throw new Error("socket hangup");
  });
  await assert.rejects(
    c.listOpenIssues("o/r"),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.kind === "network" &&
      error.status === 0
  );
  assert.equal(sleeps.length, 4);
  // maxRetries default
});

test("client errors (404) throw immediately without retry", async () => {
  let calls = 0;
  const { client: c, sleeps } = client(() => {
    calls += 1;
    return { body: { message: "Not Found" }, status: 404 };
  });
  await assert.rejects(
    c.listOpenIssues("o/r"),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.kind === "http" &&
      error.status === 404
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("error messages never carry tokens, URLs, or response bodies", async () => {
  const { client: c } = client(() => ({
    body: { message: "secret payload leak" },
    status: 422,
  }));
  try {
    await c.listOpenIssues("o/r");
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.message, "GitHub API request failed (HTTP 422)");
    assert.match(String(error), /422/u);
    assert.doesNotMatch(String(error), /secret/u);
    assert.doesNotMatch(String(error), /test-token/u);
  }
});

test("addLabels posts JSON and getIssue re-reads one issue", async () => {
  const { client: c, requests } = client((request) => {
    if (request.method === "POST" && request.url.endsWith("/labels")) {
      return { body: [], status: 200 };
    }
    if (request.url.endsWith("/issues/5")) {
      return {
        body: issue(5, "2026-09-01T00:00:00Z", { title: 'résumé 🏭 "quoted"' }),
        status: 200,
      };
    }
    throw new Error(`unexpected request ${request.url}`);
  });
  await c.addLabels("o/r", 5, ["factory/queued"]);
  const ref = await c.getIssue("o/r", 5);
  assert.equal(ref?.title, 'résumé 🏭 "quoted"');
  const post = requests.find((r) => r.method === "POST");
  assert.ok(post);
  assert.equal(post.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(post.body ?? "null"), {
    labels: ["factory/queued"],
  });
  const get = requests.find(
    (r) => r.method === "GET" && r.url.endsWith("/issues/5")
  );
  assert.ok(get);
  assert.equal(get.headers.authorization, "Bearer test-token");
});

test("nextPageUrl parses Link headers", () => {
  assert.equal(
    nextPageUrl(
      '<https://api.github.com/r/issues?page=2>; rel="next", <https://api.github.com/r/issues?page=5>; rel="last"'
    ),
    "https://api.github.com/r/issues?page=2"
  );
  assert.equal(
    nextPageUrl('<https://api.github.com/r/issues?page=5>; rel="last"'),
    null
  );
  assert.equal(nextPageUrl(null), null);
});
