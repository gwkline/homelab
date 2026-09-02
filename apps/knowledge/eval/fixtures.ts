/**
 * Deterministic evaluation fixtures for hybrid retrieval (#63).
 *
 * Until #60 (pg_textsearch BM25) and #62 (pgvector) ship real retrievers,
 * each fixture query carries hand-written per-channel rankings that model a
 * documented retrieval scenario. Rankings are chunk-id lists, best first; the
 * ids refer to homelab-docs chunks. Real retrievers replace `channels` without
 * touching the harness.
 */

export interface EvalQuery {
  id: string;
  /** Query text, for report readability only. */
  query: string;
  /** Chunk ids judged relevant to the query. */
  relevant: string[];
  /** Per-channel candidate rankings, best first. */
  channels: {
    bm25: string[];
    vector: string[];
  };
}

export const EVAL_FIXTURES: EvalQuery[] = [
  {
    // Rare identifiers: lexical match is unambiguous, embedding drifts to
    // topic neighbors.
    channels: {
      bm25: [
        "chunk-pgtextsearch-guide",
        "chunk-kw-d1",
        "chunk-kw-d2",
        "chunk-kw-d3",
        "chunk-kw-d4",
        "chunk-kw-d5",
      ],
      vector: [
        "chunk-sem-d1",
        "chunk-sem-d2",
        "chunk-sem-d3",
        "chunk-sem-d4",
        "chunk-sem-d5",
        "chunk-sem-d6",
      ],
    },
    id: "q1-keyword-exact",
    query: "pg_textsearch to_bm25query negative scores",
    relevant: ["chunk-pgtextsearch-guide"],
  },
  {
    // Paraphrase: no vocabulary overlap, semantic channel wins.
    channels: {
      bm25: [
        "chunk-kw-d1",
        "chunk-kw-d2",
        "chunk-kw-d3",
        "chunk-kw-d4",
        "chunk-kw-d5",
        "chunk-kw-d6",
      ],
      vector: [
        "chunk-etcd-snapshots",
        "chunk-sem-d1",
        "chunk-sem-d2",
        "chunk-sem-d3",
        "chunk-sem-d4",
        "chunk-sem-d5",
      ],
    },
    id: "q2-semantic-paraphrase",
    query: "how do I save the cluster state and get it back after a crash",
    relevant: ["chunk-etcd-snapshots"],
  },
  {
    // Fusion rescue: the relevant chunk sits just outside each single
    // channel's top-5 but is the only candidate both channels agree on.
    channels: {
      bm25: [
        "chunk-kw-d1",
        "chunk-kw-d2",
        "chunk-kw-d3",
        "chunk-kw-d4",
        "chunk-kw-d5",
        "chunk-tailscale-serve",
      ],
      vector: [
        "chunk-sem-d1",
        "chunk-sem-d2",
        "chunk-sem-d3",
        "chunk-sem-d4",
        "chunk-sem-d5",
        "chunk-tailscale-serve",
      ],
    },
    id: "q3-fusion-rescue",
    query: "tailscale funnel https certificate",
    relevant: ["chunk-tailscale-serve"],
  },
  {
    // Disjoint relevance: each channel is the sole witness for one chunk.
    channels: {
      bm25: [
        "chunk-factory-ledger",
        "chunk-kw-d1",
        "chunk-kw-d2",
        "chunk-kw-d3",
        "chunk-kw-d4",
        "chunk-kw-d5",
      ],
      vector: [
        "chunk-pgvector-hnsw",
        "chunk-sem-d1",
        "chunk-sem-d2",
        "chunk-sem-d3",
        "chunk-sem-d4",
        "chunk-sem-d5",
      ],
    },
    id: "q4-disjoint",
    query: "github issue run ledger",
    relevant: ["chunk-factory-ledger", "chunk-pgvector-hnsw"],
  },
  {
    // Nothing relevant exists in either channel; metrics must be zero, not
    // NaN, for every strategy.
    channels: {
      bm25: [
        "chunk-kw-d1",
        "chunk-kw-d2",
        "chunk-kw-d3",
        "chunk-kw-d4",
        "chunk-kw-d5",
        "chunk-kw-d6",
      ],
      vector: [
        "chunk-sem-d1",
        "chunk-sem-d2",
        "chunk-sem-d3",
        "chunk-sem-d4",
        "chunk-sem-d5",
        "chunk-sem-d6",
      ],
    },
    id: "q5-no-hit",
    query: "quantum entanglement calibration for the rack",
    relevant: ["chunk-quantum-calibration"],
  },
];
