import { execFileSync } from "node:child_process";

import type { RetrievalConfig } from "./compare.ts";
import { DATASET_VERSION } from "./corpus.ts";
import { EMBEDDING_MODEL } from "./rank.ts";

/**
 * Provenance block recorded with every eval run (#59): each run must say
 * exactly what code, schema, models, chunking, configuration, and dataset
 * produced its numbers, or the numbers cannot be compared over time.
 */
export interface EvalRunMetadata {
  /** Commit the eval ran against; "unknown" when git is unavailable. */
  gitSha: string;
  /** True when the working tree had uncommitted changes at run time. */
  gitDirty: boolean;
  /** Database schema/migration version the retrievers run against. */
  schemaVersion: string;
  /** Model behind the vector channel. */
  embeddingModel: string;
  /** Version of the chunking that produced the corpus. */
  chunkerVersion: string;
  /** Version of the committed corpus and its labels. */
  datasetVersion: string;
  /** Cutoff, RRF parameters, and abstention floors used by this run. */
  retrievalConfig: RetrievalConfig;
  /** "full" or the cheap deterministic CI subset. */
  subset: "ci" | "full";
  /** RFC 3339 timestamp of the run. */
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
    // No migrations exist yet; the field is present from day one so run
    // records stay comparable once #62/#60 introduce a real schema version.
    schemaVersion: process.env.KNOWLEDGE_SCHEMA_VERSION ?? "0-pre-migrations",
    subset,
  };
};
