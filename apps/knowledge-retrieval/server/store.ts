export type RetrievalMode = "bm25" | "vector" | "hybrid";

export type SourceKind = "github" | "file" | "url" | "web";

export type VersionStatus = "current" | "superseded" | "deleted";

export interface CitationAnchor {
  type: "offset" | "heading";
  start?: number;
  end?: number;
  value?: string;
}

export interface DocumentVersion {
  versionId: string;
  commit: string | null;
  createdAt: string;
  status: VersionStatus;
}

export interface SourceRef {
  sourceId: string;
  kind: SourceKind;
  url: string | null;
  path: string | null;
}

export interface ChunkProvenance {
  ingestionEventId: string;
  ingestedAt: string;
}

export interface ChunkRecord {
  chunkId: string;
  documentId: string;
  namespace: string;
  title: string;
  text: string;
  tags: string[];
  version: DocumentVersion;
  source: SourceRef;
  anchors: CitationAnchor[];
  provenance: ChunkProvenance;
  embedding: number[] | null;
}

export interface SearchFilters {
  tags: string[];
  sourceIds: string[];
  includeSuperseded: boolean;
}

export interface SearchOptions {
  namespace: string;
  query: string;
  limitPerChannel: number;
  filters: SearchFilters;
  queryEmbedding: number[] | null;
}

export interface RankedCandidate {
  chunk: ChunkRecord;
  bm25Score: number | null;
  vectorScore: number | null;
}

export interface ChannelResults {
  bm25: RankedCandidate[];
  vector: RankedCandidate[];
}

export interface RetrievalStore {
  search(options: SearchOptions): Promise<ChannelResults>;
  // Optional query-embedding capability for vector/hybrid modes. Returning
  // null disables the vector channel for that query instead of failing.
  embedQuery?(query: string): Promise<number[] | null> | number[] | null;
}

export class StoreUnavailableError extends Error {
  override name = "StoreUnavailableError";
}
