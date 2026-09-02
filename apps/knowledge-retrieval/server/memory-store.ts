import { readFileSync } from "node:fs";

import {
  bm25TermScore,
  cosineSimilarity,
  tokenize,
} from "./rank.js";
import type {
  ChannelResults,
  ChunkRecord,
  CitationAnchor,
  DocumentVersion,
  RankedCandidate,
  RetrievalStore,
  SearchFilters,
  SearchOptions,
  SourceRef,
} from "./store.js";

export interface MemoryChunkInput {
  chunkId: string;
  text: string;
  anchors: CitationAnchor[];
  tags: string[];
  embedding?: number[] | null;
}

export interface MemoryVersionInput {
  version: DocumentVersion;
  provenance: { ingestionEventId: string; ingestedAt: string };
  chunks: MemoryChunkInput[];
}

export interface MemoryDocumentInput {
  documentId: string;
  namespace: string;
  title: string;
  source: SourceRef;
  versions: MemoryVersionInput[];
}

export interface MemoryStoreOptions {
  documents: MemoryDocumentInput[];
  embedder?: (text: string) => number[];
  embeddingDimensions?: number;
}

// Deterministic bag-of-words hashing embedder. Not semantic — it exists so the
// vector channel is exercisable without a real embedding service; a production
// store (Postgres + pgvector) computes query embeddings from the ingestion
// pipeline's model instead.
export function hashEmbed(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dimensions;
    const slot = vector[index];
    if (slot !== undefined) {
      vector[index] = slot + 1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((v) => v / norm);
}

function chunkVisible(chunk: ChunkRecord, filters: SearchFilters): boolean {
  if (chunk.version.status === "deleted") {
    return false;
  }
  if (chunk.version.status === "superseded" && !filters.includeSuperseded) {
    return false;
  }
  for (const tag of filters.tags) {
    if (!chunk.tags.includes(tag)) {
      return false;
    }
  }
  if (
    filters.sourceIds.length > 0 &&
    !filters.sourceIds.includes(chunk.source.sourceId)
  ) {
    return false;
  }
  return true;
}

export class MemoryStore implements RetrievalStore {
  private readonly chunks: ChunkRecord[];
  private readonly embedder: (text: string) => number[];

  constructor(options: MemoryStoreOptions) {
    this.embedder = options.embedder ?? ((text) => hashEmbed(text, options.embeddingDimensions));
    const chunks: ChunkRecord[] = [];
    for (const doc of options.documents) {
      for (const version of doc.versions) {
        for (const chunk of version.chunks) {
          if (chunk.anchors.length === 0) {
            throw new Error(
              `chunk ${chunk.chunkId} has no citation anchors; provenance is mandatory`
            );
          }
          chunks.push({
            anchors: chunk.anchors,
            documentId: doc.documentId,
            embedding: chunk.embedding === undefined ? null : chunk.embedding,
            namespace: doc.namespace,
            provenance: version.provenance,
            source: doc.source,
            tags: chunk.tags,
            text: chunk.text,
            title: doc.title,
            version: version.version,
            chunkId: chunk.chunkId,
          });
        }
      }
    }
    this.chunks = chunks;
  }

  get size(): number {
    return this.chunks.length;
  }

  embedQuery(query: string): number[] | null {
    const embedding = this.embedder(query);
    return embedding.some((v) => v !== 0) ? embedding : null;
  }

  async search(options: SearchOptions): Promise<ChannelResults> {
    const visible = this.chunks.filter(
      (chunk) => chunk.namespace === options.namespace && chunkVisible(chunk, options.filters)
    );
    return {
      bm25: this.searchBm25(visible, options),
      vector: this.searchVector(visible, options),
    };
  }

  private searchBm25(chunks: ChunkRecord[], options: SearchOptions): RankedCandidate[] {
    const queryTerms = [...new Set(tokenize(options.query))];
    if (queryTerms.length === 0 || chunks.length === 0) {
      return [];
    }
    const docs = chunks.map((chunk) => {
      const tokens = tokenize(`${chunk.title} ${chunk.text}`);
      const counts = new Map<string, number>();
      for (const token of tokens) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      return { chunk, counts, length: tokens.length };
    });
    const totalDocs = docs.length;
    const averageDocLength =
      docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(totalDocs, 1);
    const docFrequency = new Map<string, number>();
    for (const term of queryTerms) {
      let df = 0;
      for (const doc of docs) {
        if ((doc.counts.get(term) ?? 0) > 0) {
          df += 1;
        }
      }
      docFrequency.set(term, df);
    }
    const scored: RankedCandidate[] = [];
    for (const doc of docs) {
      let score = 0;
      for (const term of queryTerms) {
        const df = docFrequency.get(term) ?? 0;
        score += bm25TermScore(
          doc.counts.get(term) ?? 0,
          df,
          totalDocs,
          doc.length,
          averageDocLength
        );
      }
      if (score > 0) {
        scored.push({ bm25Score: score, chunk: doc.chunk, vectorScore: null });
      }
    }
    scored.sort((a, b) => {
      const sa = a.bm25Score ?? 0;
      const sb = b.bm25Score ?? 0;
      if (sb !== sa) {
        return sb - sa;
      }
      return a.chunk.chunkId.localeCompare(b.chunk.chunkId);
    });
    return scored.slice(0, options.limitPerChannel);
  }

  private searchVector(chunks: ChunkRecord[], options: SearchOptions): RankedCandidate[] {
    if (!options.queryEmbedding) {
      return [];
    }
    const scored: RankedCandidate[] = [];
    for (const chunk of chunks) {
      if (!chunk.embedding) {
        continue;
      }
      const similarity = cosineSimilarity(options.queryEmbedding, chunk.embedding);
      if (similarity !== null && similarity > 0) {
        scored.push({ bm25Score: null, chunk, vectorScore: similarity });
      }
    }
    scored.sort((a, b) => {
      const sa = a.vectorScore ?? 0;
      const sb = b.vectorScore ?? 0;
      if (sb !== sa) {
        return sb - sa;
      }
      return a.chunk.chunkId.localeCompare(b.chunk.chunkId);
    });
    return scored.slice(0, options.limitPerChannel);
  }
}

// Seed fixture format for local/dev runs until the Postgres store lands
// (schema work tracked separately). Same shape as MemoryStoreOptions.documents.
export function memoryStoreFromSeedFile(path: string): MemoryStore {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`KNOWLEDGE_SEED_FILE ${path} unreadable: ${reason}`);
  }
  const seed = raw as { documents?: MemoryDocumentInput[] };
  if (!Array.isArray(seed.documents)) {
    throw new Error(`KNOWLEDGE_SEED_FILE ${path} must be {"documents": [...]}`);
  }
  return new MemoryStore({ documents: seed.documents });
}
