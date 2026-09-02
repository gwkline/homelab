import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareChannels,
  corpusTopKFor,
  corpusStrategyReport,
  DEFAULT_RETRIEVAL_CONFIG,
  runCorpusEval,
  strategyReport,
  topKFor,
} from "../eval/compare.ts";
import type { StrategyName } from "../eval/compare.ts";
import {
  CI_SUBSET_QUERY_IDS,
  corpusQueryById,
  DATASET_VERSION,
  EVAL_CHUNKS,
  EVAL_CORPUS_QUERIES,
} from "../eval/corpus.ts";
import { EVAL_FIXTURES } from "../eval/fixtures.ts";
import {
  citationAccuracyAtK,
  meanMetricSet,
  mrrAtK,
  noAnswerCorrectness,
  precisionAtK,
  recallAtK,
} from "../eval/metrics.ts";
import type { MetricSet } from "../eval/metrics.ts";
import {
  buildBm25Index,
  EMBEDDING_MODEL,
  rankBm25,
  rankVector,
  tokenize,
} from "../eval/rank.ts";
import { collectRunMetadata } from "../eval/run-meta.ts";
import { EVAL_THRESHOLDS, evaluateThresholds } from "../eval/thresholds.ts";

const approx = (actual: number, expected: number, epsilon = 1e-9): void => {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `${actual} not within ${epsilon} of ${expected}`
  );
};

const expectMetrics = (actual: MetricSet, expected: MetricSet): void => {
  approx(actual.recall, expected.recall);
  approx(actual.mrr, expected.mrr);
  approx(actual.precision, expected.precision);
};

const report = compareChannels(EVAL_FIXTURES);

const metricsForQuery = (
  strategy: StrategyName,
  queryId: string
): MetricSet => {
  const { perQuery } = strategyReport(report, strategy);
  const { [queryId]: metrics } = perQuery;
  assert.ok(metrics, `no metrics for ${strategy}/${queryId}`);
  return metrics;
};

test("metric functions behave at the edges", () => {
  assert.equal(recallAtK(["a", "b"], ["b", "c"], 5), 0.5);
  assert.equal(mrrAtK(["x", "a"], ["a"], 5), 0.5);
  assert.equal(mrrAtK(["x", "y"], ["a"], 5), 0);
  assert.equal(precisionAtK(["a", "x", "y"], ["a"], 3), 1 / 3);
  assert.equal(recallAtK(["a"], [], 5), 0, "no judgments -> 0, not NaN");
  expectMetrics(meanMetricSet([]), { mrr: 0, precision: 0, recall: 0 });
});

test("rare exact identifier: bm25-only wins, fused keeps the win", () => {
  expectMetrics(metricsForQuery("bm25-only", "q1-keyword-exact"), {
    mrr: 1,
    precision: 0.2,
    recall: 1,
  });
  expectMetrics(metricsForQuery("vector-only", "q1-keyword-exact"), {
    mrr: 0,
    precision: 0,
    recall: 0,
  });
  expectMetrics(metricsForQuery("fused", "q1-keyword-exact"), {
    mrr: 1,
    precision: 0.2,
    recall: 1,
  });
});

test("paraphrase: vector-only wins, fused keeps the win", () => {
  expectMetrics(metricsForQuery("bm25-only", "q2-semantic-paraphrase"), {
    mrr: 0,
    precision: 0,
    recall: 0,
  });
  expectMetrics(metricsForQuery("vector-only", "q2-semantic-paraphrase"), {
    mrr: 1,
    precision: 0.2,
    recall: 1,
  });
  expectMetrics(metricsForQuery("fused", "q2-semantic-paraphrase"), {
    mrr: 1,
    precision: 0.2,
    recall: 1,
  });
});

test("fusion rescue: relevant chunk outside both single-channel top-5s", () => {
  const query = EVAL_FIXTURES.find((q) => q.id === "q3-fusion-rescue");
  assert.ok(query);
  const target = "chunk-tailscale-serve";
  assert.ok(!topKFor(query, "bm25-only", report.k).includes(target));
  assert.ok(!topKFor(query, "vector-only", report.k).includes(target));

  const fusedTop = topKFor(query, "fused", report.k);
  // Two-channel consensus outranks every single-channel distractor; the 1/61
  // ties inside the distractor tail resolve by chunk id.
  assert.deepEqual(fusedTop, [
    "chunk-tailscale-serve",
    "chunk-kw-d1",
    "chunk-sem-d1",
    "chunk-kw-d2",
    "chunk-sem-d2",
  ]);
  expectMetrics(metricsForQuery("fused", "q3-fusion-rescue"), {
    mrr: 1,
    precision: 0.2,
    recall: 1,
  });
});

