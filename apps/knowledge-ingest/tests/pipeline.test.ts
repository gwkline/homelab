import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  GitSourceConfig,
  GitSourceDocument,
  GitSourceStore,
  GitSyncReport,
} from "../../knowledge/src/git-source.ts";
import { buildIngestJob } from "../../knowledge/src/git-source.ts";
import { createMemoryManifestStore } from "../server/git-sync.ts";
import { createMemoryIngestStore } from "../server/memory-store.ts";
import type {
  PipelineDocument,
  PipelineSink,
} from "../server/pipeline-worker.ts";
import {
  createPipelineHandler,
  parseDocumentVersionPayload,
  sha256Hex,
} from "../server/pipeline-worker.ts";
import type { IngestRequestInput, IngestStore } from "../server/store.ts";
import { runWorkerCycle } from "../server/worker.ts";
import type { WorkerDeps } from "../server/worker.ts";
import { makeIngestInput, makeWorkerConfig, noopLogger } from "./helpers.ts";

/** Recording sink: what the pipeline would persist, without a database. */
const fakeSink = (
  chunks = 3
): PipelineSink & { calls: PipelineDocument[]; tombstoned: string[] } => {
  const calls: PipelineDocument[] = [];
  const tombstoned: string[] = [];
  return {
    calls,
    processDocumentVersion: (doc) => {
      calls.push(doc);
      return Promise.resolve({ chunks, status: "ok" });
    },
    tombstoneDocument: (documentId) => {
      tombstoned.push(documentId);
      return Promise.resolve();
    },
    tombstoned,
  };
};

interface Rig {
  deps: (overrides?: {
    fetchImpl?: typeof fetch;
    gitSync?: (
      store: GitSourceStore,
      config: GitSourceConfig
    ) => Promise<GitSyncReport>;
  }) => WorkerDeps;
  manifests: ReturnType<typeof createMemoryManifestStore>;
  sink: PipelineSink & { calls: PipelineDocument[]; tombstoned: string[] };
  store: IngestStore;
}

const rig = (chunks = 3): Rig => {
  const store = createMemoryIngestStore({ maxAttempts: 2 });
  const manifests = createMemoryManifestStore();
  const sink = fakeSink(chunks);
  const deps = (
    overrides: {
      fetchImpl?: typeof fetch;
      gitSync?: (
        store: GitSourceStore,
        config: GitSourceConfig
      ) => Promise<GitSyncReport>;
    } = {}
  ): WorkerDeps => ({
    config: makeWorkerConfig(),
    handler: createPipelineHandler({
      ...(overrides.fetchImpl === undefined
        ? {}
        : { fetchImpl: overrides.fetchImpl }),
      ...(overrides.gitSync === undefined
        ? {}
        : { gitSync: overrides.gitSync }),
      logger: noopLogger,
      manifests,
      sink,
      store,
    }),
    logger: noopLogger,
    store,
  });
  return { deps, manifests, sink, store };
};

const versionPayload = (overrides: Record<string, unknown> = {}) => ({
  content: "# Runbook\n\nRestart the node.",
  documentId: "0a1b2c3d-e00f-4a5b-8c9d-0e1f2a3b4c5d",
  externalId: "docs/runbook.md",
  format: "markdown",
  namespace: "homelab-docs",
  provenance: { commitSha: "abc123", ref: "main" },
  source: "git",
  title: "runbook.md",
  url: "https://github.com/gwkline/homelab/blob/abc123/docs/runbook.md",
  versionId: "0a1b2c3d-e00f-4a5b-8c9d-0e1f2a3b4c5d-v1",
  ...overrides,
});

const fakeReport = (overrides: Partial<GitSyncReport> = {}): GitSyncReport => ({
  added: 1,
  commitSha: "abc123",
  deleted: 0,
  excluded: 0,
  modified: 0,
  ops: [],
  renamed: 0,
  scanned: 1,
  skippedBinary: 0,
  skippedEmpty: 0,
  skippedSecret: 0,
  skippedTooLarge: 0,
  sourceKey: "git-abc",
  unchanged: 0,
  ...overrides,
});

const urlIngestInput = (
  overrides: Partial<IngestRequestInput> = {}
): IngestRequestInput => ({
  contentHash: "a".repeat(64),
  externalId: "notes/ops.md",
  idempotencyKey: null,
  namespace: "ops",
  provenance: { ingestedAt: "2026-10-01T00:00:00Z", ingestionEventId: null },
  source: {
    kind: "url",
    path: "notes/ops.md",
    ref: null,
    repo: null,
    sourceId: "ops-mirror",
    url: "https://docs.example/ops.md",
  },
  tags: [],
  title: null,
  version: { commit: null, versionId: "v1" },
  ...overrides,
});

