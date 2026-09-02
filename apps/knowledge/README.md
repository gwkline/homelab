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

`eval/` compares BM25-only, vector-only, and fused retrieval:

```sh
npm run eval        # in apps/knowledge
```

`eval/fixtures.ts` holds deterministic, hand-labeled channel rankings that model the scenarios fusion must handle (exact identifiers, paraphrases, rescues, disjoint relevance, no-hits) until the real retrievers land; the harness (`eval/compare.ts`) consumes any `EvalQuery[]`, so real retriever output drops in without changes. Metrics: recall@k, MRR@k, precision@k (`eval/metrics.ts`), cutoff `k = 5`.

Unit tests in `tests/` cover the fusion scenarios (disjoint lists, identical lists, ties, short lists, missing channels) and assert the fixture-level comparison outcomes.

## Deferred

Heavier reranking (cross-encoder, LLM listwise) is intentionally out of scope: add it only if this harness shows fused retrieval lagging a single channel on real retriever output.
