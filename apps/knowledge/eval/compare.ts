import { performance } from "node:perf_hooks";

import {
  DEFAULT_RRF_K,
  DEFAULT_WINDOW_SIZE,
  fuseReciprocalRank,
} from "../src/fusion.ts";
import type { EvalChunk, EvalCorpusQuery } from "./corpus.ts";
import { docOfChunk } from "./corpus.ts";
import type { EvalQuery } from "./fixtures.ts";
import {
  citationAccuracyAtK,
  meanMetricSet,
  metricsFor,
  noAnswerCorrectness,
} from "./metrics.ts";
import type { MetricSet } from "./metrics.ts";
import { buildBm25Index, channelScores, topIdsAboveThreshold } from "./rank.ts";

/** Eval cutoff: metrics are computed within the top k of each strategy. */
export const EVAL_K = 5;

export const STRATEGIES = ["bm25-only", "vector-only", "fused"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/**
 * Retrieval configuration recorded with every run (#59): the cutoff, the RRF
 * parameters, and the per-channel abstention floors. A channel abstains when
 * its best score does not clear the floor, so unanswerable queries can return
 * nothing instead of a fabricated top hit.
 */
export interface RetrievalConfig {
  k: number;
  rrfK: number;
  windowSize: number;
  abstainBelow: { bm25: number; vector: number };
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  // bm25 floor 0: any real term evidence counts. vector floor 0.2: tuned
  // between hashed-embedding collision noise (<= 0.167 on this corpus) and
  // the weakest true vector match (0.359); revisit when the corpus grows.
  abstainBelow: { bm25: 0, vector: 0.2 },
  k: EVAL_K,
  rrfK: DEFAULT_RRF_K,
  windowSize: DEFAULT_WINDOW_SIZE,
};

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

/**
 * Top-k chunk ids one strategy returns for one corpus query, honoring the
 * per-channel abstention floors. The fused mode abstains only when both
 * channels abstain — fusion reorders candidate lists, it does not rescore.
 */
export const corpusTopKFor = (
  index: ReturnType<typeof buildBm25Index>,
  chunks: EvalChunk[],
  query: EvalCorpusQuery,
  strategy: StrategyName,
  config: RetrievalConfig
): string[] => {
  const { bm25, vector } = channelScores(index, chunks, query);
  const bm25Ids = topIdsAboveThreshold(
    bm25,
    config.k,
    config.abstainBelow.bm25
  );
  const vectorIds = topIdsAboveThreshold(
    vector,
    config.k,
    config.abstainBelow.vector
  );
  if (strategy === "bm25-only") {
    return bm25Ids;
  }
  if (strategy === "vector-only") {
    return vectorIds;
  }
  return fuseReciprocalRank(
    [
      { candidates: bm25Ids, channel: "bm25" },
      { candidates: vectorIds, channel: "vector" },
    ],
    { k: config.rrfK, windowSize: config.windowSize }
  )
    .slice(0, config.k)
    .map((candidate) => candidate.chunkId);
};

/** Per-query outcome of one strategy on the corpus. */
export interface CorpusQueryResult {
  queryId: string;
  /** Top-k chunk ids actually returned (empty when the strategy abstained). */
  returned: string[];
  abstained: boolean;
  metrics: MetricSet;
  citationAccuracy: number;
  latencyMs: number;
}

/** Per-strategy aggregate over the corpus. */
export interface CorpusStrategyReport {
  strategy: StrategyName;
  /** recall/MRR/precision@k averaged over answerable queries only. */
  aggregate: MetricSet;
  /** Citation accuracy averaged over answerable queries only. */
  citationAccuracy: number;
  /** Fraction of unanswerable queries where the strategy abstained. */
  noAnswerCorrectRate: number;
  latencyMs: { mean: number; max: number };
  perQuery: Record<string, CorpusQueryResult>;
}

export interface CorpusReport {
  k: number;
  retrievalConfig: RetrievalConfig;
  strategies: CorpusStrategyReport[];
}

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Compare BM25-only, vector-only, and fused retrieval over the committed
 * corpus (#59). Metrics aggregate over answerable queries; unanswerable
 * queries feed `noAnswerCorrectRate` instead. Latency is wall time around
 * the full rank+ fuse work per query — informational, never thresholded.
 */
export const runCorpusEval = (
  chunks: EvalChunk[],
  queries: EvalCorpusQuery[],
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
): CorpusReport => {
  const index = buildBm25Index(chunks);
  const strategies: CorpusStrategyReport[] = [];
  for (const strategy of STRATEGIES) {
    const perQuery: Record<string, CorpusQueryResult> = {};
    const answerableMetrics: MetricSet[] = [];
    const answerableCitations: number[] = [];
    const noAnswerCorrect: number[] = [];
    let totalLatency = 0;
    let maxLatency = 0;
    for (const query of queries) {
      const started = performance.now();
      const returned = corpusTopKFor(index, chunks, query, strategy, config);
      const latencyMs = performance.now() - started;
      totalLatency += latencyMs;
      if (latencyMs > maxLatency) {
        maxLatency = latencyMs;
      }
      const metrics = query.answerable
        ? metricsFor(returned, query.relevantChunks, config.k)
        : { mrr: 0, precision: 0, recall: 0 };
      const citation = query.answerable
        ? citationAccuracyAtK(
            returned,
            query.relevantDocs,
            (chunkId) => docOfChunk.get(chunkId),
            config.k
          )
        : 0;
      if (query.answerable) {
        answerableMetrics.push(metrics);
        answerableCitations.push(citation);
      } else {
        noAnswerCorrect.push(noAnswerCorrectness(returned.length));
      }
      perQuery[query.id] = {
        abstained: returned.length === 0,
        citationAccuracy: citation,
        latencyMs,
        metrics,
        queryId: query.id,
        returned,
      };
    }
    const meanLatency =
      queries.length === 0 ? 0 : totalLatency / queries.length;
    strategies.push({
      aggregate: meanMetricSet(answerableMetrics),
      citationAccuracy: mean(answerableCitations),
      latencyMs: {
        max: maxLatency,
        mean: meanLatency,
      },
      noAnswerCorrectRate: mean(noAnswerCorrect),
      perQuery,
      strategy,
    });
  }
  return { k: config.k, retrievalConfig: config, strategies };
};

export const corpusStrategyReport = (
  report: CorpusReport,
  strategy: StrategyName
): CorpusStrategyReport => {
  const found = report.strategies.find((s) => s.strategy === strategy);
  if (!found) {
    throw new Error(`eval: missing corpus report for strategy "${strategy}"`);
  }
  return found;
};
