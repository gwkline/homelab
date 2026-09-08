import { Database, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Input } from "./ui";

interface SourceJob {
  jobId: string;
  startedAt: string | null;
  status: string;
}
interface SourceRow {
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
interface SyncJob {
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
interface SearchHit {
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

type Phase = "error" | "loading" | "ready" | "unconfigured";

const ago = (iso: string | null): string => {
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

const sourceLabel = (s: SourceRow): string => {
  if (s.repo !== null) {
    return s.ref === null ? s.repo : `${s.repo}@${s.ref}`;
  }
  return s.path ?? s.url ?? s.sourceId;
};

// Citation link: prefer the resolvable source URL; github sources without one
// are rebuilt from (owner/repo, commit, path). GitHub blob links get a line
// anchor from the chunk's first offset anchor so the link opens at the cited
// passage.
const withLineAnchor = (url: string, hit: SearchHit): string => {
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

const citationUrl = (hit: SearchHit): string | null => {
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

const sourceBadge = (s: SourceRow): string => {
  if (s.currentJob !== null) {
    return s.currentJob.status;
  }
  return s.lastError === null ? "healthy" : "failed";
};

const getJson = async (
  url: string
): Promise<{ body: Record<string, unknown>; ok: boolean }> => {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  return { body: body as Record<string, unknown>, ok: res.ok };
};

const postJson = async (
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

const EXCERPT_MAX = 240;

export const KnowledgeCard = () => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);

  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [jobMsg, setJobMsg] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [topK, setTopK] = useState(5);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [lastSearchParams, setLastSearchParams] = useState<Record<
    string,
    unknown
  > | null>(null);

  const loadSources = useCallback(async () => {
    const { body, ok } = await getJson("/api/knowledge/sources");
    if (body.configured === false) {
      setPhase("unconfigured");
      return;
    }
    if (!ok) {
      setPhase("error");
      setErrorMsg(String(body.error ?? "knowledge API unreachable"));
      return;
    }
    setSources((body.sources ?? []) as SourceRow[]);
    setPhase("ready");
  }, []);

  useEffect(() => {
    loadSources();
    const id = setInterval(loadSources, 15_000);
    return () => clearInterval(id);
  }, [loadSources]);

  // Durable job progress: poll the knowledge API's job record every 2s until
  // it reaches a terminal state, then surface the outcome and refresh.
  useEffect(() => {
    if (job === null || job.status === "succeeded" || job.status === "failed") {
      return;
    }
    const t = setTimeout(async () => {
      const { body, ok } = await getJson(
        `/api/knowledge/sync/${encodeURIComponent(job.jobId)}`
      );
      if (!ok) {
        setJobMsg(
          `job progress unavailable: ${String(body.error ?? "unknown")}`
        );
        return;
      }
      const next = body as unknown as SyncJob;
      if (next.status === "succeeded") {
        setJobMsg(
          `sync succeeded · ${next.documentsIngested ?? "?"} docs · ${next.chunksIngested ?? "?"} chunks`
        );
        setJob(null);
        loadSources();
      } else if (next.status === "failed") {
        setJobMsg(`sync failed: ${next.error ?? "unknown error"}`);
        setJob(null);
        loadSources();
      } else {
        setJob(next);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [job, loadSources]);

  const triggerSync = async (sourceId: string) => {
    setSyncBusy(sourceId);
    setJobMsg(null);
    try {
      const { body, ok } = await postJson("/api/knowledge/sync", { sourceId });
      if (!ok) {
        setJobMsg(String(body.error ?? "failed to queue sync"));
        return;
      }
      setJob({
        attempts: null,
        chunksIngested: null,
        documentsIngested: null,
        error: null,
        finishedAt: null,
        jobId: String(body.jobId ?? ""),
        sourceId,
        startedAt: null,
        status: String(body.status ?? "queued"),
      });
      setJobMsg(`sync queued (${String(body.jobId)}) — watching job…`);
    } catch (error) {
      setJobMsg(String(error));
    } finally {
      setSyncBusy(null);
    }
  };

  const runSearch = useCallback(async (params: Record<string, unknown>) => {
    setSearching(true);
    setSearchError(null);
    setLastSearchParams(params);
    try {
      const { body, ok } = await postJson("/api/knowledge/search", params);
      if (!ok) {
        setSearchError(String(body.error ?? "search failed"));
        return;
      }
      setResults((body.results ?? []) as SearchHit[]);
    } catch (error) {
      setSearchError(String(error));
    } finally {
      setSearching(false);
    }
  }, []);

  const submitSearch = () => {
    if (!query.trim()) {
      return;
    }
    const params: Record<string, unknown> = {
      mode,
      query,
      topK,
    };
    if (namespace.trim() !== "") {
      params.namespace = namespace.trim();
    }
    if (includeSuperseded) {
      params.includeSuperseded = true;
    }
    runSearch(params);
  };

  return (
    <Card>
      <CardHeader
        title="knowledge"
        subtitle="registered sources · ingestion health · cited search"
        action={
          <Button
            onClick={loadSources}
            className="bg-muted text-foreground h-7 px-2 py-1 text-xs hover:opacity-80"
          >
            <RefreshCw size={12} /> reload
          </Button>
        }
      />
      <div className="space-y-5 p-5">
        {phase === "loading" && (
          <p className="text-muted-foreground text-sm">loading sources…</p>
        )}
        {phase === "unconfigured" && (
          <p className="text-muted-foreground text-sm">
            knowledge API not configured on the panel server (set
            KNOWLEDGE_API_BASE and a secret-backed KNOWLEDGE_API_TOKEN) —
            sources and search stay disabled until then.
          </p>
        )}
        {phase === "error" && (
          <div className="border-destructive/30 bg-destructive/10 rounded-lg border p-3">
            <p className="text-destructive text-sm">{errorMsg}</p>
            <Button
              onClick={loadSources}
              className="mt-2 h-7 px-2 py-1 text-xs"
            >
              <RefreshCw size={12} /> retry
            </Button>
          </div>
        )}
        {phase === "ready" && (
          <>
            <div className="space-y-2">
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                <Database size={12} /> sources ({sources.length})
              </p>
              {sources.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  no sources registered yet — register one through the knowledge
                  API to see ingestion health here.
                </p>
              )}
              <div className="divide-border border-border divide-y rounded-lg border">
                {sources.map((s) => {
                  const busy = syncBusy === s.sourceId;
                  const watching = job?.sourceId === s.sourceId ? job : null;
                  return (
                    <div key={s.sourceId} className="px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm font-medium">
                            {sourceLabel(s)}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            ns <span className="font-mono">{s.namespace}</span>
                            {" · "}
                            {s.documentCount} docs · {s.chunkCount} chunks
                            {" · "}last sync {ago(s.lastSyncAt)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Badge status={sourceBadge(s)} />
                          <Button
                            onClick={() => triggerSync(s.sourceId)}
                            disabled={busy || syncBusy !== null}
                            className="bg-muted text-foreground border-border h-7 border px-2 py-1 text-xs hover:opacity-80"
                          >
                            <RefreshCw
                              size={11}
                              className={busy ? "animate-spin" : ""}
                            />{" "}
                            {busy ? "queuing…" : "sync"}
                          </Button>
                        </div>
                      </div>
                      {watching !== null && (
                        <p className="text-warning mt-1.5 text-xs">
                          job {watching.jobId}: {watching.status}
                          {watching.documentsIngested !== null &&
                            ` · ${watching.documentsIngested} docs`}
                          {watching.chunksIngested !== null &&
                            ` · ${watching.chunksIngested} chunks`}
                        </p>
                      )}
                      {s.lastError !== null && (
                        <p className="text-destructive mt-1.5 truncate text-xs">
                          last error ({ago(s.lastError.at)}):{" "}
                          {s.lastError.message}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {jobMsg && (
                <p className="text-muted-foreground text-xs">{jobMsg}</p>
              )}
            </div>

            <div className="border-border space-y-2 border-t pt-4">
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
                <Search size={12} /> cited search
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  placeholder="search the knowledge base…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                  className="min-w-48 flex-1"
                  aria-label="search query"
                />
                <Input
                  placeholder="namespace (default)"
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className="w-36"
                  aria-label="namespace"
                />
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                  className="border-border bg-background rounded-lg border px-2 py-1.5 text-sm"
                  aria-label="retrieval mode"
                >
                  <option value="hybrid">hybrid</option>
                  <option value="bm25">bm25</option>
                  <option value="vector">vector</option>
                </select>
                <select
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="border-border bg-background rounded-lg border px-2 py-1.5 text-sm"
                  aria-label="top-k"
                >
                  <option value={5}>top 5</option>
                  <option value={10}>top 10</option>
                  <option value={20}>top 20</option>
                </select>
                <Button
                  onClick={submitSearch}
                  disabled={searching || !query.trim()}
                >
                  <Search size={14} /> {searching ? "searching…" : "search"}
                </Button>
              </div>
              <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={includeSuperseded}
                  onChange={(e) => setIncludeSuperseded(e.target.checked)}
                />
                include superseded versions (deleted content is never served)
              </label>

              {searchError !== null && (
                <div className="border-destructive/30 bg-destructive/10 rounded-lg border p-3">
                  <p className="text-destructive text-sm">{searchError}</p>
                  {lastSearchParams !== null && (
                    <Button
                      onClick={() => runSearch(lastSearchParams)}
                      className="mt-2 h-7 px-2 py-1 text-xs"
                    >
                      <RefreshCw size={12} /> retry search
                    </Button>
                  )}
                </div>
              )}
              {searchError === null &&
                results !== null &&
                results.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    no results — broaden the query or check the namespace.
                  </p>
                )}
              {results !== null && results.length > 0 && (
                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs">
                    {results.length} result{results.length === 1 ? "" : "s"} ·
                    ranked by fused score
                  </p>
                  {results.map((hit) => {
                    const link = citationUrl(hit);
                    const superseded = hit.version.status === "superseded";
                    return (
                      <div
                        key={hit.chunkId}
                        className={cn(
                          "border-border rounded-lg border p-3",
                          superseded && "border-warning/40 bg-warning/5"
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p
                              className={cn(
                                "truncate text-sm font-medium",
                                superseded &&
                                  "text-muted-foreground line-through"
                              )}
                            >
                              {hit.title}
                            </p>
                            <p className="text-muted-foreground truncate font-mono text-xs">
                              {hit.source.path ?? hit.source.sourceId}
                              {" · "}
                              {hit.version.commit === null
                                ? "no commit"
                                : hit.version.commit.slice(0, 7)}
                              {" · ns "}
                              {hit.namespace}
                              {" · "}
                              {superseded
                                ? "superseded version"
                                : ago(hit.version.createdAt)}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {superseded && (
                              <span className="border-warning/30 bg-warning/15 text-warning inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
                                superseded
                              </span>
                            )}
                            {link !== null && (
                              <a
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
                              >
                                cite <ExternalLink size={11} />
                              </a>
                            )}
                          </div>
                        </div>
                        <p className="mt-1.5 line-clamp-3 text-sm">
                          {hit.text.length > EXCERPT_MAX
                            ? `${hit.text.slice(0, EXCERPT_MAX)}…`
                            : hit.text}
                        </p>
                        <p className="text-muted-foreground mt-1.5 text-[11px]">
                          fused #{hit.scores.fused.rank} (
                          {hit.scores.fused.score})
                          {hit.scores.bm25 !== null &&
                            ` · bm25 #${hit.scores.bm25.rank}`}
                          {hit.scores.vector !== null &&
                            ` · vector #${hit.scores.vector.rank}`}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
};
