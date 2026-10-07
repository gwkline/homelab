# ADR-008: Knowledge graph expansion — gated on failing-retrieval evidence

**Status:** Proposed — not started **Deciders:** Gavin Kline **Depends on:** a labeled multi-hop subset in the eval harness (`apps/knowledge/eval`) and the hybrid BM25 + vector + RRF baseline ([ADR-002](adr-002-knowledge-retrieval-architecture.md))

## Context

The knowledge system ships hybrid BM25 + vector retrieval. A knowledge graph (entities, relations, traversal) adds extraction passes, schema, slower ingestion, and harder deletion. We pay that only for measured multi-hop failures that chunking and embedding changes cannot fix. This ADR fixes the evaluation contract, the design, and the ship/reject rule so the decision is mechanical once numbers exist.

## Decisions

### D1. Failing subset and target, defined before any graph code

- Label a multi-hop subset of ≥ 20 queries whose facts span ≥ 2 documents and need entity linking or relation traversal. Record each failure mode (`entity-link`, `relation-hop`, `chunking`, `embedding`, `other`); only the first two count.
- Pre-registered target, frozen in the harness config before the first graph run: **≥ 20 pp Recall@10 on the subset, ≤ 2 pp regression on the full suite, MRR non-inferior.**

### D2. Comparison ladder (same harness, one mode flag per rung)

| Rung | Retrieval |
| --- | --- |
| 0 | chunks-only hybrid (baseline) |
| 1 | + proposition extraction, ranked alongside chunks |
| 2 | + named entities: canonicalize, expand queries with names/aliases; no edges |
| 3 | + relational edges: 1–2 hop traversal, candidates unioned with rung 0 |

Every rung records git SHA, schema version, extraction prompt version, and dataset version.

### D3. Entity semantics

- **Canonicalization:** `entity.norm_key = lower(trim(name)) + ':' + type`; aliases in `entity_alias` with a unique `norm_alias`. Extraction links to an existing match before creating.
- **Confidence:** stored per row; below `min_confidence` (0.70) it is kept but excluded from retrieval.
- **Provenance:** every entity mention and edge references `(chunk_id, char_start, char_end)`; a hit with no resolvable chunk is dropped.
- **Supersession:** re-extraction inserts rows with `supersedes_id` and marks the old row `superseded_at`; retrieval reads only current rows. Backfills are idempotent per `(doc_id, extractor_version)`.
- **Deletion:** `deleted_at` tombstones cascade from the document; a vacuum job purges rows whose chunk is gone.

### D4. Plain relational tables — no graph DB, no new extension

```sql
entity(id, canonical_name, type, norm_key UNIQUE, confidence, status,
       supersedes_id, superseded_at, deleted_at, created_at)
entity_alias(id, entity_id FK, alias, norm_alias UNIQUE)
chunk_mention(id, chunk_id FK, entity_id FK, char_start, char_end,
              confidence, extractor_version, supersedes_id, deleted_at)
edge(id, src_entity_id FK, dst_entity_id FK, relation, confidence,
     chunk_id FK, extractor_version, supersedes_id, superseded_at, deleted_at)
```

Indexes on both edge endpoints, `edge.relation`, and both `chunk_mention` FKs. Traversal is a recursive CTE capped at depth 2. Graph candidates compete under the same fused score, tagged `via: 'graph:<path>'`.

### D5. Budgets

- Extraction cost per 1k chunks (calls, tokens, wall-clock, $), measured per rung.
- Query latency: ≤ 150 ms p95 added over the baseline, same hardware.
- Reprocessing runs through the ingest queue as version-tagged, resumable, changed-chunks-only backfills that never block serving.

### D6. Citations

Graph results resolve edge → chunk → document and return the same citation payload as hybrid results. No citation, no result.

### D7. Ship/reject rule

Ship rung 3 only if one harness run shows: the D1 target met, full-suite regression ≤ 2 pp with MRR non-inferior, D5 budgets met, and no citation-accuracy loss on the subset. Otherwise set Status to `Rejected (evidence: <run id>)` with the numbers and dominant failure modes. Rungs 1 and 2 must each earn their complexity the same way.

## Consequences

- No cost now; a later "yes" is additive (four tables and one recursive query on the existing Postgres).
- Pre-registration prevents post-hoc justification; tombstones keep a rejected experiment removable.
- If failures are mostly chunking/embedding, that work takes priority and this ADR closes as rejected.