test("document-version jobs run chunk → embed → upsert and publish the ledger", async () => {
  const { deps, sink, store } = rig(4);
  const { job } = await store.enqueueDocumentVersion(
    versionPayload(),
    "homelab-docs"
  );
  const cycle = await runWorkerCycle(deps());
  assert.equal(cycle.completed, 1);
  const done = await store.getJob(job.jobId);
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.documentsIngested, 1);
  assert.equal(done?.chunksIngested, 4, "chunk count comes from the sink");
  assert.equal(sink.calls.length, 1);
  assert.equal(sink.calls[0]?.content, "# Runbook\n\nRestart the node.");
  assert.equal(sink.calls[0]?.format, "markdown");
  assert.equal(sink.calls[0]?.source, "git");
  // The ledger records the version (citation commit + event id provenance).
  const sources = await store.listSources();
  assert.equal(sources[0]?.documentCount, 1);
  assert.equal(sources[0]?.chunkCount, 4);
});

test("document-version enqueue is idempotent on the version identity", async () => {
  const { store } = rig();
  const first = await store.enqueueDocumentVersion(
    versionPayload(),
    "homelab-docs"
  );
  assert.equal(first.duplicate, false);
  const again = await store.enqueueDocumentVersion(
    versionPayload(),
    "homelab-docs"
  );
  assert.equal(again.duplicate, true);
  assert.equal(again.job.jobId, first.job.jobId);
  // Changed content is a new event.
  const changed = await store.enqueueDocumentVersion(
    versionPayload({ content: "# Runbook\n\nDifferent." }),
    "homelab-docs"
  );
  assert.equal(changed.duplicate, false);
  assert.notEqual(changed.job.jobId, first.job.jobId);
});

test("malformed document-version payloads fail loudly, never ingest", async () => {
  const { deps, sink, store } = rig();
  await store.enqueueDocumentVersion(
    versionPayload({ content: "" }),
    "homelab-docs"
  );
  const cycle = await runWorkerCycle(deps());
  assert.equal(cycle.failed, 1);
  assert.equal(sink.calls.length, 0, "the sink was never called");
  const [source] = await store.listSources();
  assert.equal(source?.documentCount, 0);
});

test("parseDocumentVersionPayload accepts the git-source bridge shape", () => {
  const document = {
    blobHash: "a".repeat(40),
    commitSha: "abc123",
    contentHash: "b".repeat(64),
    contentKind: "code",
    documentId: "0a1b2c3d-e00f-4a5b-8c9d-0e1f2a3b4c5d",
    externalId: "src/main.ts",
    firstCommitSha: "abc123",
    language: "ts",
    lineRange: { end: 3, start: 1 },
    namespace: "homelab-docs",
    path: "src/main.ts",
    previousBlobHash: null,
    previousContentHash: null,
    ref: "main",
    renamedFrom: null,
    repositoryUrl: "https://github.com/gwkline/homelab",
    source: "git",
    text: "const x = 1;\nconst y = 2;\n",
    title: "main.ts",
    url: "https://github.com/gwkline/homelab/blob/abc123/src/main.ts",
    version: 1,
  } as GitSourceDocument;
  const bridge = buildIngestJob(document);
  const parsed = parseDocumentVersionPayload(bridge.payload, "job-x");
  assert.equal(parsed.content, document.text);
  assert.equal(parsed.format, "code");
  assert.equal(parsed.source, "git");
  assert.equal(parsed.provenance?.["commitSha"], "abc123");
});

test("url document jobs fetch, verify the content hash, and ingest", async () => {
  const { deps, sink, store } = rig(2);
  const text = "# Notes\n\nSome ops notes.";
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(new Response(text, { status: 200 }));

  const { job } = await store.enqueueIngest(
    urlIngestInput({ contentHash: sha256Hex(text) })
  );
  const cycle = await runWorkerCycle(deps({ fetchImpl }));
  assert.equal(cycle.completed, 1);
  assert.equal(sink.calls[0]?.content, text);
  assert.equal(sink.calls[0]?.format, "markdown", "format derived from path");
  assert.equal(sink.calls[0]?.source, "url");
  const done = await store.getJob(job.jobId);
  assert.equal(done?.chunksIngested, 2);
});

const fetchStaleText: typeof fetch = () =>
  Promise.resolve(
    new Response("# Notes\n\nNewer content upstream.", { status: 200 })
  );

test("a stale url event (hash mismatch) fails the job instead of ingesting", async () => {
  const { deps, sink, store } = rig();
  const { job } = await store.enqueueIngest(urlIngestInput());
  const cycle = await runWorkerCycle(deps({ fetchImpl: fetchStaleText }));
  assert.equal(cycle.failed, 1);
  assert.equal(sink.calls.length, 0);
  const failed = await store.getJob(job.jobId);
  assert.equal(failed?.status, "retryable");
  assert.match(failed?.error ?? "", /content hash mismatch/u);
});

const fetchUnavailable: typeof fetch = () =>
  Promise.resolve(new Response("nope", { status: 503 }));

