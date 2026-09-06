import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAnchors } from "../src/pgvector.ts";
import {
  checksumMigration,
  ensureKnowledgeSchema,
  KNOWLEDGE_MIGRATIONS,
  KNOWLEDGE_SCHEMA_TABLE,
  KNOWLEDGE_SCHEMA_VERSION,
} from "../src/schema.ts";
import type { KnowledgeSchemaClient } from "../src/schema.ts";

const migrationSql = (id: string): string => {
  const migration = KNOWLEDGE_MIGRATIONS.find((entry) => entry.id === id);
  assert.ok(migration, `migration ${id} must exist`);
  return migration.sql;
};

test("migration registry is ordered, unique, and gates only the channel indexes", () => {
  const ids = KNOWLEDGE_MIGRATIONS.map((migration) => migration.id);
  assert.deepEqual(ids, [...ids].toSorted(), "migrations apply in id order");
  assert.equal(new Set(ids).size, ids.length, "ids are unique");

  const core = KNOWLEDGE_MIGRATIONS.slice(0, 4);
  for (const migration of core) {
    assert.equal(
      migration.requiresExtension,
      undefined,
      `${migration.id} must apply on a vanilla PostgreSQL 18`
    );
  }
  assert.equal(KNOWLEDGE_MIGRATIONS[4]?.requiresExtension, "vector");
  assert.equal(KNOWLEDGE_MIGRATIONS[5]?.requiresExtension, "pg_textsearch");
});

test("documents: stable identity is separate from content versions and tombstone", () => {
  const documents = migrationSql("0001-documents");
  assert.ok(
    documents.includes(
      "CONSTRAINT documents_identity UNIQUE (namespace, source, external_id)"
    ),
    "external/source identity must be the unique key, not content"
  );
  assert.ok(
    documents.includes("version      INTEGER NOT NULL DEFAULT 1"),
    "content changes bump a version column on the stable identity"
  );
  assert.ok(
    documents.includes("content_hash TEXT NOT NULL"),
    "current content hash enables the unchanged re-ingest short-circuit"
  );
  assert.ok(
    documents.includes("deleted_at   TIMESTAMPTZ,"),
    "tombstone column: NULL = live"
  );

  const versions = migrationSql("0002-document-versions");
  assert.ok(
    versions.includes(
      "CONSTRAINT document_versions_identity UNIQUE (document_id, version)"
    ),
    "one provenance row per document version"
  );
  assert.ok(
    versions.includes("REFERENCES documents (document_id) ON DELETE CASCADE"),
    "versions are garbage-collected with their document"
  );
});

test("chunks: content-addressed identity, version provenance, anchors, live window", () => {
  const chunks = migrationSql("0003-chunks");
  assert.ok(
    chunks.includes(
      "CONSTRAINT chunks_content_identity UNIQUE (document_id, content_hash)"
    ),
    "re-ingesting unchanged chunk text must touch nothing"
  );
  assert.ok(
    chunks.includes(
      "document_id     TEXT NOT NULL REFERENCES documents (document_id) ON DELETE CASCADE"
    ),
    "chunks cascade away with their document"
  );
  assert.ok(
    chunks.includes(
      "version_id      TEXT NOT NULL REFERENCES document_versions (version_id) ON DELETE CASCADE"
    ),
    "every chunk cites the exact document version that produced it"
  );
  assert.ok(
    chunks.includes("anchors         JSONB NOT NULL DEFAULT '[]'::jsonb"),
    "citation anchors are stored per chunk"
  );
  assert.ok(
    chunks.includes("idx             INTEGER NOT NULL"),
    "chunk position orders citation context"
  );
  assert.ok(
    chunks.includes("chunker_version TEXT NOT NULL"),
    "the chunking generation is recorded per chunk"
  );
  assert.ok(
    chunks.includes("valid_from      TIMESTAMPTZ NOT NULL DEFAULT now()") &&
      chunks.includes("valid_to        TIMESTAMPTZ,"),
    "validity window: valid_to IS NULL marks the live version's chunks"
  );
});

