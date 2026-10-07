import type { ComparisonReport, CorpusReport } from "./compare.ts";
import { corpusStrategyReport, strategyReport } from "./compare.ts";

export interface StrategyThresholds {
  recallAtK: number;
  mrrAtK: number;
  noAnswerCorrectRate: number;
}

export interface EvalThresholds {
  corpus: StrategyThresholds;
  fixtures: { mrrAtK: number; recallAtK: number };
}

/**
 * Floors for the fused strategy, pinned at the current deterministic outcome so
 * any drop fails. Raise a floor when retrieval improves; never lower one to pass.
 * Citation accuracy (corpus-size dependent) and latency are not gated.
 */
export const EVAL_THRESHOLDS: EvalThresholds = {
  corpus: { mrrAtK: 0.8, noAnswerCorrectRate: 1, recallAtK: 0.9 },
  fixtures: { mrrAtK: 0.8, recallAtK: 0.8 },
};

export interface ThresholdFailure {
  scope: string;
  check: string;
  actual: number;
  required: number;
}

export interface ThresholdResult {
  passed: boolean;
  failures: ThresholdFailure[];
}

/** Fused must also not trail either single channel on corpus recall. */
export const evaluateThresholds = (
  corpus: CorpusReport,
  fixtures: ComparisonReport
): ThresholdResult => {
  const failures: ThresholdFailure[] = [];
  const check = (
    scope: string,
    checkName: string,
    actual: number,
    required: number
  ): void => {
    if (actual < required) {
      failures.push({ actual, check: checkName, required, scope });
    }
  };

  const fused = corpusStrategyReport(corpus, "fused");
  check(
    "corpus/fused",
    "recall@k",
    fused.aggregate.recall,
    EVAL_THRESHOLDS.corpus.recallAtK
  );
  check(
    "corpus/fused",
    "mrr@k",
    fused.aggregate.mrr,
    EVAL_THRESHOLDS.corpus.mrrAtK
  );
  check(
    "corpus/fused",
    "no-answer correctness",
    fused.noAnswerCorrectRate,
    EVAL_THRESHOLDS.corpus.noAnswerCorrectRate
  );
  const bm25 = corpusStrategyReport(corpus, "bm25-only");
  const vector = corpusStrategyReport(corpus, "vector-only");
  const bestSingleRecall = Math.max(
    bm25.aggregate.recall,
    vector.aggregate.recall
  );
  check(
    "corpus/fused",
    "recall not behind best single channel",
    fused.aggregate.recall,
    bestSingleRecall
  );

  const fusedFixtures = strategyReport(fixtures, "fused");
  check(
    "fixtures/fused",
    "recall@k",
    fusedFixtures.aggregate.recall,
    EVAL_THRESHOLDS.fixtures.recallAtK
  );
  check(
    "fixtures/fused",
    "mrr@k",
    fusedFixtures.aggregate.mrr,
    EVAL_THRESHOLDS.fixtures.mrrAtK
  );

  return { failures, passed: failures.length === 0 };
};
