/**
 * The durable #56 pipeline sink: `processDocumentVersion` from
 * `apps/knowledge/src/ingest.ts` (chunk → embed → upsert in one transaction)
 * plus two-clock deletion (`buildDocumentTombstone` + `buildChunkSupersede`)
 * for git-source tombstones. Shares the service's pg pool with the queue
 * store; embedding configuration comes from the shared knowledge env knobs
 * (`KNOWLEDGE_EMBEDDING_*` — the deterministic offline provider by default,
 * an OpenAI-compatible server when configured), identical to what the
 * retrieval service uses for query embeddings so vectors always come from one
 * model generation.
 *
 * Also carries the durable git-manifest store (`git_source_manifest`) over
 * the same client, so one DATABASE_URL serves the whole worker.
 */

import { embeddingWorkerConfigFromEnv } from "../../knowledge/src/embedder.ts";
import type { EmbeddingWorkerConfig } from "../../knowledge/src/embedder.ts";
import type { GitSourceManifest } from "../../knowledge/src/git-source.ts";
import { processDocumentVersion } from "../../knowledge/src/ingest.ts";
import type { DocumentIngestOutcome } from "../../knowledge/src/ingest.ts";
import {
  buildChunkSupersede,
  buildDocumentTombstone,
  ensureKnowledgeSchema,
} from "../../knowledge/src/schema.ts";
import type { GitManifestStore } from "./git-sync.ts";
import type { QueueDbClient } from "./pg-store.ts";
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

/** Minimal pg-compatible client for the manifest/queue SQL. */
interface DbClient {
  query: (
    text: string,
    params: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[] }>;
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
 * Postgres-backed pipeline sink + git manifest store over one client (the
 * service's pg pool). `applySchema` is the base #56 migration (the queue's
 * own schema is applied by the queue store first — ordering matters, see
 * server/index.ts).
 */
export class PgKnowledgeSink implements PipelineSink, GitManifestStore {
  private readonly client: DbClient;
  private readonly config: EmbeddingWorkerConfig;
  private readonly log: PgSinkOptions["log"];

  constructor(client: DbClient, options: PgSinkOptions = {}) {
    this.client = client;
    this.config =
      options.config ??
      embeddingWorkerConfigFromEnv(options.env ?? process.env);
    this.log = options.log;
  }

  /** Idempotent base #56 migration (tables the pipeline writes). */
  async applySchema(): Promise<void> {
    await ensureKnowledgeSchema(this.client);
  }

  async loadManifest(sourceKey: string): Promise<GitSourceManifest> {
    const { rows } = await this.client.query(
      "SELECT commit_sha, entries FROM git_source_manifest WHERE source_key = $1",
      [sourceKey]
    );
    return asManifest(rows[0], sourceKey);
  }

  async saveManifest(manifest: GitSourceManifest): Promise<void> {
    await this.client.query(
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
      this.client,
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
    await this.client.query("BEGIN", []);
    try {
      const tombstone = buildDocumentTombstone(documentId);
      await this.client.query(tombstone.text, tombstone.params);
      const supersede = buildChunkSupersede(documentId);
      await this.client.query(supersede.text, supersede.params);
      await this.client.query("COMMIT", []);
    } catch (error) {
      try {
        await this.client.query("ROLLBACK", []);
      } catch {
        // The original failure is the one worth surfacing.
      }
      throw error;
    }
  }
}

/** Adapt the service's queue pool client to the sink's client surface. */
export const sinkClientFromPool = (pool: QueueDbClient): DbClient => ({
  query: async (text, params) => {
    const result = await pool.query(text, params ?? []);
    return { rows: (result.rows ?? []) as Record<string, unknown>[] };
  },
});
