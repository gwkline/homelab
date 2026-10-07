import type { EmbeddingReport } from "./store.ts";

/** Chunks the vector channel ignores because another model embedded them. */
export const mismatchedChunks = (report: EmbeddingReport): number =>
  report.storedModels
    .filter((stored) => stored.model !== report.configuredModel)
    .reduce((sum, stored) => sum + stored.chunks, 0);

const labelValue = (value: string): string =>
  value
    .replaceAll("\\", String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`);

/** Prometheus text exposition; the report is null for stores without one. */
export const renderMetrics = (
  vectorSearch: boolean,
  report: EmbeddingReport | null
): string => {
  const lines = [
    "# HELP knowledge_vector_search_enabled 1 when a real embedding model backs the vector channel; 0 serves every search BM25-only.",
    "# TYPE knowledge_vector_search_enabled gauge",
    `knowledge_vector_search_enabled ${vectorSearch ? 1 : 0}`,
  ];
  if (report !== null) {
    lines.push(
      "# HELP knowledge_embedding_model_mismatch_chunks Live embedded chunks whose model differs from the configured query model; the vector channel ignores them until a re-embed.",
      "# TYPE knowledge_embedding_model_mismatch_chunks gauge",
      `knowledge_embedding_model_mismatch_chunks{configured_model="${labelValue(report.configuredModel)}"} ${mismatchedChunks(report)}`
    );
  }
  return `${lines.join("\n")}\n`;
};
