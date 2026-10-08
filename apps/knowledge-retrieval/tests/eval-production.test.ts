import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVAL_CHUNKS,
  EVAL_CORPUS_QUERIES,
  EVAL_DOCS,
} from "../../knowledge/eval/corpus.ts";
import { mrrAtK, recallAtK } from "../../knowledge/eval/metrics.ts";
import {
  createFakeEmbeddingProvider,
  resolveEmbeddingWorkerConfig,
} from "../../knowledge/src/embedder.ts";
import { processDocumentVersion } from "../../knowledge/src/ingest.ts";
import { migrateKnowledgeSchema } from "../../knowledge/src/schema.ts";
import { createApp } from "../server/app.ts";
import { baseConfig } from "../server/config.ts";
import { PgRetrievalStore } from "../server/pg-store.ts";
import { hasLiveDb, withFreshDatabase } from "./live-db.ts";

/**
 * The eval corpus through the production path: ingested by
 * `processDocumentVersion`, ranked by pg_textsearch and the shared fusion,
 * served by the real app. The eval's own channel scorers stay as independent
 * cross-checks; this gate catches regressions in the code that ships.
 * Floors are pinned at the current outcome; raise them, never lower them.
 */
const PRODUCTION_FLOORS = { mrrAt5: 1, recallAt5: 1 };
const K = 5;
const TOKEN = "eval-production-token-0123456789";
const NAMESPACE = "eval-corpus";

const mean = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const silent = {
  debug: (): void => undefined,
  error: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
};

test(
  "production retrieval meets the eval floors on the eval corpus",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set", timeout: 120_000 },
  async () => {
    await withFreshDatabase(async (url) => {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: url });
      try {
        await migrateKnowledgeSchema(pool);
        const config = resolveEmbeddingWorkerConfig({
          provider: createFakeEmbeddingProvider(),
        });
        const titles = new Map(EVAL_DOCS.map((doc) => [doc.id, doc.title]));
        for (const chunk of EVAL_CHUNKS) {
          await processDocumentVersion(
            pool,
            {
              content: chunk.text,
              documentId: chunk.id,
              externalId: chunk.id,
              format: "text",
              namespace: NAMESPACE,
              source: "file",
              title: titles.get(chunk.docId) ?? chunk.docId,
              versionId: `${chunk.id}-v1`,
            },
            { config }
          );
        }
        const app = createApp({
          config: baseConfig(TOKEN, { defaultNamespace: NAMESPACE }),
          logger: silent,
          store: new PgRetrievalStore(pool, {
            provider: createFakeEmbeddingProvider(),
          }),
        });
        const scored = [];
        for (const query of EVAL_CORPUS_QUERIES.filter(
          (candidate) => candidate.answerable
        )) {
          const res = await app.request("/v1/search", {
            body: JSON.stringify({ query: query.query, topK: K }),
            headers: {
              authorization: `Bearer ${TOKEN}`,
              "content-type": "application/json",
            },
            method: "POST",
          });
          assert.equal(res.status, 200, query.id);
          const body = (await res.json()) as {
            results: { source: { path: string } }[];
          };
          const ranked = body.results.map((result) => result.source.path);
          scored.push({
            id: query.id,
            mrr: mrrAtK(ranked, query.relevantChunks, K),
            recall: recallAtK(ranked, query.relevantChunks, K),
          });
        }
        const recall = mean(scored.map((entry) => entry.recall));
        const mrr = mean(scored.map((entry) => entry.mrr));
        const detail = JSON.stringify(scored);
        assert.ok(
          recall >= PRODUCTION_FLOORS.recallAt5,
          `recall@5 ${recall}: ${detail}`
        );
        assert.ok(mrr >= PRODUCTION_FLOORS.mrrAt5, `mrr@5 ${mrr}: ${detail}`);
      } finally {
        await pool.end();
      }
    });
  }
);
