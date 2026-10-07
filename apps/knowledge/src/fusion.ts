/**
 * Reciprocal Rank Fusion (Cormack et al. 2009). BM25 scores and vector
 * distances are not comparable, so fusion trusts only ranks: each channel
 * contributes `1 / (k + rank)`. Pure and deterministic.
 */

export interface ChannelRanking {
  channel: string;
  /** Best first; ranks are 1-based positions. */
  candidates: string[];
}

export interface FusionOptions {
  /** Higher values flatten the curve so deep ranks matter more. */
  k?: number;
  /** Only the first `windowSize` candidates of each channel participate. */
  windowSize?: number;
}

export interface FusedCandidate {
  chunkId: string;
  score: number;
  /** Per contributing channel; channels that missed the chunk are absent. */
  ranks: Record<string, number>;
}

export const DEFAULT_RRF_K = 60;

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

/** Ties break on best single-channel rank, then chunk id. */
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

/** A chunk repeated within one channel throws; across channels it merges. */
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
    // Sum in sorted channel order so the float total is order-independent.
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
