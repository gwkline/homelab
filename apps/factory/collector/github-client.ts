// GitHub REST client for the issue collector (#78).
//
// Bounded, polite, and observable:
// - **Pagination** — list calls follow `Link: rel="next"` up to `maxPages`
//   and de-duplicate issues by number (an issue updated between page fetches
//   can appear on two pages; the newest copy wins).
// - **Conditional requests** — callers pass the ETag of the previous list
//   response; a `304 Not Modified` short-circuits the tick without spending
//   rate limit on unchanged state.
// - **Rate limits** — 429 and primary rate-limit 403s honor `Retry-After` /
//   `x-ratelimit-reset` (capped), then retry; secondary rate limits are
//   treated the same way.
// - **Transient failures** — network errors and 5xx retry with capped
//   exponential backoff; exhausted retries surface as a thrown
//   `GitHubApiError` so the tick fails visibly (never silently).
//
// Error messages carry fixed strings + status codes only — never tokens,
// URLs with query strings, or response bodies (same redaction stance as #70).
import { promisify } from "node:util";

import { GitHubApiError } from "./github-errors.ts";

export { GitHubApiError } from "./github-errors.ts";

const defaultSleep = promisify(setTimeout) as (ms: number) => Promise<void>;

export interface IssueRef {
  isPullRequest: boolean;
  labels: string[];
  number: number;
  state: "open" | "closed";
  title: string;
  updatedAt: string;
}

export interface ListIssuesResult {
  /** ETag of the final page response — pass back for conditional GETs. */
  etag: string | null;
  issues: IssueRef[];
  /** True when GitHub answered 304 Not Modified (issues is empty then). */
  notModified: boolean;
  /** Number of pages fetched (1+; 0 when served from a 304). */
  pages: number;
}

export interface GitHubClientOptions {
  apiBase: string;
  /** Base delay for exponential backoff in ms (default 1000). */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Pagination safety cap (default 10). */
  maxPages?: number;
  /** Transient-failure retry cap per request (default 4). */
  maxRetries?: number;
  /** Ceiling on any single wait in ms (default 60_000). */
  maxWaitMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  tokenProvider: () => Promise<string>;
}

interface RawIssue {
  labels?: unknown;
  number?: unknown;
  pull_request?: unknown;
  state?: unknown;
  title?: unknown;
  updated_at?: unknown;
}

// GitHub label objects arrive as either "name" strings (GraphQL-ish) or
// {name} objects (REST) depending on endpoint/version — accept both.
const labelName = (label: unknown): string | null => {
  if (typeof label === "string") {
    return label;
  }
  if (
    typeof label === "object" &&
    label !== null &&
    "name" in label &&
    typeof (label as { name: unknown }).name === "string"
  ) {
    return (label as { name: string }).name;
  }
  return null;
};

const asIssueRef = (raw: RawIssue): IssueRef | null => {
  if (
    typeof raw.number !== "number" ||
    (raw.state !== "open" && raw.state !== "closed") ||
    typeof raw.updated_at !== "string" ||
    typeof raw.title !== "string"
  ) {
    return null;
  }
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map(labelName).filter((name): name is string => name !== null)
    : [];
  return {
    isPullRequest: raw.pull_request !== undefined && raw.pull_request !== null,
    labels,
    number: raw.number,
    state: raw.state,
    title: raw.title,
    updatedAt: raw.updated_at,
  };
};

/** Extracts `Link: <url>; rel="next"` from a response header value. */
export const nextPageUrl = (linkHeader: string | null): string | null => {
  if (linkHeader === null) {
    return null;
  }
  for (const part of linkHeader.split(",")) {
    const match = /^\s*<(?<url>[^>]+)>\s*;.*rel="next"/u.exec(part);
    if (match?.groups?.url) {
      return match.groups.url;
    }
  }
  return null;
};

// Transient (retryable) vs permanent failures, decided from status + headers.
const classifyFailure = (response: Response): GitHubApiError => {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const primaryRateLimit =
    (response.status === 403 || response.status === 429) && remaining === "0";
  const secondaryRateLimit =
    response.status === 429 || (response.status === 403 && retryAfter !== null);
  if (primaryRateLimit || secondaryRateLimit) {
    return new GitHubApiError(
      "rate-limit",
      response.status,
      `GitHub rate limit hit (HTTP ${response.status})`
    );
  }
  if (response.status >= 500) {
    return new GitHubApiError(
      "server",
      response.status,
      `GitHub API server error (HTTP ${response.status})`
    );
  }
  return new GitHubApiError(
    "http",
    response.status,
    `GitHub API request failed (HTTP ${response.status})`
  );
};

export class GitHubClient {
  private readonly apiBase: string;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tokenProvider: () => Promise<string>;

