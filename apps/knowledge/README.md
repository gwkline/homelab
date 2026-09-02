# knowledge

Hybrid retrieval for the homelab knowledge base: fuse keyword (BM25, #60) and semantic (pgvector, #62) candidate lists into one deterministic ranking of cited chunks. No LLM answer generation, no graph expansion — this package ends at ranked chunks with citation-ready metadata.

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

Every run records provenance (`eval/run-meta.ts`): Git SHA + dirty flag, schema/migration version (`KNOWLEDGE_SCHEMA_VERSION`, `0-pre-migrations` until #60/#62 introduce a real schema), embedding model, chunker version, retrieval configuration (k, RRF k, window size, abstention floors), and dataset version. The JSON output shape is versioned (`retrieval-eval-v1`).

### Regression gate

`eval/thresholds.ts` pins floors at the current deterministic outcome: fused corpus Recall@5 ≥ 0.9, MRR@5 ≥ 0.8, no-answer correctness ≥ 1.0, and fused Recall never behind the best single channel; fused fixture Recall/MRR ≥ 0.8. Raise a floor when retrieval genuinely improves; never lower one to make a run pass. Citation accuracy and latency are recorded as trends, not gates (citation floors depend on corpus size; latency is machine-dependent).

### Independence

Channel rankings come from eval-local scorers in `eval/rank.ts`, never from `src/`, so a broken system-side retriever shows up as a metric drop instead of cancelling out against a shared implementation. The fused strategy deliberately exercises the real SUT (`src/fusion.ts`) — the harness measures it, it does not reimplement it.

Unit tests in `tests/` cover the fusion scenarios (disjoint lists, identical lists, ties, short lists, missing channels) and assert the fixture-level comparison outcomes, corpus-level harness behavior (deterministic ranking, abstention on unanswerable queries, citation accuracy, no-answer correctness), and the threshold gate (passes now, fails a regressed fused strategy).

## Deferred

Heavier reranking (cross-encoder, LLM listwise) is intentionally out of scope: add it only if this harness shows fused retrieval lagging a single channel on real retriever output.