test("advanced index DDL is explicit in migrations", () => {
  assert.ok(
    migrationSql("0001-documents").includes(
      "CREATE INDEX documents_namespace_live\n  ON documents (namespace) WHERE deleted_at IS NULL"
    ),
    "namespace scoping is indexed for live documents"
  );
  assert.ok(
    migrationSql("0003-chunks").includes(
      "CREATE INDEX chunks_namespace_active\n  ON chunks (namespace) WHERE valid_to IS NULL"
    ),
    "the retrieval channels' namespace B-tree exists with the live predicate"
  );
  assert.ok(
    migrationSql("0004-ingest-jobs").includes(
      "CREATE INDEX ingest_jobs_claimable\n  ON ingest_jobs (priority DESC, enqueued_at) WHERE status = 'pending'"
    ),
    "the SKIP LOCKED claim path is a partial index over pending jobs"
  );

  const pgvector = migrationSql("0005-pgvector");
  assert.ok(
    pgvector.includes("ADD COLUMN IF NOT EXISTS embedding vector(384)"),
    "pgvector type and dimension are pinned explicitly"
  );
  assert.ok(
    pgvector.includes("ADD COLUMN IF NOT EXISTS embedding_model TEXT"),
    "the embedding model generation is stored per chunk"
  );
  assert.ok(
    pgvector.includes(
      "CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw\n  ON chunks USING hnsw (embedding vector_cosine_ops)\n  WHERE valid_to IS NULL AND embedding IS NOT NULL"
    ),
    "the HNSW index is partial over live, embedded chunks with the cosine opclass"
  );

  const bm25 = migrationSql("0006-pg-textsearch");
  assert.ok(
    bm25.includes(
      "CREATE INDEX IF NOT EXISTS chunks_text_bm25\n  ON chunks USING bm25 (text)\n  WITH (text_config = 'english')\n  WHERE valid_to IS NULL"
    ),
    "the BM25 index covers the searchable text expression over live chunks"
  );
});

test("checksumMigration is deterministic and content-sensitive", () => {
  const sql = migrationSql("0001-documents");
  assert.equal(checksumMigration(sql), checksumMigration(sql));
  assert.notEqual(checksumMigration(sql), checksumMigration(`${sql}\n`));
});

interface StubCall {
  params: unknown[];
  text: string;
}

const stubClient = (options: {
  failFor?: (text: string) => Error | null;
  rowsFor?: (text: string) => Record<string, unknown>[];
}): { calls: StubCall[]; client: KnowledgeSchemaClient } => {
  const calls: StubCall[] = [];
  const client: KnowledgeSchemaClient = {
    query: (text, params) => {
      calls.push({ params, text });
      const failure = options.failFor?.(text);
      if (failure !== undefined && failure !== null) {
        return Promise.reject(failure);
      }
      return Promise.resolve({ rows: options.rowsFor?.(text) ?? [] });
    },
  };
  return { calls, client };
};

test("ensureKnowledgeSchema applies core migrations, skips unavailable extensions", async () => {
  const { calls, client } = stubClient({});
  const result = await ensureKnowledgeSchema(client);

  assert.deepEqual(result.applied, [
    "0001-documents",
    "0002-document-versions",
    "0003-chunks",
    "0004-ingest-jobs",
  ]);
  assert.deepEqual(result.skipped, ["0005-pgvector", "0006-pg-textsearch"]);
  assert.equal(result.schemaVersion, KNOWLEDGE_SCHEMA_VERSION);

  assert.equal(calls.filter((call) => call.text === "BEGIN").length, 4);
  assert.equal(calls.filter((call) => call.text === "COMMIT").length, 4);
  assert.ok(
    !calls.some((call) => call.text === "ROLLBACK"),
    "no migration failed"
  );
  assert.equal(
    calls.filter((call) =>
      call.text.includes(`INSERT INTO "${KNOWLEDGE_SCHEMA_TABLE}"`)
    ).length,
    4,
    "every applied migration is recorded"
  );
  assert.ok(
    !calls.some((call) => call.text.includes("CREATE EXTENSION")),
    "extension-gated SQL must not run when the extension is unavailable"
  );
});

test("ensureKnowledgeSchema re-run is a no-op on a fully migrated cluster", async () => {
  const recorded = KNOWLEDGE_MIGRATIONS.map((migration) => ({
    checksum: checksumMigration(migration.sql),
    migration_id: migration.id,
  }));
  const { calls, client } = stubClient({
    rowsFor: (text) =>
      text.includes("SELECT migration_id, checksum") ? recorded : [],
  });
  const result = await ensureKnowledgeSchema(client);

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(
    calls.length,
    2,
    "only the bookkeeping table and the record read may run"
  );
});