test("fetch failures are job failures, not silent skips", async () => {
  const { deps, sink, store } = rig();
  await store.enqueueIngest(urlIngestInput());
  const cycle = await runWorkerCycle(deps({ fetchImpl: fetchUnavailable }));
  assert.equal(cycle.failed, 1);
  assert.equal(sink.calls.length, 0);
});

test("file sources are rejected with a routing hint", async () => {
  const { deps, sink, store } = rig();
  await store.enqueueIngest(
    urlIngestInput({
      source: {
        kind: "file",
        path: "notes/local.md",
        ref: null,
        repo: null,
        sourceId: "local",
        url: null,
      },
    })
  );
  const cycle = await runWorkerCycle(deps());
  assert.equal(cycle.failed, 1);
  assert.equal(sink.calls.length, 0);
});

const gitDocument = (path: string): GitSourceDocument => ({
  blobHash: "a".repeat(40),
  commitSha: "abc123",
  contentHash: "b".repeat(64),
  contentKind: "markdown",
  documentId: `id-${path.replaceAll("/", "-")}`,
  externalId: path,
  firstCommitSha: "abc123",
  language: "markdown",
  lineRange: { end: 2, start: 1 },
  namespace: "homelab-docs",
  path,
  previousBlobHash: null,
  previousContentHash: null,
  ref: "main",
  renamedFrom: null,
  repositoryUrl: "https://github.com/gwkline/homelab",
  source: "git",
  text: "# Doc\n\nbody",
  title: path.split("/").pop() ?? path,
  url: `https://github.com/gwkline/homelab/blob/abc123/${path}`,
  version: 1,
});

test("github source_sync enqueues document-version jobs and tombstones deletions", async () => {
  const { deps, manifests, sink, store } = rig();
  // Register the github source (an ingest event does that), then sync it.
  await store.enqueueIngest(
    makeIngestInput({
      contentHash: "a".repeat(64),
      idempotencyKey: null,
    })
  );
  const { job } = await store.enqueueSourceSync("homelab-docs");

  const gitSync = async (
    gitSourceStore: GitSourceStore,
    _config: GitSourceConfig
  ): Promise<GitSyncReport> => {
    // Simulate the real sync: one upsert, one tombstone, one manifest save.
    await gitSourceStore.upsertDocument(gitDocument("docs/runbook.md"));
    await gitSourceStore.tombstoneDocument({
      blobHash: "c".repeat(40),
      contentHash: "d".repeat(64),
      documentId: "id-old",
      externalId: "docs/old.md",
      namespace: "homelab-docs",
      renamedTo: null,
      tombstoneCommitSha: "abc123",
      version: 1,
    });
    await gitSourceStore.saveManifest({
      commitSha: "abc123",
      entries: {},
      sourceKey: "git-abc",
    });
    return fakeReport({ added: 1, deleted: 1 });
  };

  const cycle = await runWorkerCycle(deps({ gitSync }));
  assert.equal(cycle.completed, 1);
  const syncDone = await store.getJob(job.jobId);
  assert.equal(syncDone?.documentsIngested, 1, "added + modified + renamed");
  assert.equal(syncDone?.chunksIngested, 0, "chunks land with the child jobs");
  assert.deepEqual(sink.tombstoned, ["id-old"]);
  assert.equal(
    manifests.manifests.get("git-abc")?.commitSha,
    "abc123",
    "the manifest was persisted via the injected store"
  );

  // The enqueued child job is claimable as a document-version job.
  const [child] = await store.claim({ limit: 5, workerId: "child-worker" });
  assert.ok(child);
  assert.equal(child.kind, "document-version");
  assert.equal(child.payload.kind, "document-version");

  // A second sync with the same content dedupes the enqueue (no new job).
  const gitSyncAgain = async (
    gitSourceStore: GitSourceStore
  ): Promise<GitSyncReport> => {
    await gitSourceStore.upsertDocument(gitDocument("docs/runbook.md"));
    return fakeReport({ added: 0, unchanged: 1 });
  };
  await store.complete("child-worker", child.jobId, {
    chunksIngested: 1,
    documentsIngested: 1,
  });
  const { job: sync2 } = await store.enqueueSourceSync("homelab-docs");
  const second = await runWorkerCycle(deps({ gitSync: gitSyncAgain }));
  assert.equal(second.completed, 1);
  const sync2Done = await store.getJob(sync2.jobId);
  assert.equal(sync2Done?.documentsIngested, 0, "unchanged blobs dedupe");
});

test("non-git source_sync is a clean no-op in phase one", async () => {
  const { deps, sink, store } = rig();
  await store.enqueueIngest(urlIngestInput());
  const { job } = await store.enqueueSourceSync("ops-mirror");
  const cycle = await runWorkerCycle(deps());
  assert.equal(cycle.completed, 1);
  const done = await store.getJob(job.jobId);
  assert.equal(done?.documentsIngested, 0);
  assert.equal(done?.chunksIngested, 0);
  assert.equal(sink.calls.length, 0, "no crawler ran");
});
