# knowledge

Hybrid retrieval library for the homelab knowledge base: ingest sources into Postgres, rank chunks with BM25 and pgvector, and fuse the two rankings into one deterministic list of cited chunks. It ends at ranked chunks; there is no answer generation.

The two services live here too, built into one image (`Dockerfile`) with one bundle per entrypoint; each Deployment picks its own (see `deploy/knowledge/README.md`):

- **`server/ingest.ts`** (`server/ingest/`) runs the durable queue: `source_sync` jobs call `src/git-source.ts`, and `document-version` jobs call `processDocumentVersion`.
- **`server/retrieval.ts`** (`server/retrieval/`) serves `POST /v1/search` using the channel queries here and RRF fusion. Without `DATABASE_URL` it falls back to an in-memory store.

Shared HTTP, auth, logging and store errors are in `src/`. The bundles inline everything except `pg`, the one runtime dependency in `package.json`.

## Run

```sh
npm test -w apps/knowledge       # builds both bundles, then every suite (offline)
npm run typecheck -w apps/knowledge
npm run eval -w apps/knowledge   # retrieval eval; --json, --subset, --out run.json
```

The live-database tests are skipped unless `DATABASE_URL` points at a Postgres with pgvector and pg_textsearch whose user can create databases. CI's `knowledge-postgres` job runs them all against `tests/postgres/Dockerfile`. To match it locally:

```sh
docker build -t knowledge-pg apps/knowledge/tests/postgres   # amd64; add --platform linux/amd64 elsewhere
docker run -d --rm -p 5432:5432 -e POSTGRES_PASSWORD=knowledge -e POSTGRES_DB=knowledge knowledge-pg
DATABASE_URL=postgresql://postgres:knowledge@localhost:5432/knowledge \
  npm test -w apps/knowledge
```

`tests/embed-smoke.test.ts` calls a real embedding provider only when `KNOWLEDGE_EMBEDDING_SMOKE_URL` is set.

## Modules

| File | Role |
| --- | --- |
| `src/schema.ts` | Every table and index, as numbered migrations that knowledge-ingest applies under an advisory lock; retrieval only checks the applied version. Also the corpus statement builders. |
| `src/pg-client.ts` | Pool surface and `withTransaction`, which runs each transaction on one checked-out connection. |
| `src/git-source.ts` | Incremental Git sync into whole-file documents, emitted as `document-version` ingest jobs. |
| `src/chunk.ts` | Deterministic markdown/code/text chunking with citation anchors. |
| `src/embedder.ts` | Embedding providers plus a batched, bounded, retrying request engine. |
| `src/ingest.ts` | Chunk, embed, and persist one document version. |
| `src/bm25.ts` | Keyword channel over a partial pg_textsearch index. |
| `src/pgvector.ts` | Semantic channel over a partial HNSW cosine index. |
| `src/fusion.ts` | Reciprocal Rank Fusion, used by `/v1/search` and the eval. |
| `src/pg-pool.ts` | The services' pool: size, connection and statement timeouts, and an idle-error listener. |
| `src/http.ts`, `src/log.ts`, `src/store-errors.ts` | Bearer check, request-id and request-log middleware, JSON logger, and the 503 store error, shared by both services. |

## Key contracts

- **Idempotent ingest.** Chunks are content-addressed on `(document_id, content_hash)`, and chunk ids hash `(documentId, chunkerVersion, idx, contentHash)`. Re-ingesting unchanged content writes nothing and never re-embeds. Bump `CHUNKER_VERSION` on any change that affects boundaries or ids.
- **Live chunks only.** Both channels filter on `valid_to IS NULL`, which matches their partial indexes. Tombstoning a document supersedes its chunks immediately. Hard delete is a separate GC job.
- **One embedding generation per index.** The `vector(384)` column pins the dimension (`BAAI/bge-small-en-v1.5`, cosine). Each chunk is tagged with `embedding_model`, and search filters on it. A chunk whose embedding failed is still stored with a NULL embedding: BM25 still serves it, and `countChunksNeedingBackfill` reports it.
- **Ranks, not scores.** BM25 scores (negative, query-dependent) and cosine distances are not comparable. Fusion sums `1 / (k + rank)` per channel (`k = 60`, `windowSize = 100`). Ties break on the best single-channel rank, then chunk id.
- **Embedding config** comes from `KNOWLEDGE_EMBEDDING_PROVIDER` (`fake` by default, or `openai` for any OpenAI-compatible `/embeddings` endpoint at `KNOWLEDGE_EMBEDDING_BASE_URL`), together with `_MODEL`, `_DIMENSIONS`, `_API_KEY`, `_BATCH_SIZE`, `_CONCURRENCY`, `_TIMEOUT_MS`, `_MAX_RETRIES`, and `_BASE_DELAY_MS`.
- **Fake vectors are labelled fake.** The fake provider tags every vector `fake/<dims>`, whatever `_MODEL` says, and refuses any other tag. While it is configured, retrieval serves every search as BM25 and reports `mode: "bm25"`. At startup it logs whether stored vectors match the configured model, and `/metrics` exposes `knowledge_vector_search_enabled` and `knowledge_embedding_model_mismatch_chunks`.
- **Git auth and secrets.** The token comes from `GitSourceConfig.token`, `GIT_SOURCE_TOKEN_FILE`, or `GIT_SOURCE_TOKEN`, and reaches git only through `GIT_CONFIG_*` env vars. URLs with embedded credentials are rejected. Secret-looking files are never ingested, even with `applyDefaultExcludes: false`.
- **No bodies in logs.** Log entries carry identifiers and counts only.

## Evaluation

`eval/` compares BM25-only, vector-only, and fused retrieval over a small committed corpus (`eval/corpus.ts`) and hand-labeled channel fixtures (`eval/fixtures.ts`). Channel rankings come from eval-local scorers (`eval/rank.ts`), not from `src/`, so a broken retriever shows up as a metric drop. Fusion is the real `src/fusion.ts`. The production path is gated separately: `tests/retrieval/eval-production.test.ts` ingests the same corpus with `processDocumentVersion` and scores `/v1/search` against Postgres.

The metrics are Recall@5, MRR@5, precision, citation accuracy, no-answer correctness, and latency. Every run records git SHA, schema version, embedding model, chunker version, and retrieval config.

`eval/thresholds.ts` is a regression gate, and the eval exits non-zero when a floor fails. Raise a floor when retrieval genuinely improves. Never lower one to make a run pass.
