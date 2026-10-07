import type { PgClient, PgPool } from "../src/pg-client.ts";

export interface FakePool {
  /** Every statement in order, tagged with its checkout (null for `pool.query`). */
  calls: { checkout: number | null; text: string }[];
  pool: PgPool;
  /** One entry per `release`, with the error it was given. */
  releases: { checkout: number; error: Error | undefined }[];
}

/**
 * A pool whose checkouts all forward to `backend`, numbered so tests can
 * prove which connection each statement ran on.
 */
export const fakePool = (backend: PgClient): FakePool => {
  const calls: FakePool["calls"] = [];
  const releases: FakePool["releases"] = [];
  let checkouts = 0;
  const pool: PgPool = {
    connect: () => {
      checkouts += 1;
      const checkout = checkouts;
      return Promise.resolve({
        query: (text, params) => {
          calls.push({ checkout, text });
          return backend.query(text, params);
        },
        release: (error) => {
          releases.push({ checkout, error });
        },
      });
    },
    query: (text, params) => {
      calls.push({ checkout: null, text });
      return backend.query(text, params);
    },
  };
  return { calls, pool, releases };
};
