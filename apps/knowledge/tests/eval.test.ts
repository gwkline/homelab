import assert from "node:assert/strict";
import { test } from "node:test";

import { compareChannels, strategyReport, topKFor } from "../eval/compare.ts";
import type { StrategyName } from "../eval/compare.ts";
import { EVAL_FIXTURES } from "../eval/fixtures.ts";
import {
  meanMetricSet,
  mrrAtK,
  precisionAtK,
  recallAtK,
} from "../eval/metrics.ts";
import type { MetricSet } from "../eval/metrics.ts";

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
