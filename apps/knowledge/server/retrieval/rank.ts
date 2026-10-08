export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

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
