/**
 * Deterministic fixture worker (#58 scope boundary): proves queue completion
 * without source-specific fetching, chunking, or embeddings. For a document
 * job it publishes the document version idempotently (re-runs after stale
 * recovery report zero new documents) with a chunk count derived purely from
 * the content hash; for a source resync it completes with zero counts. Real
 * extract → chunk → embed → upsert handlers land with the retrieval issues.
 */

import type { JobHandler } from "./worker.ts";

/** Deterministic chunk estimate: 1 + (first hash byte mod 4). */
export const fixtureChunkCount = (contentHash: string): number => {
  const parsed = Number.parseInt(contentHash.slice(0, 2), 16);
  return 1 + (Number.isFinite(parsed) ? parsed % 4 : 0);
};

export const createFixtureHandler = (): JobHandler => {
  const handler: JobHandler = async (job, { store }) => {
    if (job.kind === "source_sync") {
      return { chunksIngested: 0, documentsIngested: 0 };
    }
    const { payload } = job;
    if (payload.kind !== "document") {
      throw new Error(`fixture handler cannot process kind ${job.kind}`);
    }
    const { document } = payload;
    const chunksIngested = fixtureChunkCount(document.contentHash);
    const published = await store.publishDocumentVersion(
      document,
      chunksIngested
    );
    return {
      chunksIngested: published ? chunksIngested : 0,
      documentsIngested: published ? 1 : 0,
    };
  };
  return handler;
};
