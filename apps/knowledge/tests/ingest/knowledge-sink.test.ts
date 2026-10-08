import assert from "node:assert/strict";
import { test } from "node:test";

import { PgKnowledgeSink } from "../../server/ingest/knowledge-sink.ts";
import {
  createFakeEmbeddingProvider,
  resolveEmbeddingWorkerConfig,
} from "../../src/embedder.ts";
import type { PgClient } from "../../src/pg-client.ts";
import { fakePool } from "../fake-pool.ts";

const backend = (failOn?: string): PgClient => ({
  query: (text, params) => {
    if (failOn !== undefined && text.includes(failOn)) {
      return Promise.reject(new Error(`${failOn} failed`));
    }
    if (text.includes("ON CONFLICT (namespace, source, external_id)")) {
      return Promise.resolve({ rows: [{ id: params[0], version: 1 }] });
    }
    if (text.startsWith("INSERT INTO document_version")) {
      return Promise.resolve({ rows: [{ id: params[0] }] });
    }
    return Promise.resolve({ rows: [] });
  },
});

const sinkOver = (client: PgClient) => {
  const fake = fakePool(client);
  const sink = new PgKnowledgeSink(fake.pool, {
    config: resolveEmbeddingWorkerConfig({
      provider: createFakeEmbeddingProvider("fake/sink-test"),
    }),
  });
  return { ...fake, sink };
};

const doc = {
  content: "# Runbook\n\nRestart the primary.",
  documentId: "doc-1",
  externalId: "docs/runbook.md",
  format: "markdown" as const,
  namespace: "homelab-docs",
  source: "git",
  title: "Runbook",
  url: null,
  versionId: "doc-1-v1",
};

test("a document version swap runs on one checkout, never the shared pool", async () => {
  const { calls, releases, sink } = sinkOver(backend());
  const outcome = await sink.processDocumentVersion(doc);
  assert.equal(outcome.status, "ok");
  assert.ok(calls.length > 2);
  assert.ok(calls.every((call) => call.checkout === 1));
  assert.equal(calls[0]?.text, "BEGIN");
  assert.equal(calls.at(-1)?.text, "COMMIT");
  assert.deepEqual(releases, [{ checkout: 1, error: undefined }]);
});

test("a tombstone commits on one checkout and rolls back there on failure", async () => {
  const ok = sinkOver(backend());
  await ok.sink.tombstoneDocument("doc-1");
  assert.deepEqual(
    ok.calls.map((call) => [call.checkout, call.text.split(/\s/u)[0]]),
    [
      [1, "BEGIN"],
      [1, "UPDATE"],
      [1, "UPDATE"],
      [1, "COMMIT"],
    ]
  );
  assert.deepEqual(ok.releases, [{ checkout: 1, error: undefined }]);

  const failing = sinkOver(backend("UPDATE chunks"));
  await assert.rejects(
    failing.sink.tombstoneDocument("doc-1"),
    /UPDATE chunks failed/u
  );
  assert.equal(failing.calls.at(-1)?.text, "ROLLBACK");
  assert.ok(failing.calls.every((call) => call.checkout === 1));
  assert.deepEqual(failing.releases, [{ checkout: 1, error: undefined }]);
});

test("concurrent tombstones each get their own checkout", async () => {
  const { calls, releases, sink } = sinkOver(backend());
  await Promise.all([
    sink.tombstoneDocument("doc-1"),
    sink.tombstoneDocument("doc-2"),
  ]);
  for (const checkout of [1, 2]) {
    const texts = calls
      .filter((call) => call.checkout === checkout)
      .map((call) => call.text.split(/\s/u)[0]);
    assert.deepEqual(texts, ["BEGIN", "UPDATE", "UPDATE", "COMMIT"]);
  }
  assert.equal(releases.length, 2);
});

test("manifest reads and writes are single pool statements", async () => {
  const { calls, releases, sink } = sinkOver(backend());
  const manifest = await sink.loadManifest("git-abc");
  assert.deepEqual(manifest, {
    commitSha: null,
    entries: {},
    sourceKey: "git-abc",
  });
  await sink.saveManifest({ ...manifest, commitSha: "a".repeat(40) });
  assert.deepEqual(
    calls.map((call) => call.checkout),
    [null, null]
  );
  assert.deepEqual(releases, []);
});
