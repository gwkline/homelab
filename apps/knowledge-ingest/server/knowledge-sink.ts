/**
 * Postgres pipeline sink: chunk → embed → upsert in one transaction, plus
 * two-clock deletion for tombstones. Embeddings use the same
 * `KNOWLEDGE_EMBEDDING_*` config as retrieval so query and document vectors
 * come from one model.
 */

import { embeddingWorkerConfigFromEnv } from "../../knowledge/src/embedder.ts";
import type { EmbeddingWorkerConfig } from "../../knowledge/src/embedder.ts";
import type { GitSourceManifest } from "../../knowledge/src/git-source.ts";
import { processDocumentVersion } from "../../knowledge/src/ingest.ts";
import type { DocumentIngestOutcome } from "../../knowledge/src/ingest.ts";
import type { PgPool } from "../../knowledge/src/pg-client.ts";
import { withTransaction } from "../../knowledge/src/pg-client.ts";
import {
  buildChunkSupersede,
  buildDocumentTombstone,
} from "../../knowledge/src/schema.ts";
import type { GitManifestStore } from "./git-sync.ts";
import type {
  PipelineDocument,
  PipelineSink,
  PipelineSinkOutcome,
} from "./pipeline-worker.ts";

export interface PgSinkOptions {
  /** Embedding worker config; defaults to the shared env knobs. */
  config?: EmbeddingWorkerConfig;
  env?: Record<string, string | undefined>;
  /** Structured sink log (identifiers + counts only). */
  log?: (entry: Record<string, string | number | boolean | null>) => void;
}

const asManifest = (
  row: Record<string, unknown> | undefined,
  sourceKey: string
): GitSourceManifest => {
  if (row === undefined) {
    return { commitSha: null, entries: {}, sourceKey };
  }
  const { entries } = row;
  if (
    typeof entries !== "object" ||
    entries === null ||
    Array.isArray(entries)
  ) {
    throw new TypeError(
      "knowledge-sink: manifest entries are not a JSON object"
    );
  }
  const commitSha = row["commit_sha"];
  return {
    commitSha: typeof commitSha === "string" ? commitSha : null,
    entries: entries as Record<string, never>,
    sourceKey,
  };
};

/**
 * Pipeline sink and git manifest store over the service's pg pool. Single
 * statements use the pool; transactions check out their own connection.
 */
export class PgKnowledgeSink implements PipelineSink, GitManifestStore {
  private readonly pool: PgPool;
  private readonly config: EmbeddingWorkerConfig;
  private readonly log: PgSinkOptions["log"];

  constructor(pool: PgPool, options: PgSinkOptions = {}) {
    this.pool = pool;
    this.config =
      options.config ??
      embeddingWorkerConfigFromEnv(options.env ?? process.env);
    this.log = options.log;
  }

  async loadManifest(sourceKey: string): Promise<GitSourceManifest> {
    const { rows } = await this.pool.query(
      "SELECT commit_sha, entries FROM git_source_manifest WHERE source_key = $1",
      [sourceKey]
    );
    return asManifest(rows[0], sourceKey);
  }

  async saveManifest(manifest: GitSourceManifest): Promise<void> {
    await this.pool.query(
      `INSERT INTO git_source_manifest (source_key, commit_sha, entries)
VALUES ($1, $2, $3::jsonb)
ON CONFLICT (source_key) DO UPDATE SET
  commit_sha = EXCLUDED.commit_sha,
  entries = EXCLUDED.entries,
  updated_at = now()`,
      [manifest.sourceKey, manifest.commitSha, JSON.stringify(manifest.entries)]
    );
  }

  async processDocumentVersion(
    doc: PipelineDocument
  ): Promise<PipelineSinkOutcome> {
    const outcome: DocumentIngestOutcome = await processDocumentVersion(
      this.pool,
      {
        content: doc.content,
        documentId: doc.documentId,
        externalId: doc.externalId,
        format: doc.format,
        namespace: doc.namespace,
        source: doc.source,
        title: doc.title,
        url: doc.url,
        versionId: doc.versionId,
      },
      {
        config: this.config,
        ...(this.log === undefined ? {} : { log: this.log }),
      }
    );
    return {
      chunks: outcome.totalChunks,
      status: outcome.status,
    };
  }

  async tombstoneDocument(documentId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const tombstone = buildDocumentTombstone(documentId);
      await client.query(tombstone.text, tombstone.params);
      const supersede = buildChunkSupersede(documentId);
      await client.query(supersede.text, supersede.params);
    });
  }
}
