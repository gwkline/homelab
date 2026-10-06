/**
 * git-source sync adapter for `source_sync` jobs with `github` sources: runs
 * `syncGitSource` against a `GitSourceStore` whose pieces land in the right
 * places —
 *
 * - `upsertDocument` → one `document-version` job on this queue (the bridge
 *   payload from `apps/knowledge/src/git-source.ts` `buildIngestJob`), so
 *   chunking/embedding/persistence run as their own durable, retryable jobs;
 *   enqueue is idempotent on the version identity, so a retried sync never
 *   double-enqueues;
 * - `tombstoneDocument` → the #56 document model via the pipeline sink
 *   (`buildDocumentTombstone` + `buildChunkSupersede` underneath), so deleted
 *   and moved paths stop serving immediately;
 * - `loadManifest`/`saveManifest` → the durable per-source manifest
 *   (`git_source_manifest` in Postgres, in-memory in dev), so incremental
 *   syncs read only changed blobs.
 *
 * The repository handle is opened by the caller's `gitSync` (default: the real
 * clone/fetch sync `syncGitRepository`); tests inject a fixture sync.
 */

import {
  buildIngestJob,
  syncGitRepository,
} from "../../knowledge/src/git-source.ts";
import type {
  GitSourceConfig,
  GitSourceDocument,
  GitSourceManifest,
  GitSourceStore,
  GitSyncReport,
  GitTombstone,
} from "../../knowledge/src/git-source.ts";
import type { PipelineSink } from "./pipeline-worker.ts";
import type { DocumentVersionPayload, IngestStore } from "./store.ts";

export interface GitSyncDeps {
  config: Pick<GitSourceConfig, "namespace" | "ref"> & {
    repositoryUrl: string | null;
  };
  /** Injectable sync for tests; default opens the repo and syncs for real. */
  gitSync?: (
    store: GitSourceStore,
    config: GitSourceConfig
  ) => Promise<GitSyncReport>;
  manifests: GitManifestStore;
  sink: PipelineSink;
  /** Registered source identity (job bookkeeping + ledger source_id). */
  sourceId: string;
  store: IngestStore;
}

/**
 * Manifest persistence for git-source syncs: the last synced commit and the
 * path → blob-hash map that makes incremental syncs read only changed blobs.
 * Durable implementation: the `git_source_manifest` table (PgKnowledgeSink);
 * `createMemoryManifestStore` mirrors it for DB-less dev and tests.
 */
export interface GitManifestStore {
  loadManifest: (sourceKey: string) => Promise<GitSourceManifest>;
  saveManifest: (manifest: GitSourceManifest) => Promise<void>;
}

/**
 * In-memory manifest store for DB-less dev runs and tests. Same contract as
 * the Postgres table: load returns a fresh empty manifest for unknown keys.
 */
export const createMemoryManifestStore = (): GitManifestStore & {
  manifests: Map<string, GitSourceManifest>;
} => {
  const manifests = new Map<string, GitSourceManifest>();
  return {
    loadManifest: (sourceKey) =>
      Promise.resolve(
        manifests.get(sourceKey) ?? { commitSha: null, entries: {}, sourceKey }
      ),
    manifests,
    saveManifest: (manifest) => {
      manifests.set(manifest.sourceKey, manifest);
      return Promise.resolve();
    },
  };
};

/** Run one git-source sync, bridging its output onto the queue and sink. */
export const syncGitSourceDocuments = async (
  deps: GitSyncDeps
): Promise<GitSyncReport> => {
  const repositoryUrl =
    deps.config.repositoryUrl !== null &&
    deps.config.repositoryUrl.trim() !== ""
      ? deps.config.repositoryUrl
      : null;
  if (repositoryUrl === null) {
    throw new Error("git-sync: source has no repository URL to sync");
  }
  const gitSourceStore: GitSourceStore = {
    loadManifest: (sourceKey) => deps.manifests.loadManifest(sourceKey),
    saveManifest: (manifest) => deps.manifests.saveManifest(manifest),
    tombstoneDocument: async (tombstone: GitTombstone) => {
      await deps.sink.tombstoneDocument(tombstone.documentId);
    },
    upsertDocument: async (document: GitSourceDocument) => {
      const job = buildIngestJob(document);
      await deps.store.enqueueDocumentVersion(
        job.payload as unknown as DocumentVersionPayload,
        deps.sourceId
      );
    },
  };
  const gitSync = deps.gitSync ?? syncGitRepository;
  return await gitSync(gitSourceStore, {
    namespace: deps.config.namespace,
    ref: deps.config.ref,
    repositoryUrl,
  });
};
