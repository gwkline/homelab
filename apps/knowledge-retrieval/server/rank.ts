export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const RRF_DEFAULT_K = 60;

export const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 0);

export const bm25Idf = (docFrequency: number, totalDocs: number): number =>
  Math.log(1 + (totalDocs - docFrequency + 0.5) / (docFrequency + 0.5));

export const bm25TermScore = (
  termFrequency: number,
  docFrequency: number,
  totalDocs: number,
  docLength: number,
  averageDocLength: number,
  k1 = BM25_K1,
  b = BM25_B
): number => {
  if (termFrequency <= 0 || totalDocs <= 0 || docFrequency <= 0) {
    return 0;
  }
  const idf = bm25Idf(docFrequency, totalDocs);
  const norm = 1 - b + b * (docLength / averageDocLength);
  return idf * ((termFrequency * (k1 + 1)) / (termFrequency + k1 * norm));
};

export const cosineSimilarity = (a: number[], b: number[]): number | null => {
  if (a.length === 0 || a.length !== b.length) {
    return null;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) {
      return null;
    }
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return null;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export interface ChannelRank {
  rank: number;
  score: number;
}

export interface FusedCandidate<T> {
  item: T;
  fusedScore: number;
  bm25: ChannelRank | null;
  vector: ChannelRank | null;
}

interface ChannelInput<T> {
  items: T[];
  key: "bm25" | "vector";
}

// Reciprocal Rank Fusion over one or two ranked channel lists. Duplicates
// collapse to a single candidate that keeps every channel rank it earned;
// candidates found by only one channel stay eligible. Ties break on the
// candidate id (ascending) so the output is deterministic.
export const reciprocalRankFusion = <T>(
  channels: ChannelInput<T>[],
  getId: (item: T) => string,
  k: number = RRF_DEFAULT_K
): FusedCandidate<T>[] => {
  if (k <= 0) {
    throw new Error(`rrf k must be positive, got ${k}`);
  }
  const byId = new Map<
    string,
    {
      item: T;
      fusedScore: number;
      bm25: ChannelRank | null;
      vector: ChannelRank | null;
    }
  >();
  for (const channel of channels) {
    for (let i = 0; i < channel.items.length; i += 1) {
      const item = channel.items[i];
      if (!item) {
        continue;
      }
      const id = getId(item);
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const existing = byId.get(id);
      if (existing) {
        existing.fusedScore += contribution;
        existing[channel.key] = { rank, score: contribution };
      } else {
        const entry: FusedCandidate<T> = {
          bm25: channel.key === "bm25" ? { rank, score: contribution } : null,
          fusedScore: contribution,
          item,
          vector:
            channel.key === "vector" ? { rank, score: contribution } : null,
        };
        byId.set(id, entry);
      }
    }
  }
  return [...byId.values()].toSorted((a, b) => {
    if (b.fusedScore !== a.fusedScore) {
      return b.fusedScore - a.fusedScore;
    }
    return getId(a.item).localeCompare(getId(b.item));
  });
};

export const rrfScoreForRank = (
  rank: number,
  k: number = RRF_DEFAULT_K
): number => 1 / (k + rank);
