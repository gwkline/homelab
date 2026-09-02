/**
 * Reciprocal Rank Fusion (RRF) for hybrid keyword + semantic retrieval (#63).
 *
 * BM25 scores and embedding distances are not comparable — one is unbounded
 * term relevance, the other a distance in vector space — so fusion trusts only
 * ordinal positions. Each channel contributes `1 / (k + rank)` per candidate
 * (Cormack et al. 2009); the fused score is the sum over channels where the
 * chunk appeared. The default `k = 60` dampens the head of the list so a
 * single channel's top hit cannot dominate a two-channel consensus, and it is
 * configurable for tuning on the eval harness (`eval/run-eval.ts`).
 *
 * This module is pure: no I/O, no clocks, no randomness. Same input, same
 * output — always.
 */

/** A single retriever channel's output, best candidate first. */
export interface ChannelRanking {
  /** Channel id, e.g. `"bm25"` (keyword, #60) or `"vector"` (pgvector, #62). */
  channel: string;
  /** Ranked chunk ids, best first. Ranks are 1-based positions in this list. */
  candidates: string[];
}

export interface FusionOptions {
  /**
   * RRF constant: the contribution of rank `r` is `1 / (k + r)`. Higher values
   * flatten the curve and make deep ranks matter more. Must be finite and > 0.
   */
  k?: number;
  /**
   * Per-channel candidate window: only the first `windowSize` candidates of
   * each channel participate in fusion. Bounds the influence of long tails.
   * Must be an integer >= 1.
   */
  windowSize?: number;
}

/** One fused candidate: ranks are kept for debugging, not for rescoring. */
export interface FusedCandidate {
  chunkId: string;
  /**
   * RRF score: sum of `1 / (k + rank)` over the channels that returned the
   * chunk. Not comparable to raw BM25 or distance scores.
   */
  score: number;
  /**
   * 1-based rank within each contributing channel (e.g. `ranks.bm25` and
   * `ranks.vector`). Channels that did not return the chunk are absent, so a
   * single-channel candidate is identifiable and stays eligible.
   */
  ranks: Record<string, number>;
}

/** Cormack et al. (2009) default; tune via eval evidence, not vibes. */
export const DEFAULT_RRF_K = 60;

/** Generous default window; callers with strong retrievers can tighten it. */
export const DEFAULT_WINDOW_SIZE = 100;

const validateOptions = (k: number, windowSize: number): void => {
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`fusion: k must be a finite number > 0, got ${k}`);
  }
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error(
      `fusion: windowSize must be an integer >= 1, got ${windowSize}`
    );
  }
};

/**
 * Deterministic tie-breaking (after fused score, descending):
 *  1. lower best source rank (the strongest single-channel evidence),
 *  2. chunk id lexicographically ascending.
 */
const compareFusedCandidates = (
  a: FusedCandidate,
  b: FusedCandidate
): number => {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  const bestA = Math.min(...Object.values(a.ranks));
  const bestB = Math.min(...Object.values(b.ranks));
  if (bestA !== bestB) {
    return bestA - bestB;
  }
  if (a.chunkId !== b.chunkId) {
    return a.chunkId < b.chunkId ? -1 : 1;
  }
  return 0;
};

/**
 * Fuse ranked channel lists into one deterministic hybrid ranking.
 *
 * Duplicate chunk ids within one channel list throw — a ranked list may not
 * contain the same chunk twice. The same chunk returned by several channels
 * collapses to one candidate with all source ranks preserved.
 */
export const fuseReciprocalRank = (
  rankings: ChannelRanking[],
  options: FusionOptions = {}
): FusedCandidate[] => {
  const k = options.k ?? DEFAULT_RRF_K;
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  validateOptions(k, windowSize);

  const windowed = new Map<string, string[]>();
  for (const { channel, candidates } of rankings) {
    if (channel.length === 0) {
      throw new Error("fusion: channel name must be non-empty");
    }
    if (windowed.has(channel)) {
      throw new Error(`fusion: duplicate channel "${channel}"`);
    }
    const windowSlice = candidates.slice(0, windowSize);
    const seen = new Set<string>();
    for (const chunkId of windowSlice) {
      if (seen.has(chunkId)) {
        throw new Error(
          `fusion: duplicate candidate "${chunkId}" in channel "${channel}"`
        );
      }
      seen.add(chunkId);
    }
    windowed.set(channel, windowSlice);
  }

  // chunkId -> channel -> 1-based rank within that channel.
  const hits = new Map<string, Map<string, number>>();
  for (const [channel, candidates] of windowed) {
    for (const [index, chunkId] of candidates.entries()) {
      let byChannel = hits.get(chunkId);
      if (!byChannel) {
        byChannel = new Map<string, number>();
        hits.set(chunkId, byChannel);
      }
      byChannel.set(channel, index + 1);
    }
  }

  const fused: FusedCandidate[] = [];
  for (const [chunkId, ranks] of hits) {
    // Sum in sorted channel order so the float total is identical no matter
    // which order the lists were passed in.
    const ordered = [...ranks.entries()].toSorted((x, y) =>
      x[0] < y[0] ? -1 : 1
    );
    let score = 0;
    for (const [, rank] of ordered) {
      score += 1 / (k + rank);
    }
    fused.push({ chunkId, ranks: Object.fromEntries(ranks), score });
  }

  return fused.toSorted(compareFusedCandidates);
};
