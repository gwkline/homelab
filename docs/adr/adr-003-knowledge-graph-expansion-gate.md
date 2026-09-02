# ADR-003: Knowledge graph expansion — gated on failing-retrieval evidence

**Status:** Proposed — gate open, not started (2026-09-02) **Deciders:** Gavin Kline **Implements:** #66 · **Depends on:** #59 (versioned eval harness + labeled multi-hop subset), #63 (RRF hybrid baseline)

## Context

The knowledge system (#56–#67) ships a hybrid BM25 + vector pipeline first. A knowledge graph (entities, relations, traversal) is a large add: new extraction passes, new schema, slower ingestion, and harder deletion semantics. We will not pay that cost on speculation — only measured multi-hop failures that chunking/embedding improvements cannot fix justify it.

Entry gate (from #66): **no implementation until #59 lands a labeled multi-hop subset and #63 lands a hybrid baseline.** This ADR fixes the evaluation contract, the design we would build, and the ship/reject rule so the decision is mechanical once numbers exist.

## Decisions

### D1. Failing subset and target improvement are defined before any graph code

- From the #59 corpus, label a **multi-hop subset** of ≥ 20 queries whose relevant facts span ≥ 2 documents and require entity linking or relation traversal — manually verified that failures are *linking* failures, not chunking or embedding failures (e.g., the needed chunk is returned but ranked below k, versus never retrieved because the answer needs fact A from doc 1 joined to fact B in doc 2).
- Record per-query failure mode (`entity-link`, `relation-hop`, `chunking`, `embedding`, `other`) in the harness dataset. Only `entity-link`/`relation-hop` failures count toward justification.
- Pre-register the target: **≥ 20 pp Recall@10 lift on the multi-hop subset, no regression > 2 pp on the full suite, MRR non-inferior**. Numbers are frozen in the harness config before the first graph run; moving them afterwards voids the comparison.

### D2. Comparison ladder — same harness, one command per rung

| Rung | Retrieval | Notes |
| --- | --- | --- |
| 0 | chunks-only hybrid (BM25 + vector + RRF from #63) | baseline |
| 1 | + proposition extraction | decompose chunks into atomic propositions, embed/rank them alongside chunks; no graph |
| 2 | + named-entity-only | extract + canonicalize entities, expand queries with entity names/aliases; no edges |
| 3 | + relational edges (this ADR) | 1–2 hop traversal over edge table, candidates unioned with rung 0 |

Each rung is a harness mode flag reusing #59's runner; every rung must record the #59 metadata block (Git SHA, schema version, extraction prompt version, dataset version).

### D3. Entity semantics (designed now, built only if D-gate passes)

- **Canonicalization:** `entity(canonical_name, type, norm_key)` where `norm_key = lower(trim(canonical_name)) + ':' + type`; aliases live in `entity_alias(entity_id, alias, norm_alias)` with a UNIQUE index on `norm_alias`. Extraction may only create an entity if no alias/norm_key matches — otherwise it links to the existing canonical row.
- **Confidence:** every extraction carries `confidence numeric(3,2)` from the extractor; below `min_confidence` (default 0.70, per-run config) the entity/edge is stored but excluded from retrieval.
- **Provenance:** entities and edges never float free — every edge row and every entity→mention link references `(chunk_id, char_start, char_end)` in the source document. A graph hit with no resolvable chunk is discarded at query time.
- **Supersession:** extraction is versioned (`extractor_version`). Re-extraction never mutates rows in place: new rows carry `supersedes_id` pointing at the row they replace, and the old row is marked `superseded_at`. Retrieval reads only non-superseded rows. This keeps an audit trail and makes backfills idempotent per `(doc_id, extractor_version)`.
- **Deletion:** soft delete only — `deleted_at` tombstone on entities/edges/mentions. Chunks referenced by mentions cannot be hard-deleted; doc deletion tombstones the doc and cascades tombstones, and a later vacuum job purges tombstoned rows whose chunk is gone. Recomputing derived rows (aliases, edges) after any bulk operation is the reprocessor's job (D5), never an inline cascade.

### D4. Edges are plain relational tables — no graph DB, no new extension

```sql
entity(id, canonical_name, type, norm_key UNIQUE, confidence, status,
       supersedes_id, superseded_at, deleted_at, created_at)
entity_alias(id, entity_id FK, alias, norm_alias UNIQUE)
chunk_mention(id, chunk_id FK, entity_id FK, char_start, char_end,
              confidence, extractor_version, supersedes_id, deleted_at)
edge(id, src_entity_id FK, dst_entity_id FK, relation, confidence,
     chunk_id FK, extractor_version, supersedes_id, superseded_at, deleted_at)
```

- Indexes: `edge(src_entity_id)`, `edge(dst_entity_id)`, `edge(relation)`, `chunk_mention(entity_id)`, `chunk_mention(chunk_id)`.
- Traversal is a **recursive CTE limited to depth ≤ 2** (`WHERE depth < 2` inside the recursive term) — deep traversal is not a homelab use case and unbounded recursion is a footgun.
- Candidate expansion unions 1–2 hop neighbor chunks with the hybrid ranking from #63; graph-derived candidates compete under the same fused score and are marked `via: 'graph:<path>'` in result metadata for debugging.

### D5. Cost, latency, and reprocessing are measured before the gate closes

- **Extraction cost:** per 1k chunks — LLM calls, tokens, wall-clock, and $, captured by the extraction job and reported by the harness. Proposition (rung 1) and entity (rung 2/3) passes are measured separately so their marginal costs are attributable.
- **Query latency:** graph expansion may add **≤ 150 ms p95** over the hybrid baseline; measured in-harness on the same hardware.
- **Reprocessing:** extraction runs through the existing ingestion queue (#58) as version-tagged backfill jobs — changed chunks only (content-hash diff), resumable, rate-limited. A full-corpus re-extract must complete without blocking serving, since retrieval reads only non-superseded committed rows.

### D6. Citations are mandatory through graph expansion

Graph-expanded results resolve to the `chunk_id` provenance chain (edge → chunk → document) and return the **same citation payload** (source path, doc id, char spans) as plain hybrid results. Any expansion path that cannot produce a chunk citation is dropped from candidates. No citation, no result.

### D7. Ship/reject rule (the gate)

Ship rung 3 only if **all** hold on one harness run:

1. Multi-hop subset Recall@10 improves ≥ the D1 target;
2. Full-suite regression ≤ 2 pp and MRR non-inferior;
3. Added ingestion cost and query latency within D5 budgets;
4. Citation accuracy on the multi-hop subset does not degrade.

Otherwise **record the rejection** here: flip Status to `Rejected (evidence: <harness run id>)` with the numbers and the dominant failure modes, and keep rung 0/1/2 as the shipped system. The same rule applies to rungs 1 and 2 individually — each must earn its own complexity.

## Consequences

- Zero code, schema, or ingestion cost now; the gate is enforced by this ADR, and the extraction work is blocked until #59/#63 deliver the measuring stick.
- The D3/D4 design means a later "yes" is additive: two tables + a mention table + one recursive-CTE query on the existing Postgres, no graph engine, no new service.
- The pre-registered target prevents post-hoc justification; the versioned-supersession design keeps any rejected experiment's data cleanly removable (`deleted_at` + vacuum) rather than entangled.
- If the multi-hop failures turn out to be dominated by chunking/embedding modes, #57/#62/#63 work takes priority and this ADR closes as rejected without spending extraction budget.