  constructor(options: GitHubClientOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/u, "");
    this.backoffMs = options.backoffMs ?? 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxPages = options.maxPages ?? 10;
    this.maxRetries = options.maxRetries ?? 4;
    this.maxWaitMs = options.maxWaitMs ?? 60_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokenProvider = options.tokenProvider;
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const search = new URLSearchParams(query).toString();
    return `${this.apiBase}${path}${search.length > 0 ? `?${search}` : ""}`;
  }

  // One HTTP request with retry/backoff. GET requests may carry an ETag and
  // return null on 304 Not Modified. Exactly one wait happens per retry
  // transition (in the failure branches below); every retry is logged so
  // operators can see throttling in the job logs.
  private async request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    body: string | null,
    etag: string | null,
    requestLabel: string
  ): Promise<Response | null> {
    let attempt = 0;
    let lastError: GitHubApiError = new GitHubApiError(
      "http",
      0,
      "GitHub API request failed (exhausted)"
    );
    for (;;) {
      const token = await this.tokenProvider();
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "factory-collector",
        "x-github-api-version": "2022-11-28",
        ...(body === null ? {} : { "content-type": "application/json" }),
      };
      if (etag !== null) {
        headers["if-none-match"] = etag;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          headers,
          method,
          ...(body === null ? {} : { body }),
        });
      } catch {
        lastError = new GitHubApiError(
          "network",
          0,
          "network error reaching the GitHub API"
        );
        if (attempt >= this.maxRetries) {
          throw lastError;
        }
        const wait = this.waitMs(attempt);
        console.log(
          `[collector] ${requestLabel}: ${lastError.message} — waiting ${wait}ms before retry`
        );
        await this.sleep(wait);
        attempt += 1;
        continue;
      }

      if (response.status === 304) {
        return null;
      }
      if (response.ok) {
        return response;
      }

      lastError = classifyFailure(response);
      // Client errors (401/403 forbidden/404/422…) are not transient:
      // surface them immediately.
      if (lastError.kind === "http") {
        throw lastError;
      }
      if (attempt >= this.maxRetries) {
        throw lastError;
      }
      // Honor the server's own pacing hints (Retry-After, rate-limit reset)
      // when present; fall back to capped exponential backoff.
      const waits: number[] = [this.waitMs(attempt)];
      const retryAfterHeader = response.headers.get("retry-after");
      if (retryAfterHeader !== null && /^\d+$/u.test(retryAfterHeader)) {
        waits.push(Number(retryAfterHeader) * 1000);
      }
      if (
        lastError.kind === "rate-limit" &&
        response.headers.get("x-ratelimit-remaining") === "0" &&
        /^\d+$/u.test(response.headers.get("x-ratelimit-reset") ?? "")
      ) {
        const resetMs =
          Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now();
        if (Number.isFinite(resetMs) && resetMs > 0) {
          waits.push(resetMs);
        }
      }
      const wait = Math.min(this.maxWaitMs, Math.max(...waits));
      console.log(
        `[collector] ${requestLabel}: ${lastError.message} — waiting ${wait}ms before retry`
      );
      await this.sleep(wait);
      attempt += 1;
    }
  }

  // Capped exponential backoff for the n-th retry transition.
  private waitMs(transition: number): number {
    return Math.min(this.maxWaitMs, this.backoffMs * 2 ** transition);
  }

  /**
   * Lists open issues for a repo (pull requests excluded server-side via
   * the caller's filtering — the issues endpoint returns PRs too, and each
   * ref carries isPullRequest). Follows pagination, dedupes by number, and
   * supports conditional GETs via `etag`.
   */
  async listOpenIssues(
    repo: string,
    options: { since?: string | null; etag?: string | null } = {}
  ): Promise<ListIssuesResult> {
    const query: Record<string, string> = {
      direction: "desc",
      per_page: "100",
      sort: "updated",
      state: "open",
    };
    if (options.since) {
      query.since = options.since;
    }
    const issues = new Map<number, IssueRef>();
    let url: string | null = this.url(`/repos/${repo}/issues`, query);
    let etag = options.etag ?? null;
    let pages = 0;
    while (url !== null) {
      if (pages >= this.maxPages) {
        console.log(
          `[collector] ${repo}: pagination cap reached (${this.maxPages} pages) — resuming from the cursor next tick`
        );
        break;
      }
      const response = await this.request(
        "GET",
        url,
        null,
        pages === 0 ? etag : null,
        `${repo}: list issues`
      );
      if (response === null) {
        if (pages === 0) {
          return { etag, issues: [], notModified: true, pages: 0 };
        }
        break;
      }
      const linkHeader = response.headers.get("link");
      const pageEtag = response.headers.get("etag");
      const raw = (await response.json()) as RawIssue[];
      if (!Array.isArray(raw)) {
        throw new GitHubApiError(
          "http",
          response.status,
          "GitHub API returned an unexpected payload shape"
        );
      }
      for (const entry of raw) {
        const ref = asIssueRef(entry);
        if (ref === null) {
          continue;
        }
        const existing = issues.get(ref.number);
        // Newest copy wins when an issue lands on two pages.
        if (
          existing === undefined ||
          Date.parse(ref.updatedAt) >= Date.parse(existing.updatedAt)
        ) {
          issues.set(ref.number, ref);
        }
      }
      pages += 1;
      if (pages === 1) {
        etag = pageEtag;
      }
      url = nextPageUrl(linkHeader);
    }
    return { etag, issues: [...issues.values()], notModified: false, pages };
  }

  /** Re-reads one issue immediately before a queue write (race narrowing). */
  async getIssue(repo: string, issueNumber: number): Promise<IssueRef | null> {
    const response = await this.request(
      "GET",
      this.url(`/repos/${repo}/issues/${issueNumber}`),
      null,
      null,
      `${repo}: get issue #${issueNumber}`
    );
    if (response === null) {
      return null;
    }
    const ref = asIssueRef((await response.json()) as RawIssue);
    return ref;
  }

  /** Adds labels to an issue. Idempotent server-side (add-only). */
  async addLabels(
    repo: string,
    issueNumber: number,
    labels: string[]
  ): Promise<void> {
    await this.request(
      "POST",
      this.url(`/repos/${repo}/issues/${issueNumber}/labels`),
      JSON.stringify({ labels }),
      null,
      `${repo}: queue issue #${issueNumber}`
    );
  }
}
