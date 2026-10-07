/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface PgClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}