test("ensureKnowledgeSchema refuses drifted migration definitions", async () => {
  const recorded = KNOWLEDGE_MIGRATIONS.map((migration) => ({
    checksum:
      migration.id === "0003-chunks"
        ? "deadbeef"
        : checksumMigration(migration.sql),
    migration_id: migration.id,
  }));
  const { client } = stubClient({
    rowsFor: (text) =>
      text.includes("SELECT migration_id, checksum") ? recorded : [],
  });
  await assert.rejects(
    () => ensureKnowledgeSchema(client),
    /0003-chunks drifted/u
  );
});

test("ensureKnowledgeSchema applies extension-gated migrations when available", async () => {
  const { calls, client } = stubClient({
    rowsFor: (text) =>
      text.includes("pg_available_extensions") ? [{ available: 1 }] : [],
  });
  const result = await ensureKnowledgeSchema(client);

  assert.deepEqual(
    result.applied,
    KNOWLEDGE_MIGRATIONS.map((migration) => migration.id)
  );
  assert.deepEqual(result.skipped, []);
  assert.ok(
    calls.some((call) =>
      call.text.includes("CREATE EXTENSION IF NOT EXISTS vector")
    )
  );
  assert.ok(
    calls.some((call) =>
      call.text.includes("CREATE EXTENSION IF NOT EXISTS pg_textsearch")
    )
  );
});

test("ensureKnowledgeSchema rolls back and rethrows a failed migration", async () => {
  const { calls, client } = stubClient({
    failFor: (text) =>
      text.includes("CREATE TABLE chunks") ? new Error("boom") : null,
  });
  await assert.rejects(() => ensureKnowledgeSchema(client), /boom/u);

  const rollbackAt = calls.findIndex((call) => call.text === "ROLLBACK");
  assert.ok(rollbackAt > 0, "a failed migration must issue ROLLBACK");
  assert.ok(
    calls[rollbackAt - 1]?.text.includes("CREATE TABLE chunks"),
    "the failing statement directly precedes ROLLBACK"
  );
  assert.equal(
    calls.filter((call) =>
      call.text.includes(`INSERT INTO "${KNOWLEDGE_SCHEMA_TABLE}"`)
    ).length,
    2,
    "only the migrations before the failure are recorded"
  );
});

// Live-DB integration: runs only when KNOWLEDGE_SCHEMA_TEST_URL points at a
// DISPOSABLE PostgreSQL 18 database (the test drops all knowledge tables to
// prove the from-empty migration). Otherwise skipped in CI/offline, like the
// BM25/pgvector integration tests. With a vanilla PostgreSQL 18 the
// extension-gated migrations must skip; the knowledge CNPG cluster applies
// them too and the index assertions light up accordingly.
const SCHEMA_TEST_URL = process.env["KNOWLEDGE_SCHEMA_TEST_URL"];

