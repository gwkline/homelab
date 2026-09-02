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
 * Regression gate (#59), checked against the fused strategy.
 *
 * Floors are pinned at the current deterministic outcome of the committed
 * fixtures and corpus, so any metric drop fails the run. Raise a floor when
 * retrieval genuinely improves; never lower one to make a run pass. Citation
 * accuracy and latency are recorded but deliberately not thresholded here:
 * citation floors depend on corpus size (k=5 over 9 chunks invites filler)
 * and latency is machine-dependent — watch them as trends, not gates.
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

/**
 * Evaluate the gate over one corpus report and one fixture comparison. The
 * fused strategy must clear the metric floors and must not trail either
 * single channel on corpus recall — a fusion that loses to its own inputs is
 * the regression this harness exists to catch.
 */
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
