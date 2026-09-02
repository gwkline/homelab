import { compareChannels } from "./compare.ts";
import type { ComparisonReport } from "./compare.ts";
import { EVAL_FIXTURES } from "./fixtures.ts";

const row = (left: string, recall: number, mrr: number, precision: number) =>
  `${left.padEnd(34)}${recall.toFixed(3).padStart(9)}${mrr
    .toFixed(3)
    .padStart(7)}${precision.toFixed(3).padStart(7)}`;

const header = `${"query / strategy".padEnd(34)}${"recall".padStart(9)}${"mrr".padStart(7)}${"p".padStart(7)}`;

const printReport = (report: ComparisonReport): void => {
  console.log(`hybrid retrieval eval (top-${report.k}, RRF k=60, window=100)`);
  console.log(
    "fixtures are deterministic stand-ins until #60/#62 ship real retrievers"
  );
  console.log("");
  console.log(header);
  for (const strategy of report.strategies) {
    for (const [queryId, metrics] of Object.entries(strategy.perQuery)) {
      console.log(
        row(
          `${queryId}  ${strategy.strategy}`,
          metrics.recall,
          metrics.mrr,
          metrics.precision
        )
      );
    }
    console.log(
      row(
        `AGGREGATE  ${strategy.strategy}`,
        strategy.aggregate.recall,
        strategy.aggregate.mrr,
        strategy.aggregate.precision
      )
    );
    console.log("");
  }
  console.log(
    "Note: heavier reranking (cross-encoder, LLM listwise) stays deferred — " +
      "revisit only if this harness shows fused retrieval lagging a single " +
      "channel on real retriever output (#63)."
  );
};

printReport(compareChannels(EVAL_FIXTURES));