const withSchemaClient = async <T>(
  fn: (client: KnowledgeSchemaClient) => Promise<T>
): Promise<T> => {
  const connectionString = SCHEMA_TEST_URL;
  if (!connectionString) {
    throw new Error(
      "schema: KNOWLEDGE_SCHEMA_TEST_URL is not set (integration path needs a disposable PostgreSQL 18)"
    );
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
};

test(
  "integration: migrate an empty PostgreSQL 18 and exercise insert/update/delete invariants",
  { skip: !SCHEMA_TEST_URL },
  async () => {
    await withSchemaClient(async (client) => {
      // From-empty: drop every knowledge object (including any pre-#56
      // ad-hoc state), then migrate fresh.
      await client.query(
        `DROP TABLE IF EXISTS chunks, document_versions, documents, ingest_jobs, "${KNOWLEDGE_SCHEMA_TABLE}" CASCADE`,
        []
      );
      const extensionRows = await client.query(
        "SELECT name FROM pg_available_extensions",
        []
      );
      const available = new Set(
        extensionRows.rows.map((row) => String(row["name"]))
      );
      const gatedBy: [string, string][] = [
        ["0005-pgvector", "vector"],
        ["0006-pg-textsearch", "pg_textsearch"],
      ];

      const first = await ensureKnowledgeSchema(client);
      assert.deepEqual(first.applied, [
        "0001-documents",
        "0002-document-versions",
        "0003-chunks",
        "0004-ingest-jobs",
        ...gatedBy
          .filter(([, extension]) => available.has(extension))
          .map(([id]) => id),
      ]);
      assert.deepEqual(
        first.skipped,
        gatedBy
          .filter(([, extension]) => !available.has(extension))
          .map(([id]) => id)
      );
      assert.equal(first.schemaVersion, KNOWLEDGE_SCHEMA_VERSION);

      const second = await ensureKnowledgeSchema(client);
      assert.deepEqual(second.applied, [], "re-migration is a no-op");
      assert.deepEqual(second.skipped, first.skipped);

      // Advanced index DDL actually landed (pg_indexes is ground truth).
      const indexes = await client.query(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
        []
      );
      const defs = new Map(
        indexes.rows.map((row) => [
          String(row["indexname"]),
          String(row["indexdef"]),
        ])
      );
      const expectIndex = (name: string, fragments: string[]): void => {
        const def = defs.get(name);
        assert.ok(def !== undefined, `index ${name} must exist`);
        for (const fragment of fragments) {
          assert.ok(
            def.includes(fragment),
            `indexdef of ${name} must include ${JSON.stringify(fragment)}: ${def}`
          );
        }
      };
      expectIndex("documents_identity", ["UNIQUE", "namespace", "external_id"]);
      expectIndex("documents_namespace_live", [
        "namespace",
        "deleted_at IS NULL",
      ]);
      expectIndex("document_versions_identity", [
        "UNIQUE",
        "document_id",
        "version",
      ]);
      expectIndex("chunks_content_identity", [
        "UNIQUE",
        "document_id",
        "content_hash",
      ]);
      expectIndex("chunks_namespace_active", ["namespace", "valid_to IS NULL"]);
      expectIndex("ingest_jobs_claimable", [
        "priority",
        "enqueued_at",
        "status",
      ]);
      if (available.has("vector")) {
        expectIndex("chunks_embedding_hnsw", [
          "USING hnsw",
          "vector_cosine_ops",
          "valid_to IS NULL",
          "embedding IS NOT NULL",
        ]);
      }
      if (available.has("pg_textsearch")) {
        expectIndex("chunks_text_bm25", [
          "USING bm25",
          "text_config",
          "valid_to IS NULL",
        ]);
      }

      // --- Insert: stable identity + version row + anchored chunks -------
      const anchors = [
        { end: 21, start: 0, type: "offset" },
        { type: "heading", value: "Setup" },
      ];
      await client.query("BEGIN", []);
      await client.query(
        `INSERT INTO documents
  (document_id, namespace, source, external_id, title, url, version, content_hash)
VALUES ('inv-doc', $1, 'file', 'docs/setup.md', 'Setup guide',
        'https://homelab.internal/docs/setup.md', 1, 'hash-v1')`,
        ["schema-test"]
      );
      await client.query(
        `INSERT INTO document_versions (version_id, document_id, version, content_hash)
VALUES ('inv-doc#v1', 'inv-doc', 1, 'hash-v1')`,
        []
      );
      await client.query(
        `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, idx, text, content_hash, anchors, chunker_version)
VALUES ('inv-c1', 'inv-doc', 'inv-doc#v1', $1, 0, 'first chunk text', 'hash-c1', $2::jsonb, 'fixture-v1'),
       ('inv-c2', 'inv-doc', 'inv-doc#v1', $1, 1, 'second chunk text', 'hash-c2', '[]'::jsonb, 'fixture-v1')`,
        ["schema-test", JSON.stringify(anchors)]
      );
      await client.query("COMMIT", []);

      const liveCitationIds = async (): Promise<unknown[]> => {
        const result = await client.query(
          `SELECT c.chunk_id, c.idx, c.version_id, v.version, c.anchors
FROM chunks c
JOIN documents d ON d.document_id = c.document_id
JOIN document_versions v ON v.version_id = c.version_id
WHERE c.namespace = $1 AND c.valid_to IS NULL AND d.deleted_at IS NULL
ORDER BY c.idx`,
          ["schema-test"]
        );
        return result.rows.map((row) => row["chunk_id"]);
      };
      assert.deepEqual(await liveCitationIds(), ["inv-c1", "inv-c2"]);
      const anchored = await client.query(
        "SELECT anchors FROM chunks WHERE chunk_id = 'inv-c1'",
        []
      );
      assert.deepEqual(
        parseAnchors(anchored.rows[0]?.anchors, "test"),
        anchors,
        "stored anchors round-trip into the citation-anchor contract"
      );

      // --- Idempotency: unchanged content touches nothing ----------------
      const documentBefore = await client.query(
        "SELECT updated_at FROM documents WHERE document_id = 'inv-doc'",
        []
      );
      const chunkBefore = await client.query(
        "SELECT created_at FROM chunks WHERE chunk_id = 'inv-c1'",
        []
      );
      await client.query(
        `INSERT INTO documents
  (document_id, namespace, source, external_id, title, url, version, content_hash)
VALUES ('inv-doc', $1, 'file', 'docs/setup.md', 'Setup guide',
        'https://homelab.internal/docs/setup.md', 1, 'hash-v1')
ON CONFLICT (namespace, source, external_id) DO NOTHING`,
        ["schema-test"]
      );
      await client.query(
        `INSERT INTO document_versions (version_id, document_id, version, content_hash)
VALUES ('inv-doc#v1', 'inv-doc', 1, 'hash-v1')
ON CONFLICT (document_id, version) DO NOTHING`,
        []
      );
      await client.query(
        `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, idx, text, content_hash, anchors, chunker_version)
VALUES ('inv-c1', 'inv-doc', 'inv-doc#v1', $1, 0, 'first chunk text', 'hash-c1', $2::jsonb, 'fixture-v1')
ON CONFLICT (document_id, content_hash) DO NOTHING`,
        ["schema-test", JSON.stringify(anchors)]
      );
      const documentAfter = await client.query(
        "SELECT updated_at FROM documents WHERE document_id = 'inv-doc'",
        []
      );
      assert.equal(
        documentAfter.rows[0]?.updated_at,
        documentBefore.rows[0]?.updated_at,
        "unchanged re-ingest must not touch the document"
      );
      const chunkAfter = await client.query(
        "SELECT created_at FROM chunks WHERE chunk_id = 'inv-c1'",
        []
      );
      assert.equal(
        chunkAfter.rows[0]?.created_at,
        chunkBefore.rows[0]?.created_at,
        "unchanged re-ingest must reuse the chunk row (no re-embed churn)"
      );
      const counts = await client.query(
        `SELECT (SELECT count(*) FROM documents) AS documents,
       (SELECT count(*) FROM document_versions) AS versions,
       (SELECT count(*) FROM chunks WHERE namespace = $1) AS chunks`,
        ["schema-test"]
      );
      assert.equal(Number(counts.rows[0]?.documents), 1);
      assert.equal(Number(counts.rows[0]?.versions), 1);
      assert.equal(Number(counts.rows[0]?.chunks), 2);

      // --- Update: version bump keeps provenance, supersession prunes ----
      const c1CreatedBefore = chunkAfter.rows[0]?.created_at;
      await client.query("BEGIN", []);
      await client.query(
        `INSERT INTO document_versions (version_id, document_id, version, content_hash)
VALUES ('inv-doc#v2', 'inv-doc', 2, 'hash-v2')`,
        []
      );
      await client.query(
        "UPDATE documents SET version = 2, content_hash = 'hash-v2', updated_at = now() WHERE document_id = 'inv-doc'",
        []
      );
      // Unchanged chunk text: content-addressed carry-forward, one row.
      await client.query(
        `INSERT INTO chunks
  (chunk_id, document_id, version_id, namespace, idx, text, content_hash, anchors, chunker_version)
VALUES ('inv-c1', 'inv-doc', 'inv-doc#v2', $1, 0, 'first chunk text', 'hash-c1', $2::jsonb, 'fixture-v1')
ON CONFLICT (document_id, content_hash) DO UPDATE
SET version_id = EXCLUDED.version_id,
    idx = EXCLUDED.idx,
    anchors = EXCLUDED.anchors,
    valid_from = now(),
    valid_to = NULL`,
        ["schema-test", JSON.stringify(anchors)]
      );
      // Chunk absent from v2: superseded, invisible to retrieval immediately.
      await client.query(
        `UPDATE chunks SET valid_to = now()
WHERE document_id = 'inv-doc' AND content_hash = 'hash-c2' AND valid_to IS NULL`,
        []
      );
      await client.query("COMMIT", []);

      assert.deepEqual(await liveCitationIds(), ["inv-c1"]);
      const live = await client.query(
        `SELECT c.version_id, v.version
FROM chunks c
JOIN document_versions v ON v.version_id = c.version_id
WHERE c.chunk_id = 'inv-c1'`,
        []
      );
      assert.equal(live.rows[0]?.version_id, "inv-doc#v2");
      assert.equal(live.rows[0]?.version, 2);
      const versionHistory = await client.query(
        `SELECT version_id, content_hash FROM document_versions
WHERE document_id = 'inv-doc' ORDER BY version`,
        []
      );
      assert.deepEqual(
        versionHistory.rows.map((row) => row["version_id"]),
        ["inv-doc#v1", "inv-doc#v2"],
        "every version stays resolvable for provenance"
      );
      assert.equal(versionHistory.rows[0]?.content_hash, "hash-v1");
      const c1Rows = await client.query(
        `SELECT count(*)::int AS n, min(created_at) AS created
FROM chunks WHERE document_id = 'inv-doc' AND content_hash = 'hash-c1'`,
        []
      );
      assert.equal(
        c1Rows.rows[0]?.n,
        1,
        "carry-forward must not duplicate the chunk"
      );
      assert.equal(
        c1Rows.rows[0]?.created,
        c1CreatedBefore,
        "carry-forward reuses the row (embedding survives a re-chunk)"
      );

      // --- Tombstone: retrieval hides immediately, rows wait for GC ------
      await client.query(
        "UPDATE documents SET deleted_at = now() WHERE document_id = 'inv-doc'",
        []
      );
      assert.deepEqual(
        await liveCitationIds(),
        [],
        "tombstone hides every chunk from retrieval immediately"
      );
      const kept = await client.query(
        `SELECT count(*)::int AS n FROM chunks
WHERE document_id = 'inv-doc' AND valid_to IS NULL`,
        []
      );
      assert.equal(kept.rows[0]?.n, 1, "rows stay for GC on a separate clock");
      await client.query(
        "UPDATE documents SET deleted_at = NULL WHERE document_id = 'inv-doc'",
        []
      );
      assert.deepEqual(
        await liveCitationIds(),
        ["inv-c1"],
        "re-ingesting a tombstoned identity restores retrieval"
      );

      // --- Hard delete: cascades wipe chunks + versions ------------------
      await client.query(
        "DELETE FROM documents WHERE document_id = 'inv-doc'",
        []
      );
      const leftovers = await client.query(
        `SELECT (SELECT count(*)::int FROM chunks WHERE document_id = 'inv-doc') AS chunks,
       (SELECT count(*)::int FROM document_versions WHERE document_id = 'inv-doc') AS versions`,
        []
      );
      assert.deepEqual(
        leftovers.rows[0],
        { chunks: 0, versions: 0 },
        "hard delete cascades chunks and version history"
      );

      // --- Ingest jobs: claim lifecycle + status constraint --------------
      const job = await client.query(
        `INSERT INTO ingest_jobs (kind, payload, priority)
VALUES ('ingest', $1::jsonb, 5) RETURNING job_id, status`,
        [JSON.stringify({ external_id: "docs/setup.md" })]
      );
      const jobId = job.rows[0]?.job_id;
      assert.equal(job.rows[0]?.status, "pending");
      const claimed = await client.query(
        `UPDATE ingest_jobs
SET status = 'running', started_at = now(), heartbeat_at = now(), attempts = attempts + 1
WHERE job_id = $1 AND status = 'pending' RETURNING job_id`,
        [jobId]
      );
      assert.equal(
        claimed.rows.length,
        1,
        "the claim flips exactly one pending job"
      );
      await client.query(
        "UPDATE ingest_jobs SET status = 'done', finished_at = now() WHERE job_id = $1",
        [jobId]
      );
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO ingest_jobs (kind, payload, status)
VALUES ('ingest', '{}'::jsonb, 'queued')`,
            []
          ),
        /ingest_jobs_status_check/u,
        "job status is constrained to the known lifecycle"
      );
    });
  }
);
