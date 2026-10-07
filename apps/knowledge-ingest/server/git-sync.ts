/**
 * Sync adapter for `github` source_sync jobs. Each changed document becomes
 * its own idempotent `document-version` job so chunk/embed/persist retry
 * independently; deletions tombstone through the sink immediately, and the
 * manifest keeps incremental syncs to changed blobs only.
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

/** Last synced commit plus the path → blob-hash map for incremental syncs. */
export interface GitManifestStore {
  loadManifest: (sourceKey: string) => Promise<GitSourceManifest>;
  saveManifest: (manifest: GitSourceManifest) => Promise<void>;
}

/** In-memory manifest store; unknown keys load as an empty manifest. */
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
