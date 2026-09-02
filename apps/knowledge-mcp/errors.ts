// Shared error shape for the knowledge retrieval HTTP API (#64). Kept in its
// own module so the thin HTTP client stays within one class per file.
export type KnowledgeErrorKind =
  | "invalid_request"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network"
  | "malformed"
  | "contract";

export class KnowledgeApiError extends Error {
  readonly kind: KnowledgeErrorKind;
  readonly status?: number;

  constructor(kind: KnowledgeErrorKind, message: string, status?: number) {
    super(message);
    this.name = "KnowledgeApiError";
    this.kind = kind;
    if (status !== undefined) {
      this.status = status;
    }
  }
}
