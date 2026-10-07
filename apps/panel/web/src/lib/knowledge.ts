// Knowledge-API types and view helpers shared by the card and the explorer.

export interface SourceJob {
  jobId: string;
  startedAt: string | null;
  status: string;
}

export interface SourceRow {
  chunkCount: number;
  currentJob: SourceJob | null;
  documentCount: number;
  kind: string;
  lastError: { at: string | null; message: string } | null;
  lastSyncAt: string | null;
  namespace: string;
  path: string | null;
  ref: string | null;
  repo: string | null;
  sourceId: string;
  url: string | null;
}

export interface SyncJob {
  attempts: number | null;
  chunksIngested: number | null;
  documentsIngested: number | null;
  error: string | null;
  finishedAt: string | null;
  jobId: string;
  sourceId: string | null;
  startedAt: string | null;
  status: string;
}

export interface SearchHit {
  anchors: { start: number | null; type: string; value: string | null }[];
  chunkId: string;
  namespace: string;
  scores: {
    bm25: { rank: number; score: number } | null;
    fused: { rank: number; score: number };
    vector: { rank: number; score: number } | null;
  };
  source: {
    kind: string;
    path: string | null;
    sourceId: string;
    url: string | null;
  };
  text: string;
  title: string;
  version: { commit: string | null; createdAt: string; status: string };
}

export const EXCERPT_MAX = 240;

export const ago = (iso: string | null): string => {
  if (iso === null) {
    return "never";
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "unknown";
  }
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  return `${Math.floor(h / 24)}d ago`;
};

export const sourceLabel = (s: SourceRow): string => {
  if (s.repo !== null) {
    return s.ref === null ? s.repo : `${s.repo}@${s.ref}`;
  }
  return s.path ?? s.url ?? s.sourceId;
};

// Prefer the source URL; otherwise rebuild a GitHub blob link, anchored at
// the cited line.
export const withLineAnchor = (url: string, hit: SearchHit): string => {
  if (!url.startsWith("https://github.com/") || !url.includes("/blob/")) {
    return url;
  }
  const offset = hit.anchors.find(
    (a) => a.type === "offset" && a.start !== null
  );
  if (offset === undefined || offset.start === null) {
    return url;
  }
  return `${url}#L${offset.start + 1}`;
};

export const citationUrl = (hit: SearchHit): string | null => {
  if (hit.source.url !== null && hit.source.url !== "") {
    return withLineAnchor(hit.source.url, hit);
  }
  if (hit.source.kind === "github" && hit.source.path !== null) {
    const commit = hit.version.commit ?? "main";
    return withLineAnchor(
      `https://github.com/${hit.source.sourceId}/blob/${commit}/${hit.source.path}`,
      hit
    );
  }
  return null;
};

export const sourceBadge = (s: SourceRow): string => {
  if (s.currentJob !== null) {
    return s.currentJob.status;
  }
  return s.lastError === null ? "healthy" : "failed";
};

export const getJson = async (
  url: string
): Promise<{ body: Record<string, unknown>; ok: boolean }> => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { body: body as Record<string, unknown>, ok: res.ok };
};

export const postJson = async (
  url: string,
  payload: Record<string, unknown>
): Promise<{ body: Record<string, unknown>; ok: boolean }> => {
  const res = await fetch(url, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = await res.json().catch(() => ({}));
  return { body: body as Record<string, unknown>, ok: res.ok };
};
