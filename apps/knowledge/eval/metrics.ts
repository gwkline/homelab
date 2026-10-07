/** Pure ranking metrics, all computed within a fixed cutoff `k`. */

export interface MetricSet {
  recall: number;
  mrr: number;
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

/**
 * Fraction of top-k chunks whose document is relevant. Weaker than chunk
 * relevance: the right doc with the wrong chunk still counts.
 */
export const citationAccuracyAtK = (
  ranked: string[],
  relevantDocIds: string[],
  docOfChunk: (chunkId: string) => string | undefined,
  k: number
): number => {
  const top = ranked.slice(0, k);
  if (top.length === 0) {
    return 0;
  }
  const wanted = new Set(relevantDocIds);
  let correct = 0;
  for (const chunkId of top) {
    const docId = docOfChunk(chunkId);
    if (docId !== undefined && wanted.has(docId)) {
      correct += 1;
    }
  }
  return correct / top.length;
};

/** An unanswerable query is handled correctly only when the strategy abstains. */
export const noAnswerCorrectness = (returnedCount: number): number =>
  returnedCount === 0 ? 1 : 0;

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
