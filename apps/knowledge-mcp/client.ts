// Thin HTTP client for the knowledge retrieval API (#64). Knows nothing
// about MCP or ranking: it forwards validated inputs, checks responses
// against the pinned contract, and turns every failure mode into a short,
// agent-readable message. The bearer token is attached per request and is
// never copied into error text or results.
import type { ZodType } from "zod";

import type {
  SearchResponse,
  SearchToolInput,
  SourceDetail,
} from "./contract.js";
import {
  SEARCH_ENDPOINT,
  SOURCE_ENDPOINT,
  SearchResponseSchema,
  SourceDetailSchema,
} from "./contract.js";
import { KnowledgeApiError } from "./errors.js";

const ERROR_SNIPPET_MAX = 200;

const truncate = (text: string): string =>
  text.length <= ERROR_SNIPPET_MAX
    ? text
    : `${text.slice(0, ERROR_SNIPPET_MAX)}…`;

export interface KnowledgeClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class KnowledgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor({
    baseUrl,
    token,
    timeoutMs,
    fetchImpl = fetch,
  }: KnowledgeClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  search(input: SearchToolInput): Promise<SearchResponse> {
    const body: Record<string, unknown> = { query: input.query };
    if (input.namespace !== undefined) {
      body.namespace = input.namespace;
    }
    if (input.mode !== undefined) {
      body.mode = input.mode;
    }
    if (input.top_k !== undefined) {
      body.top_k = input.top_k;
    }
    return this.request(SEARCH_ENDPOINT, {
      body: JSON.stringify(body),
      method: "POST",
      schema: SearchResponseSchema,
    });
  }

  getSource(sourceId: string): Promise<SourceDetail> {
    return this.request(`${SOURCE_ENDPOINT}/${encodeURIComponent(sourceId)}`, {
      method: "GET",
      notFoundSubject: sourceId,
      schema: SourceDetailSchema,
    });
  }

  private redact(text: string): string {
    return this.token ? text.replaceAll(this.token, "[redacted]") : text;
  }

  private async request<T>(
    route: string,
    opts: {
      method: "GET" | "POST";
      body?: string;
      schema: ZodType<T>;
      notFoundSubject?: string;
    }
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${route}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(opts.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        method: opts.method,
        ...(opts.body === undefined ? {} : { body: opts.body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw this.networkError(error);
    }

    if (!res.ok) {
      throw await this.httpError(res, opts.notFoundSubject);
    }

    const raw: unknown = await KnowledgeClient.parseJson(res);
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const where = issue ? issue.path.join(".") : "(root)";
      const why = issue ? issue.message : "unknown";
      throw new KnowledgeApiError(
        "contract",
        this.redact(
          `knowledge API response failed contract validation at "${where}": ${why}`
        )
      );
    }
    return raw as T;
  }

  private networkError(error: unknown): KnowledgeApiError {
    if (error instanceof Error && error.name === "TimeoutError") {
      return new KnowledgeApiError(
        "timeout",
        `knowledge API request timed out after ${this.timeoutMs}ms`
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    return new KnowledgeApiError(
      "network",
      this.redact(`knowledge API unreachable: ${truncate(reason)}`)
    );
  }

  private async httpError(
    res: Response,
    notFoundSubject?: string
  ): Promise<KnowledgeApiError> {
    const { status } = res;
    if (status === 404) {
      const subject = notFoundSubject ?? "resource";
      return new KnowledgeApiError(
        "not_found",
        `${subject} not found in the knowledge API (HTTP 404)`,
        status
      );
    }
    if (status === 401 || status === 403) {
      return new KnowledgeApiError(
        "auth",
        `knowledge API rejected credentials (HTTP ${status}) — check the injected token`,
        status
      );
    }
    if (status === 400 || status === 422) {
      const snippet = await this.errorSnippet(res);
      return new KnowledgeApiError(
        "invalid_request",
        this.redact(
          `knowledge API rejected the request (HTTP ${status}): ${snippet}`
        ),
        status
      );
    }
    if (status === 429) {
      return new KnowledgeApiError(
        "rate_limited",
        "knowledge API is rate limited (HTTP 429) — retry shortly",
        status
      );
    }
    const snippet = await this.errorSnippet(res);
    return new KnowledgeApiError(
      "upstream",
      this.redact(`knowledge API failure (HTTP ${status}): ${snippet}`),
      status
    );
  }

  private async errorSnippet(res: Response): Promise<string> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      return "(no body)";
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["error", "detail", "message"]) {
          const value = record[key];
          if (typeof value === "string" && value) {
            return this.redact(truncate(value));
          }
        }
      }
    } catch {
      // not JSON — fall through to the raw snippet
    }
    return this.redact(truncate(text)) || "(no body)";
  }

  private static async parseJson(res: Response): Promise<unknown> {
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new KnowledgeApiError(
        "malformed",
        `knowledge API response body unreadable: ${truncate(reason)}`
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new KnowledgeApiError(
        "malformed",
        "knowledge API response was not valid JSON"
      );
    }
  }
}
