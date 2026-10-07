/** Minimal pg-compatible client surface; satisfied by `pg` Pool/Client. */
export interface PgClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
}

/** A checked-out connection; `release(error)` destroys it instead of reusing it. */
export interface PgPoolClient extends PgClient {
  release: (error?: Error) => void;
}

/** Satisfied by `pg.Pool`. */
export interface PgPool extends PgClient {
  connect: () => Promise<PgPoolClient>;
}

/**
 * Runs `fn` between BEGIN and COMMIT on one dedicated connection. A pool
 * checks out a connection per `query`, so a transaction issued through it can
 * BEGIN on one connection, COMMIT on another, and sweep up concurrent callers'
 * statements in between. Every transaction goes through here.
 */
export const withTransaction = async <T>(
  pool: PgPool,
  fn: (client: PgClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN", []);
    const result = await fn(client);
    await client.query("COMMIT", []);
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK", []);
    } catch (rollbackError) {
      // A connection that cannot roll back must not return to the pool.
      broken =
        rollbackError instanceof Error
          ? rollbackError
          : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(broken);
  }
};
