import assert from "node:assert/strict";
import { test } from "node:test";

import { createPgPool } from "../src/pg-pool.ts";

test("the pool carries its limits and survives an idle client's error", async () => {
  const errors: Error[] = [];
  const pool = await createPgPool({
    applicationName: "knowledge-test",
    connectionString: "postgresql://knowledge:unused@127.0.0.1:1/knowledge",
    max: 3,
    onError: (error) => {
      errors.push(error);
    },
    statementTimeoutMs: 1234,
  });
  try {
    const { options } = pool as unknown as {
      options: Record<string, unknown>;
    };
    assert.equal(options["max"], 3);
    assert.equal(options["statement_timeout"], 1234);
    assert.equal(options["application_name"], "knowledge-test");
    assert.equal(options["connectionTimeoutMillis"], 5000);
    // pg emits this when Postgres restarts under an idle client; with no
    // listener it would throw and take the process down.
    pool.emit(
      "error",
      new Error("terminating connection due to administrator command")
    );
    assert.equal(errors.length, 1);
  } finally {
    await pool.end();
  }
});
