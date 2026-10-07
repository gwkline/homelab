// Messages carry fixed strings and status codes only — never tokens, URLs
// with query strings, or response bodies.
export class GitHubApiError extends Error {
  readonly kind: "http" | "network" | "rate-limit" | "server";
  readonly status: number;
  constructor(
    kind: "http" | "network" | "rate-limit" | "server",
    status: number,
    message: string
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.kind = kind;
    this.status = status;
  }
}
