# ADR-002: Knowledge architecture — Postgres-native hybrid retrieval

**Status:** Accepted (2026-09-02) **Deciders:** Gavin Kline, ox-alpha **Implements:** #51 · **Blocks:** #60, #62

## Context

The homelab needs a personal, self-hosted knowledge base. `apps/knowledge` already ships the fusion contract (`src/fusion.ts`: RRF, k=60, windowSize=100) and the eval harness (`eval/`, thresholds gated in CI), but the retrieval issues downstream (#60 pg_textsearch BM25, #62 pgvector) could each invent incompatible ingestion and retrieval models. This ADR fixes the schema, retrieval stack, and build order first.

Constraints (from #51 and repo direction):

- One Postgres, no extra databases: no Neo4j, no Pinecone, no Qdrant, no Kafka, no S3 (yet).
- Self-hosted and offline-friendly: no paid-API dependency for retrieval; embeddings must run locally.
- The factory database (ADR-001) stays extension-free; the knowledge database is a separate CNPG cluster where extensions are allowed.
- This package ends at ranked, cited chunks — no LLM answer synthesis (`apps/knowledge/README.md`).

## Systems studied

| System | What it is | What we take | What we reject |
| --- | --- | --- | --- |
| [prbe-knowledge](https://github.com/prbe-ai/prbe-knowledge) (Probe) | AGPL self-hosted knowledge engine: webhooks → queue → worker → Postgres, hybrid retrieval, cited answers | `db/schema.sql`: documents versioned with `valid_from/valid_to` + `supersedes_doc_id`; **content-addressed chunks** `UNIQUE (doc_id, content_hash)` so unchanged content never re-embeds; `ingestion_queue` drained `FOR UPDATE SKIP LOCKED`; graph as plain `graph_nodes`/`graph_edges` tables — the schema's own comment records that Apache AGE was rejected (unavailable on Neon); title denormalized onto chunks so BM25 stays single-table | Multi-tenant customer machinery, RLS, ACL snapshots — single-operator homelab doesn't need them |
| [pgkg](https://github.com/ExaDev/pgkg) | MIT "agentic memory in pure(ish) postgres" — propositions + passages, all logic in SQL functions | Numbered SQL migrations with header docs (`migrations/010_search_decompose.sql`, `031_corpus_retrieval.sql`); **composable retriever SRFs** fused by weighted RRF; **chunks-only mode** (`PGKG_EXTRACT_PROPOSITIONS=0`) as a first-class supported path; embedder generations so cosines from different model spaces are never compared; tombstone-then-GC deletion on two clocks | Bitemporal facts, PageRank, decay profiles — premature until extraction exists |
| [pg-raggraph](https://github.com/yonk-labs/pg-raggraph) | MIT PostgreSQL-native GraphRAG: vector + BM25 + recursive-CTE graph in one query | "RAG first, graph second" with receipts: on clean corpora graph-only modes don't beat naive vector+BM25 (`benchmarks/age-bakeoff/results/REPORT-VERDICT.md`); recursive CTEs beat AGE handily (sub-ms p50 to 3 hops vs 33–132 ms, `benchmarks/age-bakeoff/cap-gold-v1/PIPELINES.md`); `defer_extraction=True` + background `pgrg extract` decouples ingest from graph build | Its LLM extractor and 6 retrieval modes — phase one needs two channels |
| [acuity-rag](https://github.com/vltech55/acuity-rag) | MIT production RAG over arXiv: hybrid tsvector+pgvector, RRF k=60, cross-encoder rerank, faithfulness evals | RRF k=60 confirmed in production shape; **confidence-gated rerank** (skip when RRF already strong); `eval_runs` persisted with git SHA + config snapshot so before/after is direct; inline `[Sₙ]` citation markers | Full streaming answer stack — outside this package's boundary |
| [LlamaIndex](https://github.com/run-llama/llama_index) (established framework baseline) | Python RAG framework | `core/schema.py` `TextNode.relationships` (SOURCE/PREVIOUS/NEXT) — nodes carry doc id + metadata so every hit cites; `core/ingestion` IngestionPipeline docstore **hash-dedup upserts** — the same idempotent-ingest idea as content-addressed chunks | Framework adoption itself: heavy abstraction over 4 SQL statements we already need |

Also consulted: [timescale/pg_textsearch](https://github.com/timescale/pg_textsearch) (the BM25 extension, see D7) and [Microsoft GraphRAG](https://github.com/microsoft/graphrag) as the graph-first contrast — entity extraction before retrieval is exactly the ordering pg-raggraph's bake-off undercuts for prose corpora.

## Decisions

### D1. Phase one is chunks-only hybrid retrieval — no propositions, no entity extraction

Three of the four implementations ship a chunks-only path as a supported mode (pgkg's zero-LLM mode, pg-raggraph's extractorless ingest, Probe's raw chunk store), and the evidence says it is not a degraded mode for prose:

- pg-raggraph: on a 486-doc codebase, naive vector+BM25 with a 1-hop boost beat every graph-heavy mode on score; graph pays off only with weak chunkers, cross-document entity reasoning, or provenance-heavy QA (`benchmarks/pg-agents-results.md`, `ab-gate/RESULTS.md`).
- pgkg: corpus extraction is "opt-in per collection, off by default — lossy on exactly the content corpora are made of."
- Our own eval corpus (`apps/knowledge/eval/corpus.ts`) is single-hop today; nothing measures a multi-hop gap yet.

Entity/proposition extraction starts **only when evals show the gap** (D12/D11). Until then, extraction spend buys latency and LLM cost, not recall.

### D2. Service boundary

Everything lives in `apps/knowledge`: schema + migrations, ingest, retrievers, `/search`, eval. One separate Postgres database (CNPG). No message bus, no embedding microservice, no graph engine.

### D3. Initial document/chunk schema

```sql
document(
  id uuid PK, namespace text NOT NULL,
  source text NOT NULL,            -- 'file' | 'url' | 'note' | ...
  external_id text NOT NULL,       -- path / canonical URL / note slug
  title text, url text,
  version int NOT NULL DEFAULT 1,  -- bumped on content change
  content_hash text NOT NULL,      -- sha256 of extracted text
  deleted_at timestamptz,          -- tombstone; NULL = live
  created_at timestamptz, updated_at timestamptz,
  UNIQUE (namespace, source, external_id))

chunk(
  id uuid PK, document_id uuid REFERENCES document(id) ON DELETE CASCADE,
  namespace text NOT NULL,         -- denormalized: single-table retrieval
  idx int NOT NULL,                -- position for ordered context
  text text NOT NULL,
  content_hash text NOT NULL,      -- sha256 of chunk text
  embedding vector(384), embedding_model text,   -- D6
  chunker_version text NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,            -- NULL = live in current document version
  UNIQUE (document_id, content_hash))
```

Provenance is not a separate table in phase one: a chunk's provenance **is** its `(document_id, version via valid_from/valid_to, idx)` join, resolved at query time (LlamaIndex's SOURCE-relationship pattern, flattened). Chunk identity is `(document_id, content_hash)` copied from Probe so re-ingesting unchanged text touches nothing (D10).

### D4. Raw-object storage

Raw bytes (original files/HTML) go to the panel PVC: `/data/knowledge-raw/<namespace>/<sha256>` — the same pattern as factory artifacts (ADR-001 D2). Postgres stores extracted text only. `storage_path` is opaque; migrating to S3 later is additive. Nightly restic covers the PVC once the path is added to its backup set.

### D5. Ingestion queue

A `ingest_job(id, kind, payload jsonb, status, attempts, error, priority, enqueued_at, started_at, heartbeat_at)` table claimed with `FOR UPDATE SKIP LOCKED` (Probe's `ingestion_queue` pattern). A worker (CronJob first, deployment when volume justifies it) drains: extract → chunk → embed → upsert. Ingest is idempotent: same content_hash = no-op. Phase one's `/search` PR may ingest synchronously for its seed corpus, but the queue is the durable contract for anything bigger than a handful of documents.

### D6. Embedding provider

Local, deterministic, no paid API: **fastembed ONNX `BAAI/bge-small-en-v1.5`, 384-d, cosine** (pg-raggraph's default scale; pgkg's bge-m3 1024-d is the upgrade path if evals demand it). `chunk.embedding_model` records the producer (pgkg's embedder-generation discipline): queries embed with the model of the chunks being searched, and different models never mix in one index — a model swap is a re-embed backfill job, not an in-place rewrite.

### D7. Hybrid retrieval: pg_textsearch + pgvector → RRF

- **BM25 channel** — [`timescale/pg_textsearch`](https://github.com/timescale/pg_textsearch) (PG17/18, `shared_preload_libraries`, CNPG-configurable):
  ```sql
  CREATE INDEX chunk_bm25 ON chunk USING bm25 (text)
    WITH (text_config='english') WHERE valid_to IS NULL;
  SELECT id FROM chunk
  WHERE namespace = $1
  ORDER BY text <@> to_bm25query($2, 'chunk_bm25')
  LIMIT 100;   -- negative BM25 scores; ranks are all the fusion consumes
  ```
  Partial index keeps dead chunks out of the corpus statistics. Top-k uses Block-Max WAND; no phrase queries (documented limitation) — acceptable for chunk-level search.
- **Vector channel** — pgvector HNSW, also partial: `USING hnsw (embedding vector_cosine_ops) WHERE valid_to IS NULL`, with the namespace predicate supported by a plain index (pre-filter), mindful of pgvector's post-filter recall semantics.
- **Fusion** — the existing `src/fusion.ts` RRF (k=60, windowSize=100) is unchanged and is the contract both channels feed: ranked chunk-id lists, no raw scores, deterministic tie-breaks.
- **Reranking** — deferred, matching acuity's gating and `apps/knowledge/README.md`: add a cross-encoder only if the harness shows fused retrieval lagging the best single channel on real retriever output.

### D8. Citations and provenance guarantees

`POST /search {query, namespace?, k=5}` returns `{chunk_id, document_id, version, idx, namespace, title, url, source, text}` — every result is a live chunk joined to a live document (`chunk.valid_to IS NULL AND document.deleted_at IS NULL`). Guarantees:

1. No result without a resolvable citation (chunk → document → source/url) — checked by the harness's citation-accuracy metric.
2. No result from deleted or superseded content — tombstones and validity windows are applied **inside** both channels, before fusion (pgkg's prune-before-rank).
3. Unanswerable queries return an empty result, never fabricated hits — the eval's no-answer correctness gate stays at ≥ 1.0.

### D9. Namespaces

`namespace` is a plain `text NOT NULL` column on both tables (pg-raggraph's `PGRG_NAMESPACE`, pgkg's namespaces) — e.g. `default`, `homelab-docs`, `notes`. It is the retrieval predicate for both channels. No per-namespace tables, no RLS: this is a single-operator system; introduce RLS only if a second principal ever appears.

### D10. Deletion and versioning semantics

- **Unchanged re-ingest** (`content_hash` matches): no-op, zero re-embeds.
- **Changed document**: `version++`, re-chunk; new chunks embed; chunks absent from the new version get `valid_to = now()` (reclaimed later, not deleted).
- **Delete**: set `document.deleted_at` — a tombstone that hides every chunk immediately via the D8 live-join; hard delete (chunk rows + raw object) is a GC job on a separate clock, ≥ 7 days later (pgkg's two-clock reclamation).
- **Embedding model change**: backfill re-embed under the new `embedding_model`; serve one model at a time in phase one.

### D11. Entity/edge model and graph timing — decided now, built later

If and when evals trigger graph work (D12), it uses **relational tables and recursive CTEs, not a graph extension**: `entity(id, namespace, label, key)`, `entity_edge(src, dst, edge_type, source_chunk_id)`, `chunk_entity(chunk_id, entity_id)`, traversed with `WITH RECURSIVE`. Rationale: pg-raggraph's engine-isolated bake-off has recursive CTEs at sub-millisecond p50 through 3 hops vs AGE's 33–132 ms (670 ms p95), AGE needs `shared_preload_libraries` and a fork-specific Cypher subset, and Probe hit the same wall (AGE unavailable on its managed platform). These tables map 1:1 onto Postgres 19 SQL/PGQ property graphs if that ever becomes worth using. Nothing graph-shaped is built before the eval gap exists.

### D12. Evaluation strategy

Reuse `apps/knowledge/eval/` unchanged in shape: committed corpus (`knowledge-eval-corpus-v1`), metrics Recall@5 / MRR@5 / citation accuracy / no-answer correctness, thresholds in `eval/thresholds.ts` as CI gates, run provenance via `eval/run-meta.ts`. Evolution:

- #60/#62 land as real channels under the same harness; the eval-local scorers in `eval/rank.ts` stay as independent cross-checks.
- Before any graph/extraction work (D1/D11): bump the corpus to v2 with a **multi-hop query class** whose recall failure is the documented trigger.
- Corpus changes bump the dataset version; thresholds only ever rise.

### D13. The first useful `/search` path — one agent-owned PR

`POST /search {query, namespace?, k}`: embed query → BM25 top-100 + vector top-100 → `src/fusion.ts` → cited chunks (D8). Plus `POST /documents` for manual ingest of the seed corpus. Explicitly **not** in that PR: queue worker, GC job, graph, reranker, auth. That is one migration, two channel queries, one HTTP surface, and a green `--subset` eval — small enough for a single agent PR.

### D14. Implementation map (dependency order)

| # | Deliverable | Depends on | Notes |
| --- | --- | --- | --- |
| 1 | K-schema: DDL + migrations, `KNOWLEDGE_SCHEMA_VERSION` bump | — | unblocks #60/#62 |
| 2 | K-ingest: extract → chunk → embed → upsert + raw-object write + `ingest_job` queue | 1 | D4–D6, D10 |
| 3a | #60 pg_textsearch BM25 channel | 1 | D7; separate CNPG image with the extension |
| 3b | #62 pgvector channel | 1 | D7; parallel with 3a |
| 4 | K-search: `/search` + `/documents` HTTP surface (the D13 PR) | 3a + 3b | fuses via `src/fusion.ts` |
| 5 | K-eval: harness against real DB channels | 4 | D12; keep eval-local scorers |
| 6 | K-lifecycle: tombstone API + GC job + re-embed backfill | 2 | D10 |
| 7 | K-graph (gated): entity/edge tables + recursive-CTE channel + corpus v2 | 5 shows multi-hop gap | D11 |

## Consequences

- +1 Postgres cluster with `pgvector` and `pg_textsearch` (CNPG, `shared_preload_libraries`) — the ops cost ADR-001's "no extensions" rule pushed out of the factory DB lands here, isolated.
- Chunks-only means no entity or multi-hop answers on day one — accepted by design; D12's eval gate, not enthusiasm, opens D11.
- 384-d local embeddings trade some recall vs larger models; the harness measures it, and a model swap is a backfill job, not a schema change.
- RRF-only ranking defers cross-encoder cost until evidence demands it.
- The schema, namespaces, deletion, and citation contracts are fixed here so #60 and #62 cannot drift apart; `/search` (D13) is the single integration point they must satisfy.
