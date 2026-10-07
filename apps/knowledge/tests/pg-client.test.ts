import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import type { PgClient } from "../src/pg-client.ts";
import { withTransaction } from "../src/pg-client.ts";
import { fakePool } from "./fake-pool.ts";

const okBackend: PgClient = {
  query: () => Promise.resolve({ rows: [] }),
};

test("withTransaction runs every statement on one checkout and releases it clean", async () => {
  const { calls, pool, releases } = fakePool(okBackend);
  const result = await withTransaction(pool, async (client) => {
    await client.query("SELECT 1", []);
    await client.query("SELECT 2", []);
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(calls, [
    { checkout: 1, text: "BEGIN" },
    { checkout: 1, text: "SELECT 1" },
    { checkout: 1, text: "SELECT 2" },
    { checkout: 1, text: "COMMIT" },
  ]);
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
});

test("withTransaction rolls back on the same checkout and releases it on error", async () => {
  const { calls, pool, releases } = fakePool(okBackend);
  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query("SELECT 1", []);
      throw new Error("boom");
    }),
    /boom/u
  );
  assert.deepEqual(calls, [
    { checkout: 1, text: "BEGIN" },
    { checkout: 1, text: "SELECT 1" },
    { checkout: 1, text: "ROLLBACK" },
  ]);
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
});

test("a connection that cannot roll back is released with the error", async () => {
  const dead = new Error("Connection terminated unexpectedly");
  const broken: PgClient = {
    query: (text) =>
      text === "BEGIN" ? Promise.resolve({ rows: [] }) : Promise.reject(dead),
  };
  const { pool, releases } = fakePool(broken);
  await assert.rejects(
    withTransaction(pool, (client) => client.query("SELECT 1", [])),
    /terminated/u
  );
  assert.deepEqual(releases, [{ checkout: 1, error: dead }]);
});

test("concurrent transactions and pool queries never share a connection", async () => {
  const { calls, pool, releases } = fakePool(okBackend);
  const gate: { open?: () => void } = {};
  const opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  const first = withTransaction(pool, async (client) => {
    await client.query("UPDATE a", []);
    await opened;
    await client.query("UPDATE b", []);
  });
  const second = withTransaction(pool, (client) =>
    client.query("UPDATE c", [])
  );
  // A heartbeat landing mid-transaction stays on the pool.
  await pool.query("UPDATE ingest_job SET heartbeat_at = now()", []);
  gate.open?.();
  await Promise.all([first, second]);
  const byCheckout = (checkout: number | null): string[] =>
    calls.filter((call) => call.checkout === checkout).map((c) => c.text);
  assert.deepEqual(byCheckout(1), ["BEGIN", "UPDATE a", "UPDATE b", "COMMIT"]);
  assert.deepEqual(byCheckout(2), ["BEGIN", "UPDATE c", "COMMIT"]);
  assert.deepEqual(byCheckout(null), [
    "UPDATE ingest_job SET heartbeat_at = now()",
  ]);
  assert.equal(releases.length, 2);
});

const KNOWLEDGE_SOURCE_DIRS = [
  "knowledge/src",
  "knowledge-ingest/server",
  "knowledge-retrieval/server",
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));

test("no transaction opens outside withTransaction", () => {
  const appsDir = path.resolve(import.meta.dirname, "../..");
  const owner = path.join(appsDir, "knowledge/src/pg-client.ts");
  const offenders = KNOWLEDGE_SOURCE_DIRS.flatMap((dir) =>
    sourceFiles(path.join(appsDir, dir))
  ).filter(
    (file) =>
      file !== owner &&
      /["'`]\s*(?:BEGIN|START TRANSACTION)\b/iu.test(
        readFileSync(file, "utf-8")
      )
  );
  assert.deepEqual(offenders, []);
});
