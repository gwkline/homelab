import { execFileSync } from "node:child_process";

import { KNOWLEDGE_SCHEMA_VERSION } from "../src/schema.ts";
import type { RetrievalConfig } from "./compare.ts";
import { DATASET_VERSION } from "./corpus.ts";
import { EMBEDDING_MODEL } from "./rank.ts";

/** Everything that produced a run's numbers; without it runs are not comparable. */
export interface EvalRunMetadata {
  gitSha: string;
  gitDirty: boolean;
  schemaVersion: string;
  embeddingModel: string;
  chunkerVersion: string;
  datasetVersion: string;
  retrievalConfig: RetrievalConfig;
  subset: "ci" | "full";
  generatedAt: string;
}

const gitOutput = (args: string[]): string | null => {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

export const collectRunMetadata = (
  retrievalConfig: RetrievalConfig,
  subset: "ci" | "full"
): EvalRunMetadata => {
  const sha = gitOutput(["rev-parse", "HEAD"]);
  const status = gitOutput(["status", "--porcelain"]);
  return {
    chunkerVersion: "hand-chunked-v1",
    datasetVersion: DATASET_VERSION,
    embeddingModel: EMBEDDING_MODEL,
    generatedAt: new Date().toISOString(),
    gitDirty: status !== null && status.length > 0,
    gitSha: sha ?? "unknown",
    retrievalConfig,
    // Env override for migrations that identify themselves differently.
    schemaVersion:
      process.env.KNOWLEDGE_SCHEMA_VERSION ?? String(KNOWLEDGE_SCHEMA_VERSION),
    subset,
  };
};
