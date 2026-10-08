/**
 * The services' Postgres pool. `statement_timeout` has the server cancel any
 * statement past its deadline, so a request that already timed out on our
 * side stops consuming the database. The connection timeout makes checkouts
 * fail fast while Postgres is down instead of hanging.
 */

import type { Pool } from "pg";

export const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;

export interface PgPoolOptions {
  /** Shown in `pg_stat_activity`, so operators can tell the services apart. */
  applicationName: string;
  connectionString: string;
  connectionTimeoutMs?: number;
  max: number;
  /**
   * Idle clients emit errors on the pool when Postgres restarts; without a
   * listener the process crashes. The pool replaces the client either way.
   */
  onError: (error: Error) => void;
  statementTimeoutMs: number;
}

/** `pg` is imported lazily so offline consumers never need the driver. */
export const createPgPool = async (options: PgPoolOptions): Promise<Pool> => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    application_name: options.applicationName,
    connectionString: options.connectionString,
    connectionTimeoutMillis:
      options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    max: options.max,
    statement_timeout: options.statementTimeoutMs,
  });
  pool.on("error", options.onError);
  return pool;
};
