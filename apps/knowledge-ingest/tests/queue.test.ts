import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLAIM_SQL,
  COMPLETE_SQL,
  DOCUMENT_TABLE,
  ENQUEUE_JOB_SQL,
  FAIL_SQL,
  HEARTBEAT_SQL,
  INGEST_SCHEMA_SQL,
  INGEST_SCHEMA_VERSION,
  JOB_STATES,
  PUBLISH_DOCUMENT_SQL,
  RECOVER_STALE_SQL,
  SOURCE_UPSERT_SQL,
  documentIdFor,
  deriveIngestIdempotencyKey,
  newJobId,
  retryDelaySeconds,
} from "../server/queue.ts";
import { makeIngestInput } from "./helpers.ts";

test("schema version is pinned and exported for run provenance", () => {
  assert.equal(INGEST_SCHEMA_VERSION, "1-ingest-queue");
});

test("claim uses FOR UPDATE SKIP LOCKED with the claimable partial-index predicate", () => {
  assert.match(CLAIM_SQL, /FOR UPDATE SKIP LOCKED/u);
  assert.match(CLAIM_SQL, /WHERE status IN \('pending', 'retryable'\)/u);
  assert.match(CLAIM_SQL, /AND available_at <= now\(\)/u);
  assert.match(CLAIM_SQL, /LIMIT \$2/u);
  // The claim flips state and stamps the lease atomically in one statement.
  assert.match(CLAIM_SQL, /status = 'running'/u);
  assert.match(CLAIM_SQL, /attempts = attempts \+ 1/u);
  assert.match(CLAIM_SQL, /heartbeat_at = now\(\)/u);
  assert.match(CLAIM_SQL, /ORDER BY priority DESC, enqueued_at ASC, id ASC/u);
});

test("recovery resets expired leases and dead-letters exhausted jobs", () => {
  assert.match(
    RECOVER_STALE_SQL,
    /CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END/u
  );
  assert.match(
    RECOVER_STALE_SQL,
    /WHERE status = 'running' AND heartbeat_at < now\(\) - make_interval\(secs => \$1\)/u
  );
});

test("complete and fail are guarded on claim ownership", () => {
  assert.match(
    COMPLETE_SQL,
    /WHERE id = \$1 AND worker_id = \$3 AND status = 'running'/u
  );
  assert.match(
    FAIL_SQL,
    /WHERE id = \$1 AND worker_id = \$4 AND status = 'running'/u
  );
  assert.match(
    FAIL_SQL,
    /CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'retryable' END/u
  );
  assert.match(FAIL_SQL, /now\(\) \+ make_interval\(secs => \$3\)/u);
});

test("heartbeat renews only the worker's own running claims", () => {
  assert.match(
    HEARTBEAT_SQL,
    /WHERE id = ANY\(\$1::text\[\]\) AND worker_id = \$2 AND status = 'running'/u
  );
});

test("enqueue collides on the idempotency key and returns the existing job", () => {
  assert.match(ENQUEUE_JOB_SQL, /ON CONFLICT \(idempotency_key\) DO NOTHING/u);
  assert.match(ENQUEUE_JOB_SQL, /WHERE j\.idempotency_key = \$3/u);
  assert.match(ENQUEUE_JOB_SQL, /TRUE AS duplicate/u);
  assert.match(ENQUEUE_JOB_SQL, /FALSE AS duplicate/u);
});

test("schema DDL covers queue, source registry, and version-unique documents", () => {
  assert.match(INGEST_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS ingest_job/u);
  assert.match(INGEST_SCHEMA_SQL, /idempotency_key TEXT NOT NULL UNIQUE/u);
  assert.match(
    INGEST_SCHEMA_SQL,
    /CHECK \(status IN \('pending', 'running', 'succeeded', 'retryable', 'dead'\)\)/u
  );
  assert.match(
    INGEST_SCHEMA_SQL,
    /CREATE INDEX IF NOT EXISTS ingest_job_claimable[\s\S]*WHERE status IN \('pending', 'retryable'\)/u
  );
  assert.match(INGEST_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS ingest_source/u);
  assert.match(
    INGEST_SCHEMA_SQL,
    new RegExp(`CREATE TABLE IF NOT EXISTS ${DOCUMENT_TABLE}`, "u")
  );
  assert.match(
    INGEST_SCHEMA_SQL,
    /UNIQUE \(namespace, source_id, external_id, version_id\)/u
  );
});

test("publish is a no-op on the version identity", () => {
  assert.match(
    PUBLISH_DOCUMENT_SQL,
    /ON CONFLICT \(namespace, source_id, external_id, version_id\) DO NOTHING/u
  );
});

test("source upsert refreshes registration in place", () => {
  assert.match(SOURCE_UPSERT_SQL, /ON CONFLICT \(source_id\) DO UPDATE SET/u);
  assert.match(ENQUEUE_JOB_SQL, /\$6::jsonb/u);
});

test("job ids and document ids are well-shaped", () => {
  const jobId = newJobId();
  assert.match(jobId, /^job_[0-9a-f-]{36}$/u);
  const docId = documentIdFor("ns", "src", "ext", "v1");
  assert.match(docId, /^doc_[0-9a-f]{40}$/u);
  assert.equal(
    docId,
    documentIdFor("ns", "src", "ext", "v1"),
    "same version identity → same document id"
  );
  assert.notEqual(
    documentIdFor("ns", "src", "ext", "v1"),
    documentIdFor("ns", "src", "ext", "v2")
  );
});

test("the default idempotency key covers the full source event identity", () => {
  const key = deriveIngestIdempotencyKey(makeIngestInput());
  assert.match(key, /^docevt_[0-9a-f]{64}$/u);
  assert.equal(
    deriveIngestIdempotencyKey(makeIngestInput()),
    key,
    "identical events derive identical keys"
  );
  assert.notEqual(
    deriveIngestIdempotencyKey(
      makeIngestInput({ version: { commit: "abc123", versionId: "v2" } })
    ),
    key,
    "a new version is a new event"
  );
  assert.notEqual(
    deriveIngestIdempotencyKey(
      makeIngestInput({ contentHash: "b".repeat(64) })
    ),
    key,
    "changed content is a new event"
  );
  assert.notEqual(
    deriveIngestIdempotencyKey(
      makeIngestInput({
        source: {
          kind: "url",
          path: null,
          ref: null,
          repo: null,
          sourceId: "other",
          url: null,
        },
      })
    ),
    key,
    "a different source is a new event"
  );
  // A client key takes precedence over the derived one.
  assert.equal(
    deriveIngestIdempotencyKey(
      makeIngestInput({ idempotencyKey: "client-key-1" })
    ),
    key,
    "derivation ignores the explicit key field"
  );
});

test("retry backoff doubles from the base and caps at the max", () => {
  const base = 1000;
  const max = 60_000;
  assert.equal(retryDelaySeconds(1, base, max), 1);
  assert.equal(retryDelaySeconds(2, base, max), 2);
  assert.equal(retryDelaySeconds(3, base, max), 4);
  assert.equal(retryDelaySeconds(10, base, max), 60, "capped at max");
  assert.equal(retryDelaySeconds(0, base, max), 1, "attempts floor at 1");
});

test("job states cover the full state machine", () => {
  assert.deepEqual(
    [...JOB_STATES],
    ["pending", "running", "succeeded", "retryable", "dead"]
  );
});