test("disjoint relevance: fused retrieves what each single channel alone gets", () => {
  expectMetrics(metricsForQuery("bm25-only", "q4-disjoint"), {
    mrr: 1,
    precision: 0.2,
    recall: 0.5,
  });
  expectMetrics(metricsForQuery("vector-only", "q4-disjoint"), {
    mrr: 1,
    precision: 0.2,
    recall: 0.5,
  });
  expectMetrics(metricsForQuery("fused", "q4-disjoint"), {
    mrr: 1,
    precision: 0.4,
    recall: 1,
  });
});

test("no relevant chunk anywhere: zero metrics, never NaN", () => {
  for (const strategy of ["bm25-only", "vector-only", "fused"] as const) {
    expectMetrics(metricsForQuery(strategy, "q5-no-hit"), {
      mrr: 0,
      precision: 0,
      recall: 0,
    });
  }
});

test("aggregate comparison favors fused retrieval on the fixtures", () => {
  const bm25 = strategyReport(report, "bm25-only").aggregate;
  const vector = strategyReport(report, "vector-only").aggregate;
  const fused = strategyReport(report, "fused").aggregate;

  expectMetrics(bm25, { mrr: 0.4, precision: 0.08, recall: 0.3 });
  expectMetrics(vector, { mrr: 0.4, precision: 0.08, recall: 0.3 });
  expectMetrics(fused, { mrr: 0.8, precision: 0.2, recall: 0.8 });

  assert.ok(fused.recall >= bm25.recall && fused.recall >= vector.recall);
  assert.ok(fused.mrr >= bm25.mrr && fused.mrr >= vector.mrr);
  assert.ok(
    fused.precision >= bm25.precision && fused.precision >= vector.precision
  );
});

// --- corpus harness (#59) ---

const corpusReport = runCorpusEval(EVAL_CHUNKS, EVAL_CORPUS_QUERIES);
const answerableQueries = EVAL_CORPUS_QUERIES.filter((q) => q.answerable);
const noAnswerQueries = EVAL_CORPUS_QUERIES.filter((q) => !q.answerable);
const bm25Index = buildBm25Index(EVAL_CHUNKS);

const docOfTestChunk = (chunkId: string): string | undefined =>
  ({ good: "doc-a", known: "doc-b" })[chunkId];

test("tokenizer lowercases, splits punctuation, and drops stopwords", () => {
  assert.deepEqual(tokenize("The Quick-Brown fox, for THE rack!"), [
    "quick",
    "brown",
    "fox",
    "rack",
  ]);
});

test("corpus rankers are deterministic and put a relevant chunk first", () => {
  for (const query of answerableQueries) {
    assert.ok(query.relevantChunks[0], `label for ${query.id}`);
    const bm25 = rankBm25(bm25Index, EVAL_CHUNKS, query.query);
    const vector = rankVector(EVAL_CHUNKS, query.query);
    const bm25Again = rankBm25(bm25Index, EVAL_CHUNKS, query.query);
    assert.deepEqual(bm25, bm25Again, `bm25 not deterministic for ${query.id}`);
    assert.equal(bm25[0]?.chunkId, query.relevantChunks[0], `bm25 ${query.id}`);
    assert.equal(
      vector[0]?.chunkId,
      query.relevantChunks[0],
      `vector ${query.id}`
    );
  }
});

test("corpus rankers abstain on unanswerable queries", () => {
  for (const query of noAnswerQueries) {
    assert.deepEqual(
      rankBm25(bm25Index, EVAL_CHUNKS, query.query),
      [],
      `bm25 should abstain on ${query.id}`
    );
    for (const strategy of ["bm25-only", "vector-only", "fused"] as const) {
      assert.deepEqual(
        corpusTopKFor(
          bm25Index,
          EVAL_CHUNKS,
          query,
          strategy,
          DEFAULT_RETRIEVAL_CONFIG
        ),
        [],
        `${strategy} should abstain on ${query.id}`
      );
    }
  }
});

