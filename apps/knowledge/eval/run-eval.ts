import { writeFileSync } from "node:fs";

import {
  compareChannels,
  DEFAULT_RETRIEVAL_CONFIG,
  runCorpusEval,
} from "./compare.ts";
import type { ComparisonReport, CorpusReport } from "./compare.ts";
import {
  CI_SUBSET_QUERY_IDS,
  EVAL_CHUNKS,
  EVAL_CORPUS_QUERIES,
} from "./corpus.ts";
import { EVAL_FIXTURES } from "./fixtures.ts";
import { collectRunMetadata } from "./run-meta.ts";
import type { EvalRunMetadata } from "./run-meta.ts";
import { EVAL_THRESHOLDS, evaluateThresholds } from "./thresholds.ts";
import type { ThresholdFailure } from "./thresholds.ts";

/**
 * One-command retrieval eval (#59): compares BM25-only, vector-only, and
 * fused modes over the committed corpus and the fusion fixtures, records run
 * provenance, and gates on documented thresholds.
 *
 *   npm run eval                 human-readable summary, full dataset
 *   npm run eval -- --json       machine-readable JSON on stdout
 *   npm run eval -- --subset     cheap deterministic CI subset
 *   npm run eval -- --out f.json also write the JSON run record to a file
 *
 * Exit code 0 only when the threshold gate passes, so CI can block regressions.
 */

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const useSubset = args.includes("--subset");
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? undefined : args[outIndex + 1];

const corpusQueries = useSubset
  ? EVAL_CORPUS_QUERIES.filter((query) =>
      CI_SUBSET_QUERY_IDS.includes(query.id)
    )
  : EVAL_CORPUS_QUERIES;

const corpusReport = runCorpusEval(
  EVAL_CHUNKS,
  corpusQueries,
  DEFAULT_RETRIEVAL_CONFIG
);
const fixtureReport = compareChannels(
  EVAL_FIXTURES,
  DEFAULT_RETRIEVAL_CONFIG.k
);
const gate = evaluateThresholds(corpusReport, fixtureReport);
const metadata = collectRunMetadata(
  DEFAULT_RETRIEVAL_CONFIG,
  useSubset ? "ci" : "full"
);

export interface EvalRun {
  /** Version of this JSON shape itself. */
  schema: "retrieval-eval-v1";
  metadata: EvalRunMetadata;
  thresholds: typeof EVAL_THRESHOLDS;
  corpus: CorpusReport;
  fixtures: ComparisonReport;
  thresholdPassed: boolean;
  thresholdFailures: ThresholdFailure[];
}

const buildRun = (): EvalRun => ({
  corpus: corpusReport,
  fixtures: fixtureReport,
  metadata,
  schema: "retrieval-eval-v1",
  thresholdFailures: gate.failures,
  thresholdPassed: gate.passed,
  thresholds: EVAL_THRESHOLDS,
});

const row = (left: string, columns: string[], widths: number[]): string =>
  [
    left.padEnd(widths[0] ?? 0),
    ...columns.map((c, i) => c.padStart(widths[i + 1] ?? 0)),
  ].join("");

const printHuman = (run: EvalRun): void => {
  const m = run.metadata;
  console.log("retrieval eval (#59) — corpus + fixtures");
  console.log(
    `git ${m.gitSha}${m.gitDirty ? " (dirty)" : ""} | schema ${m.schemaVersion} | embedding ${m.embeddingModel} | chunker ${m.chunkerVersion} | dataset ${m.datasetVersion} | subset ${m.subset}`
  );
  console.log(
    `config: k=${m.retrievalConfig.k} rrfK=${m.retrievalConfig.rrfK} window=${m.retrievalConfig.windowSize} abstainBelow(bm25=${m.retrievalConfig.abstainBelow.bm25}, vector=${m.retrievalConfig.abstainBelow.vector})`
  );
  console.log("");
  console.log(
    "corpus (top-k over committed chunks; aggregates over answerable queries):"
  );
  console.log(
    row(
      "strategy",
      ["recall", "mrr", "p", "citation", "no-answer", "latency ms"],
      [12, 8, 7, 8, 10, 11, 12]
    )
  );
  for (const strategy of run.corpus.strategies) {
    console.log(
      row(
        strategy.strategy,
        [
          strategy.aggregate.recall.toFixed(3),
          strategy.aggregate.mrr.toFixed(3),
          strategy.aggregate.precision.toFixed(3),
          strategy.citationAccuracy.toFixed(3),
          strategy.noAnswerCorrectRate.toFixed(3),
          strategy.latencyMs.mean.toFixed(2),
        ],
        [12, 8, 7, 8, 10, 11, 12]
      )
    );
  }
  console.log("");
  console.log(
    `fixtures (fusion scenarios, top-${run.fixtures.k}) — per-query metrics:`
  );
  const fixtureHeader = ["query / strategy", "recall", "mrr", "p"];
  console.log(
    row(fixtureHeader[0] ?? "", fixtureHeader.slice(1), [34, 9, 7, 7])
  );
  for (const strategy of run.fixtures.strategies) {
    for (const [queryId, metrics] of Object.entries(strategy.perQuery)) {
      console.log(
        row(
          `${queryId}  ${strategy.strategy}`,
          [
            metrics.recall.toFixed(3),
            metrics.mrr.toFixed(3),
            metrics.precision.toFixed(3),
          ],
          [34, 9, 7, 7]
        )
      );
    }
    console.log(
      row(
        `AGGREGATE  ${strategy.strategy}`,
        [
          strategy.aggregate.recall.toFixed(3),
          strategy.aggregate.mrr.toFixed(3),
          strategy.aggregate.precision.toFixed(3),
        ],
        [34, 9, 7, 7]
      )
    );
    console.log("");
  }
  console.log(
    `threshold gate: ${run.thresholdPassed ? "PASS" : "FAIL"} (floors: corpus recall>=${EVAL_THRESHOLDS.corpus.recallAtK}, mrr>=${EVAL_THRESHOLDS.corpus.mrrAtK}, no-answer>=${EVAL_THRESHOLDS.corpus.noAnswerCorrectRate}; fixtures recall>=${EVAL_THRESHOLDS.fixtures.recallAtK}, mrr>=${EVAL_THRESHOLDS.fixtures.mrrAtK})`
  );
  for (const failure of run.thresholdFailures) {
    console.log(
      `  FAIL ${failure.scope}: ${failure.check} = ${failure.actual.toFixed(3)} < required ${failure.required}`
    );
  }
  console.log(
    "Note: heavier reranking (cross-encoder, LLM listwise) stays deferred — " +
      "revisit only if this harness shows fused retrieval lagging a single " +
      "channel on real retriever output (#63)."
  );
};

const run = buildRun();

if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`);
}

if (asJson) {
  console.log(JSON.stringify(run, null, 2));
} else {
  printHuman(run);
}

process.exitCode = run.thresholdPassed ? 0 : 1;
