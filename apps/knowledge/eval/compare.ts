import { fuseReciprocalRank } from "../src/fusion.ts";
import type { EvalQuery } from "./fixtures.ts";
import { meanMetricSet, metricsFor } from "./metrics.ts";
import type { MetricSet } from "./metrics.ts";

/** Eval cutoff: metrics are computed within the top k of each strategy. */
export const EVAL_K = 5;

export const STRATEGIES = ["bm25-only", "vector-only", "fused"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/** Top-k chunk ids a strategy returns for one query. */
export const topKFor = (
  query: EvalQuery,
  strategy: StrategyName,
  k: number
): string[] => {
  if (strategy === "bm25-only") {
    return query.channels.bm25.slice(0, k);
  }
  if (strategy === "vector-only") {
    return query.channels.vector.slice(0, k);
  }
  return fuseReciprocalRank([
    { candidates: query.channels.bm25, channel: "bm25" },
    { candidates: query.channels.vector, channel: "vector" },
  ])
    .slice(0, k)
    .map((candidate) => candidate.chunkId);
};

export interface StrategyReport {
  strategy: StrategyName;
  perQuery: Record<string, MetricSet>;
  aggregate: MetricSet;
}

export interface ComparisonReport {
  k: number;
  strategies: StrategyReport[];
}

/** Compare BM25-only, vector-only, and fused retrieval over the fixtures. */
export const compareChannels = (
  queries: EvalQuery[],
  k: number = EVAL_K
): ComparisonReport => {
  const strategies: StrategyReport[] = [];
  for (const strategy of STRATEGIES) {
    const perQuery: Record<string, MetricSet> = {};
    for (const query of queries) {
      perQuery[query.id] = metricsFor(
        topKFor(query, strategy, k),
        query.relevant,
        k
      );
    }
    strategies.push({
      aggregate: meanMetricSet(Object.values(perQuery)),
      perQuery,
      strategy,
    });
  }
  return { k, strategies };
};

export const strategyReport = (
  report: ComparisonReport,
  strategy: StrategyName
): StrategyReport => {
  const found = report.strategies.find((s) => s.strategy === strategy);
  if (!found) {
    throw new Error(`eval: missing report for strategy "${strategy}"`);
  }
  return found;
};