test("citation accuracy counts only correct-source citations", () => {
  assert.equal(
    citationAccuracyAtK(
      ["good", "known", "good"],
      ["doc-a"],
      docOfTestChunk,
      3
    ),
    2 / 3
  );
  assert.equal(
    citationAccuracyAtK(["good"], ["doc-zzz"], docOfTestChunk, 3),
    0,
    "wrong doc is not a correct citation"
  );
  assert.equal(
    citationAccuracyAtK([], ["doc-a"], docOfTestChunk, 3),
    0,
    "no results -> no credit"
  );
});

test("no-answer correctness rewards abstention only", () => {
  assert.equal(noAnswerCorrectness(0), 1);
  assert.equal(noAnswerCorrectness(5), 0);
  assert.equal(noAnswerCorrectness(1), 0);
});

test("corpus eval: every strategy clears the regression gate", () => {
  for (const strategy of ["bm25-only", "vector-only", "fused"] as const) {
    const result = corpusStrategyReport(corpusReport, strategy);
    approx(result.aggregate.recall, 1);
    approx(result.aggregate.mrr, 1);
    assert.ok(result.citationAccuracy > 0, `citation for ${strategy}`);
    assert.equal(
      result.noAnswerCorrectRate,
      1,
      `${strategy} must abstain on every unanswerable query`
    );
    assert.ok(
      result.latencyMs.mean >= 0 &&
        result.latencyMs.max >= result.latencyMs.mean
    );
  }
  const fixtureReport = compareChannels(EVAL_FIXTURES);
  assert.equal(evaluateThresholds(corpusReport, fixtureReport).passed, true);
});

test("corpus eval passes with the cheap deterministic CI subset", () => {
  const subset = EVAL_CORPUS_QUERIES.filter((query) =>
    CI_SUBSET_QUERY_IDS.includes(query.id)
  );
  assert.ok(subset.length > 0 && subset.length < EVAL_CORPUS_QUERIES.length);
  const subsetReport = runCorpusEval(EVAL_CHUNKS, subset);
  const fixtureReport = compareChannels(EVAL_FIXTURES);
  assert.equal(evaluateThresholds(subsetReport, fixtureReport).passed, true);
});

test("threshold gate fails a regressed fused strategy", () => {
  const regressed = {
    ...corpusReport,
    strategies: corpusReport.strategies.map((strategy) =>
      strategy.strategy === "fused"
        ? {
            ...strategy,
            aggregate: { mrr: 0.2, precision: 0, recall: 0.4 },
            noAnswerCorrectRate: 0.5,
          }
        : strategy
    ),
  };
  const fixtureReport = compareChannels(EVAL_FIXTURES);
  const result = evaluateThresholds(regressed, fixtureReport);
  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 3, "recall, mrr, and no-answer all drop");
});

test("thresholds and floors are recorded, not implicit", () => {
  assert.equal(EVAL_THRESHOLDS.corpus.recallAtK, 0.9);
  assert.equal(EVAL_THRESHOLDS.corpus.mrrAtK, 0.8);
  assert.equal(EVAL_THRESHOLDS.corpus.noAnswerCorrectRate, 1);
  assert.equal(EVAL_THRESHOLDS.fixtures.recallAtK, 0.8);
  assert.equal(EVAL_THRESHOLDS.fixtures.mrrAtK, 0.8);
});

test("run metadata records provenance for every run", () => {
  const metadata = collectRunMetadata(DEFAULT_RETRIEVAL_CONFIG, "ci");
  assert.equal(metadata.datasetVersion, DATASET_VERSION);
  assert.equal(metadata.embeddingModel, EMBEDDING_MODEL);
  assert.equal(metadata.chunkerVersion, "hand-chunked-v1");
  assert.equal(metadata.subset, "ci");
  assert.equal(metadata.retrievalConfig, DEFAULT_RETRIEVAL_CONFIG);
  assert.match(metadata.gitSha, /^[0-9a-f]{40}$|^unknown$/u);
  assert.equal(typeof metadata.gitDirty, "boolean");
  assert.ok(metadata.schemaVersion.length > 0);
  assert.ok(metadata.generatedAt.length > 0);
  // Every labeled query must be answerable or explicitly unanswerable.
  for (const query of EVAL_CORPUS_QUERIES) {
    const found = corpusQueryById(query.id);
    assert.ok(found, `${query.id} resolvable`);
    assert.equal(found.answerable, query.relevantChunks.length > 0);
  }
});
