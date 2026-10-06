# knowledge

Hybrid retrieval for the homelab knowledge base: fuse keyword (BM25, #60) and semantic (pgvector, #62) candidate lists into one deterministic ranking of cited chunks. No LLM answer generation, no graph expansion — this package ends at ranked chunks with citation-ready metadata.

## Durable schema: documents, chunks, sources, provenance (#56)

`src/schema.ts` defines the schema both channels retrieve from (ADR-002 D3/D5/D9/D10): five tables plus the core indexes, applied by one idempotent migration (`ensureKnowledgeSchema`) that targets an empty PostgreSQL 18 database. Every statement is `IF NOT EXISTS`, so re-running against a migrated cluster is a no-op; databases holding the pre-#56 stopgap `chunks` table get the missing columns via `ADD COLUMN IF NOT EXISTS`.

- `knowledge_namespace` — the collection registry. `document` and `chunks` foreign-key to it, so an unregistered or malformed namespace cannot ingest; retrieval still scopes by the denormalized `namespace` column both channels filter on.
- `document` — the stable source identity: one row per `(namespace, source, external_id)` (file path, canonical URL, note slug), never rewritten by content changes. Holds the current version pointer (`version`, `content_hash`), the citation fields (`title`, `url`), and the `deleted_at` tombstone.
- `document_version` — append-only content history. Every ingest of changed content appends a row; a chunk's `version_id` names the version that produced it, so any result can be explained by the content that produced it.
- `chunks` — the single-table retrieval store both channels rank. Chunk identity is content-addressed (`UNIQUE (document_id, content_hash)`): re-ingesting unchanged text touches nothing and the existing embedding survives without a re-embed. Citation anchors (`anchors` JSONB: offset spans or heading values), `idx`, and the `valid_from`/`valid_to` validity window are the provenance join, resolved at query time — there is no separate provenance table in phase one.
- `ingest_job` — the durable ingestion queue, claimed one job at a time with `FOR UPDATE SKIP LOCKED` (priority first, then FIFO).

Invariants (offline builder tests plus a live integration test in `tests/schema.test.ts`, skipped unless `DATABASE_URL` points at a Postgres with pgvector and pg_textsearch):

- Re-ingesting unchanged content is a full no-op: the document upsert returns zero rows, and chunk upserts reactivate existing rows without touching `embedding`.
- Changed content bumps `version`, appends a `document_version` row, and supersedes the document's live chunks (`valid_to = now()`); chunks absent from the new version stay superseded.
- Deletion is two-clock: `buildDocumentTombstone` + `buildChunkSupersede` hide a document from live-chunk retrieval immediately; hard delete (rows + raw objects) is a later GC job backed by `ON DELETE CASCADE` and the `document_tombstoned` index.
- The `vector(384)` typmod and the per-chunk `embedding_model` tag pin the embedding generation (ADR-002 D6): a model swap is a backfill, never an in-place rewrite.

The channel migrations compose the base schema and add their own indexes: `ensurePgvectorSchema` adds the partial HNSW index, `ensureBm25Schema` the pg_textsearch extension and the partial BM25 index. Both are self-sufficient against an empty database.

## Fusion: Reciprocal Rank Fusion (RRF)

BM25 scores and embedding distances are not comparable, so `src/fusion.ts` ignores raw scores and fuses **ranks** only:

```
score(chunk) = Σ over channels that returned the chunk: 1 / (k + rank)
```

- `k` (default `60`, Cormack et al. 2009) dampens the head of each list so one channel's top hit cannot always dominate a two-channel consensus. Tune it via the eval harness, not by eye. Configurable through `FusionOptions.k`.
- `windowSize` (default `100`) bounds each channel's contribution to its top candidates, keeping long retrieval tails from flooding the fusion. One window per channel, applied before ranking (`FusionOptions.windowSize`).

Behavior contract:

- A chunk returned by several retrievers collapses to one candidate whose `ranks` record keeps every source rank (`ranks.bm25`, `ranks.vector`) for debugging; a channel that missed the chunk is simply absent from `ranks`.
- A chunk returned by only one retriever stays fully eligible.
- Ties are broken deterministically: fused score descending, then best (lowest) source rank, then chunk id ascending. The float score is summed in sorted channel order, so input list order cannot change the output.
- Malformed input throws: duplicate chunk id inside one channel's list, duplicate channel, empty channel name, non-positive/`k`, bad `windowSize`.

The function is pure — no I/O, no clocks. #60/#62 retrievers provide ranked chunk-id lists; the fusion adds no scores of its own beyond the RRF sum.

## Keyword channel: BM25 (pg_textsearch, #60)

`src/bm25.ts` ranks the shared `chunks` table with Timescale [`pg_textsearch`](https://github.com/timescale/pg_textsearch) (shipped for CNPG by `images/pg-textsearch`, #48). The index is the partial single-column BM25 index from ADR-002 D7 — `USING bm25 (text) WITH (text_config = 'english') WHERE valid_to IS NULL` — so superseded chunks stay out of the corpus statistics (document counts, average length, IDF) and rankings always reflect the live corpus. Contract:

- **Explicit index addressing.** Every query names the index with `text <@> to_bm25query($1, 'chunks_text_bm25')`: pg_textsearch's implicit `text <@> 'terms'` form skips partial indexes, and explicit naming is required for WHERE-clause scoring. Top-k queries always pair `ORDER BY <score> ASC` with `LIMIT` so the Block-Max WAND optimization applies.
- **Negative scores, documented.** `<@>` returns the _negative_ BM25 score (Postgres only supports ASC index scans on the operator): the best match sorts first with the most negative `score`. Raw scores are query-dependent (IDF and length normalization change per query) and therefore not comparable across queries — the 1-based `rank` field is the stable ordering contract fusion consumes (ADR-002 D7: "ranks are all the fusion consumes").
- **Validated, parameterized namespace filter.** The collection key (ADR-002 D9, `^[\w.-]{1,128}$`) is a bind parameter backed by the `chunks_namespace_active` B-tree index. With that B-tree in place the planner chooses between pg_textsearch's two documented filter paths: _pre-filter_ through the B-tree before scoring (best when the namespace is selective) or _post-filter_ during the score-ordered BM25 scan. Post-filtering computes top-k against the indexed corpus before applying the filter, so it may return fewer than `limit` rows when the filter eliminates most candidates — raise `limit` and re-limit in application code if a guaranteed count matters. The `EXPLAIN` integration test proves both index paths (BM25 scan on a wide namespace, B-tree on a sparse one) over a 10,000-row fixture.
- **Citation-ready result shape.** Hits carry chunk id + text, document id + version, namespace, rank, score, and validated citation anchors (the #56 anchor contract) — the same shape as the vector channel, ready for fusion.
- **Superseded chunks.** Default queries target live chunks only (`valid_to IS NULL`, matching the partial index predicate). `includeSuperseded: true` drops the predicate and falls back to a sequential scan — exact, but without index assistance.

Offline unit tests cover SQL construction, validation (query text, namespace, index name, limit are checked before any database call), and row mapping. The live integration test (skipped unless `DATABASE_URL` points at a Postgres with both pg_textsearch and pgvector, as on the knowledge CNPG cluster) seeds a deterministic 10k-chunk fixture and proves index use via `EXPLAIN` plus the query classes: exact identifiers, rare terms, stemming, punctuation, and no-result queries (empty result, never fabricated hits).

## Vector channel: pgvector (#62)

`src/pgvector.ts` is the semantic counterpart to the BM25 keyword channel (`src/bm25.ts`). It ranks chunk embeddings with a partial HNSW index (`USING hnsw (embedding vector_cosine_ops) WHERE valid_to IS NULL AND embedding IS NOT NULL`) whose cosine operator class matches the indexed model — local, deterministic `BAAI/bge-small-en-v1.5`, 384-d (ADR-002 D6). Contract:

- **Query/index model match or clear failure.** `searchPgvector` validates the query embedding before touching the database: it must be a finite, non-zero 384-d vector, and the query filters `embedding_model = $3 AND embedding IS NOT NULL` — chunks from another model generation (or without an embedding) can never mix into results. `countChunksNeedingBackfill` reports the missing-embedding and model-mismatch rows waiting on the re-embed backfill (D10: a model swap is a backfill job, not an in-place rewrite).
- **Parameterized filters.** Namespace (the collection key, D9) is a bind parameter; `includeSuperseded` toggles the active-version predicate `valid_to IS NULL`. Note that `includeSuperseded: true` falls back to a sequential scan because the partial index covers live chunks only.
- **BM25 candidate contract.** Hits carry chunk id + text, document id + version id, a 1-based rank and the cosine distance (lower = better), and validated citation anchors — the shape fusion consumes.
- **Configurable, recorded.** `efSearch` (default 40) and the candidate count (`limit`, default 10) are per-query options; `ef_search` is applied via `SET LOCAL hnsw.ef_search` inside the search transaction, and both values are recorded in every eval run (`metadata.retrievalConfig.vectorEfSearch` / `vectorCandidateCount`).
- **Exact baseline + recall.** `searchPgvectorExact` runs the identical ranking query under `SET LOCAL enable_indexscan = off` — a true sequential scan for tests/evaluation on small datasets — and `hnswRecall` compares approximate top-k against it. Offline tests do this on a deterministic fixture (brute-force cosine as ground truth); the live-DB integration test runs it against a real HNSW index when `DATABASE_URL` points at a pgvector-enabled Postgres, skipped otherwise like the BM25 integration test.

This channel ends at ranked, cited chunks — fusing with BM25 ranks happens only in `src/fusion.ts` upstream.

## Evaluation harness

`eval/` compares BM25-only, vector-only, and fused retrieval from one command:

```sh
npm run eval                    # human summary over the full dataset
npm run eval -- --json          # machine-readable run record on stdout
npm run eval -- --subset        # cheap deterministic CI subset
npm run eval -- --out run.json  # also write the JSON run record to a file
```

The run exits non-zero when the regression gate (below) fails, so CI can block retrieval regressions.

Two datasets drive it:

- `eval/corpus.ts` — a small committed synthetic corpus (5 docs, 9 hand-chunked texts, versioned `knowledge-eval-corpus-v1`; bump on any chunk/label change) with labeled queries: relevant chunk ids, relevant document ids for citation accuracy, and two deliberately unanswerable queries. Channel rankings are computed from corpus text by eval-local scorers (`eval/rank.ts`): an independent BM25 and a deterministic feature-hashed bag-of-words stand-in for pgvector (#62) — fully offline, no paid embedding API.
- `eval/fixtures.ts` — hand-labeled per-channel rankings modeling the scenarios fusion must handle (exact identifiers, paraphrases, rescues, disjoint relevance, no-hits) until the real retrievers land.

Metrics (`eval/metrics.ts`, cutoff `k = 5`): Recall@k, MRR@k, precision@k, citation/source accuracy (fraction of top-k results citing a relevant document), no-answer correctness (unanswerable queries must abstain, not fabricate hits), and per-query latency (informational, never gated).

Every run records provenance (`eval/run-meta.ts`): Git SHA + dirty flag, schema/migration version (`KNOWLEDGE_SCHEMA_VERSION` from `src/schema.ts`, `1-knowledge-core` since #56; override via the `KNOWLEDGE_SCHEMA_VERSION` env var when a channel-composed migration identifies itself differently), embedding model, chunker version, retrieval configuration (k, RRF k, window size, abstention floors), and dataset version. The JSON output shape is versioned (`retrieval-eval-v1`).

### Regression gate

`eval/thresholds.ts` pins floors at the current deterministic outcome: fused corpus Recall@5 ≥ 0.9, MRR@5 ≥ 0.8, no-answer correctness ≥ 1.0, and fused Recall never behind the best single channel; fused fixture Recall/MRR ≥ 0.8. Raise a floor when retrieval genuinely improves; never lower one to make a run pass. Citation accuracy and latency are recorded as trends, not gates (citation floors depend on corpus size; latency is machine-dependent).

### Independence

Channel rankings come from eval-local scorers in `eval/rank.ts`, never from `src/`, so a broken system-side retriever shows up as a metric drop instead of cancelling out against a shared implementation. The fused strategy deliberately exercises the real SUT (`src/fusion.ts`) — the harness measures it, it does not reimplement it.

Unit tests in `tests/` cover the fusion scenarios (disjoint lists, identical lists, ties, short lists, missing channels) and assert the fixture-level comparison outcomes, corpus-level harness behavior (deterministic ranking, abstention on unanswerable queries, citation accuracy, no-answer correctness), and the threshold gate (passes now, fails a regressed fused strategy).

## Deferred

Heavier reranking (cross-encoder, LLM listwise) is intentionally out of scope: add it only if this harness shows fused retrieval lagging a single channel on real retriever output.
