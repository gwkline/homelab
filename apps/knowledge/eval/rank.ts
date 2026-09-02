/**
 * Eval-local channel rankers (#59).
 *
 * These scorers are deliberately independent of `src/`: the harness must not
 * share ranking code with the system under test, or a shared bug cancels out
 * and regressions become invisible. `rank.ts` implements its own tokenizer and
 * two deterministic, offline channels:
 *
 * - `bm25`: a small BM25 (Okapi k1/b) over corpus tokens. Stands in for
 *   pg_textsearch (#60); swap in the real retriever when it lands.
 * - `vector`: feature-hashed bag-of-words with cosine similarity. Order-free
 *   and deterministic without any paid embedding API; a stand-in for pgvector
 *   (#62) that has no synonym knowledge, so paraphrase wins are out of scope
 *   until real embeddings plug in.
 *
 * Both are pure functions of the committed corpus and query text: same input,
 * same output, no network, no clocks.
 */

import type { EvalChunk, EvalCorpusQuery } from "./corpus.ts";

export interface ScoredChunk {
  chunkId: string;
  score: number;
}

export interface Bm25Index {
  /** term -> chunk ids containing it. */
  postings: Map<string, string[]>;
  /** term -> chunk id -> term frequency. */
  termFrequencies: Map<string, Map<string, number>>;
  /** chunk id -> token count. */
  lengths: Map<string, number>;
  averageLength: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Small eval-local stopword list: function words carry no topical evidence and
 * would otherwise let unanswerable queries match on "the"/"for" alone, which
 * is exactly the fabricated-hit behavior the no-answer metric exists to catch.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

export const buildBm25Index = (chunks: EvalChunk[]): Bm25Index => {
  const postings = new Map<string, string[]>();
  const termFrequencies = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let totalLength = 0;
  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    lengths.set(chunk.id, tokens.length);
    totalLength += tokens.length;
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts) {
      const chunkIds = postings.get(token);
      if (chunkIds) {
        chunkIds.push(chunk.id);
      } else {
        postings.set(token, [chunk.id]);
      }
      let byChunk = termFrequencies.get(token);
      if (!byChunk) {
        byChunk = new Map<string, number>();
        termFrequencies.set(token, byChunk);
      }
      byChunk.set(chunk.id, count);
    }
  }
  return {
    averageLength: chunks.length === 0 ? 0 : totalLength / chunks.length,
    lengths,
    postings,
    termFrequencies,
  };
};

/** Okapi BM25 score of one chunk for one query token count map. */
const bm25ChunkScore = (
  index: Bm25Index,
  docCount: number,
  chunkId: string,
  queryTermCounts: Map<string, number>
): number => {
  let score = 0;
  for (const [term, queryCount] of queryTermCounts) {
    const byChunk = index.termFrequencies.get(term);
    const tf = byChunk?.get(chunkId);
    if (tf === undefined) {
      continue;
    }
    const df = index.postings.get(term)?.length ?? 0;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const length = index.lengths.get(chunkId) ?? 0;
    const normalizer =
      tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / index.averageLength);
    score += queryCount * idf * ((tf * (BM25_K1 + 1)) / normalizer);
  }
  return score;
};

/**
 * BM25 channel ranking, best first. Ties break by chunk id ascending so the
 * order is fully determined by the corpus, never by input iteration order.
 */
export const rankBm25 = (
  index: Bm25Index,
  chunks: EvalChunk[],
  query: string
): ScoredChunk[] => {
  const queryTermCounts = new Map<string, number>();
  for (const token of tokenize(query)) {
    queryTermCounts.set(token, (queryTermCounts.get(token) ?? 0) + 1);
  }
  const docCount = chunks.length;
  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const score = bm25ChunkScore(index, docCount, chunk.id, queryTermCounts);
    if (score > 0) {
      scored.push({ chunkId: chunk.id, score });
    }
  }
  return scored.toSorted((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.chunkId < b.chunkId ? -1 : 1;
  });
};

/**
 * Feature-hashed bag-of-words "embedding": each token hashes to one of
 * `EMBEDDING_DIM` buckets with a deterministic sign, tf-weighted, L2-normalized.
 * Deterministic across runs and platforms (integer FNV-1a, no floats in the
 * hash path). Collisions are the known cost; real embeddings replace this.
 */
export const EMBEDDING_DIM = 64;
export const EMBEDDING_MODEL = "hashed-bow-v0-standin";

const hashToken = (token: string): number => {
  // FNV-1a 32-bit: offset basis 2166136261, prime 16777619.
  let hash = 2_166_136_261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.codePointAt(i) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
};

const embed = (text: string): Float64Array => {
  const vector = new Float64Array(EMBEDDING_DIM);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const bucket = hash % EMBEDDING_DIM;
    const sign = (hash & 65_536) === 0 ? -1 : 1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (norm === 0) {
    return vector;
  }
  for (let i = 0; i < EMBEDDING_DIM; i += 1) {
    vector[i] = (vector[i] ?? 0) / norm;
  }
  return vector;
};

/** Cosine similarity of the hashed query and chunk vectors, in [-1, 1]. */
export const rankVector = (
  chunks: EvalChunk[],
  query: string
): ScoredChunk[] => {
  const queryVector = embed(query);
  const scored: ScoredChunk[] = [];
  for (const chunk of chunks) {
    const chunkVector = embed(chunk.text);
    let dot = 0;
    for (let i = 0; i < EMBEDDING_DIM; i += 1) {
      dot += (queryVector[i] ?? 0) * (chunkVector[i] ?? 0);
    }
    if (dot > 0) {
      scored.push({ chunkId: chunk.id, score: dot });
    }
  }
  return scored.toSorted((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.chunkId < b.chunkId ? -1 : 1;
  });
};

/** Top chunk ids of a scored ranking, or empty when the channel abstains. */
export const topIdsAboveThreshold = (
  scored: ScoredChunk[],
  k: number,
  abstainBelow: number
): string[] => {
  const [top] = scored;
  if (!top || top.score <= abstainBelow) {
    return [];
  }
  return scored.slice(0, k).map((entry) => entry.chunkId);
};

/** Best (highest) score of a channel ranking, or 0 when nothing scored. */
export const bestScore = (scored: ScoredChunk[]): number =>
  scored[0]?.score ?? 0;

/** Scores for one corpus query across both channels (shared by eval and tests). */
export const channelScores = (
  index: Bm25Index,
  chunks: EvalChunk[],
  query: EvalCorpusQuery
): { bm25: ScoredChunk[]; vector: ScoredChunk[] } => ({
  bm25: rankBm25(index, chunks, query.query),
  vector: rankVector(chunks, query.query),
});
