/**
 * Small hand-labeled eval corpus. Two queries are deliberately unanswerable so
 * no-answer behavior is measured, not assumed. Bump `DATASET_VERSION` whenever
 * chunks, labels, or queries change so run records stay comparable.
 */

export const DATASET_VERSION = "knowledge-eval-corpus-v1";

export interface EvalDoc {
  id: string;
  title: string;
}

export interface EvalChunk {
  id: string;
  docId: string;
  text: string;
}

export interface EvalCorpusQuery {
  id: string;
  query: string;
  relevantChunks: string[];
  relevantDocs: string[];
  answerable: boolean;
}

export const EVAL_DOCS: EvalDoc[] = [
  { id: "doc-tailscale", title: "Tailscale access" },
  { id: "doc-kubernetes", title: "Kubernetes control plane" },
  { id: "doc-postgres", title: "Postgres storage and search" },
  { id: "doc-factory", title: "GitHub automation factory" },
  { id: "doc-bm25", title: "Postgres BM25 search" },
];

export const EVAL_CHUNKS: EvalChunk[] = [
  {
    docId: "doc-tailscale",
    id: "chunk-tailscale-serve",
    text: "tailscale serve publishes a local service behind https with an automatic certificate, and tailscale funnel can expose that service to the public internet",
  },
  {
    docId: "doc-tailscale",
    id: "chunk-tailscale-subnet",
    text: "advertise a subnet route with --advertise-routes, approve the route in the admin console, and hosts without tailscale installed become reachable",
  },
  {
    docId: "doc-kubernetes",
    id: "chunk-etcd-snapshots",
    text: "take an etcd snapshot with etcdctl snapshot save, then restore the cluster state from that snapshot after a crash by stopping the apiserver first",
  },
  {
    docId: "doc-kubernetes",
    id: "chunk-pods-crashloop",
    text: "a crashlooping pod shows a high restartcount in kubectl get pods; describe the pod and read the previous container logs before deleting it",
  },
  {
    docId: "doc-postgres",
    id: "chunk-pgvector-hnsw",
    text: "create an hnsw index on the embedding column so pgvector can answer approximate nearest neighbor queries fast",
  },
  {
    docId: "doc-postgres",
    id: "chunk-pg-backup",
    text: "back up postgres with pg_dump --format=custom; the dump is compressed, restorable, and pg_cron can schedule it nightly",
  },
  {
    docId: "doc-factory",
    id: "chunk-factory-ledger",
    text: "every factory attempt on a github issue is recorded in the run ledger, and the reconciler replays the ledger after an api outage",
  },
  {
    docId: "doc-factory",
    id: "chunk-branch-protection",
    text: "branch protection blocks merges until the required status check passes on the pull request",
  },
  {
    docId: "doc-bm25",
    id: "chunk-pgtextsearch-guide",
    text: "pg_textsearch adds bm25 ranking to postgres full text search, and to_bm25query turns a websearch string into a scored query plan",
  },
];

export const EVAL_CORPUS_QUERIES: EvalCorpusQuery[] = [
  {
    answerable: true,
    id: "q1-https-expose",
    query: "publish a local service on the public internet with https",
    relevantChunks: ["chunk-tailscale-serve"],
    relevantDocs: ["doc-tailscale"],
  },
  {
    answerable: true,
    id: "q2-etcd-restore",
    query: "restore the cluster state from an etcd snapshot after a crash",
    relevantChunks: ["chunk-etcd-snapshots"],
    relevantDocs: ["doc-kubernetes"],
  },
  {
    answerable: true,
    id: "q3-vector-index",
    query: "hnsw index for approximate nearest neighbor search on embeddings",
    relevantChunks: ["chunk-pgvector-hnsw"],
    relevantDocs: ["doc-postgres"],
  },
  {
    answerable: true,
    id: "q4-factory-ledger",
    query: "where is each github issue attempt recorded",
    relevantChunks: ["chunk-factory-ledger"],
    relevantDocs: ["doc-factory"],
  },
  {
    answerable: true,
    id: "q5-bm25-postgres",
    query: "bm25 ranking for postgres full text search",
    relevantChunks: ["chunk-pgtextsearch-guide"],
    relevantDocs: ["doc-bm25"],
  },
  {
    answerable: true,
    id: "q6-nightly-backup",
    query: "schedule nightly compressed backups of postgres",
    relevantChunks: ["chunk-pg-backup"],
    relevantDocs: ["doc-postgres"],
  },
  {
    answerable: false,
    id: "q7-no-answer-rack",
    query: "quantum entanglement calibration for the rack",
    relevantChunks: [],
    relevantDocs: [],
  },
  {
    answerable: false,
    id: "q8-no-answer-cooking",
    query: "sourdough starter hydration percentage for baking bread",
    relevantChunks: [],
    relevantDocs: [],
  },
];

/** CI subset: one lexical win, one both-channel win, one no-answer. */
export const CI_SUBSET_QUERY_IDS = [
  "q1-https-expose",
  "q2-etcd-restore",
  "q7-no-answer-rack",
];

export const corpusQueryById = (id: string): EvalCorpusQuery | undefined =>
  EVAL_CORPUS_QUERIES.find((query) => query.id === id);

export const docOfChunk = new Map<string, string>(
  EVAL_CHUNKS.map((chunk) => [chunk.id, chunk.docId])
);
