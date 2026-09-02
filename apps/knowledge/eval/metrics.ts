/**
 * Ranking metrics for the retrieval eval harness. Pure functions over ranked
 * chunk ids and relevance judgments; all metrics are computed within a fixed
 * cutoff `k`.
 */

export interface MetricSet {
  /** Fraction of relevant chunks retrieved within the top k. */
  recall: number;
  /** Reciprocal rank of the first relevant chunk in the top k (0 if none). */
  mrr: number;
  /** Relevant chunks in the top k divided by k. */
  precision: number;
}

export const recallAtK = (
  ranked: string[],
  relevant: string[],
  k: number
): number => {
  if (relevant.length === 0) {
    return 0;
  }
  const wanted = new Set(relevant);
  let found = 0;
  for (const chunkId of ranked.slice(0, k)) {
    if (wanted.has(chunkId)) {
      found += 1;
    }
  }
  return found / relevant.length;
};

export const mrrAtK = (
  ranked: string[],
  relevant: string[],
  k: number
): number => {
  const wanted = new Set(relevant);
  for (const [index, chunkId] of ranked.slice(0, k).entries()) {
    if (wanted.has(chunkId)) {
      return 1 / (index + 1);
    }
  }
  return 0;
};

export const precisionAtK = (
  ranked: string[],
  relevant: string[],
  k: number
): number => {
  if (k <= 0) {
    return 0;
  }
  const wanted = new Set(relevant);
  let hits = 0;
  for (const chunkId of ranked.slice(0, k)) {
    if (wanted.has(chunkId)) {
      hits += 1;
    }
  }
  return hits / k;
};

export const metricsFor = (
  ranked: string[],
  relevant: string[],
  k: number
): MetricSet => ({
  mrr: mrrAtK(ranked, relevant, k),
  precision: precisionAtK(ranked, relevant, k),
  recall: recallAtK(ranked, relevant, k),
});

export const meanMetricSet = (sets: MetricSet[]): MetricSet => {
  if (sets.length === 0) {
    return { mrr: 0, precision: 0, recall: 0 };
  }
  const sum = { mrr: 0, precision: 0, recall: 0 };
  for (const set of sets) {
    sum.mrr += set.mrr;
    sum.precision += set.precision;
    sum.recall += set.recall;
  }
  const n = sets.length;
  return {
    mrr: sum.mrr / n,
    precision: sum.precision / n,
    recall: sum.recall / n,
  };
};
