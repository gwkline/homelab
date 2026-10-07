import {
  Database,
  ExternalLink,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  EXCERPT_MAX,
  ago,
  citationUrl,
  getJson,
  postJson,
  sourceBadge,
  sourceLabel,
} from "../lib/knowledge";
import type { SearchHit, SourceRow, SyncJob } from "../lib/knowledge";
import { cn } from "../lib/utils";
import { Badge, Button, Card, CardHeader, Checkbox, Input, Select } from "./ui";

type Phase = "error" | "loading" | "ready" | "unconfigured";

interface HistoryEntry {
  params: Record<string, unknown>;
  query: string;
}

const HISTORY_MAX = 8;

const passageText = (hit: SearchHit, expanded: boolean): string => {
  if (expanded) {
    return hit.text;
  }
  if (hit.text.length > EXCERPT_MAX) {
    return `${hit.text.slice(0, EXCERPT_MAX)}…`;
  }
  return hit.text;
};

// One search result: citation header, expandable passage, score breakdown.
const SearchResult = ({
  expanded,
  hit,
  onToggle,
}: {
  expanded: boolean;
  hit: SearchHit;
  onToggle: () => void;
}) => {
  const link = citationUrl(hit);
  const superseded = hit.version.status === "superseded";
  return (
    <div
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
              superseded && "text-muted-foreground line-through"
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
            {superseded ? "superseded version" : ago(hit.version.createdAt)}
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
      <button
        onClick={onToggle}
        className="mt-1.5 w-full cursor-pointer text-left text-sm whitespace-pre-wrap"
        title={expanded ? "collapse passage" : "expand full passage"}
      >
        {passageText(hit, expanded)}
      </button>
      <p className="text-muted-foreground mt-1.5 text-[11px]">
        fused #{hit.scores.fused.rank} ({hit.scores.fused.score})
        {hit.scores.bm25 !== null &&
          ` · bm25 #${hit.scores.bm25.rank} (${hit.scores.bm25.score})`}
        {hit.scores.vector !== null &&
          ` · vector #${hit.scores.vector.rank} (${hit.scores.vector.score})`}
      </p>
    </div>
  );
};

// One registered source: health, counts, live job, sync trigger.
const SourceItem = ({
  busy,
  onNamespace,
  onSync,
  s,
  watching,
}: {
  busy: boolean;
  onNamespace: (namespace: string) => void;
  onSync: (sourceId: string) => void;
  s: SourceRow;
  watching: SyncJob | null;
}) => (
  <div className="px-3 py-2.5">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm font-medium">
          {sourceLabel(s)}
        </p>
        <p className="text-muted-foreground mt-0.5 text-xs">
          <button
            onClick={() => onNamespace(s.namespace)}
            className="hover:text-foreground font-mono underline decoration-dotted underline-offset-2"
            title={`scope search to ${s.namespace}`}
          >
            ns {s.namespace}
          </button>
          {" · "}
          {s.documentCount} docs · {s.chunkCount} chunks
          {" · "}last sync {ago(s.lastSyncAt)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge status={sourceBadge(s)} />
        <Button
          onClick={() => onSync(s.sourceId)}
          disabled={busy}
          className="bg-muted text-foreground border-border h-7 border px-2 py-1 text-xs hover:opacity-80"
        >
          <RefreshCw size={11} className={busy ? "animate-spin" : ""} />{" "}
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
        last error ({ago(s.lastError.at)}): {s.lastError.message}
      </p>
    )}
  </div>
);

// Search outcome region: error, empty, or the ranked result list.
const SearchResults = ({
  expandedId,
  onToggle,
  results,
  runId,
  searchError,
}: {
  expandedId: string | null;
  onToggle: (chunkId: string) => void;
  results: SearchHit[] | null;
  runId: string | null;
  searchError: string | null;
}) => (
  <>
    {searchError !== null && (
      <div className="border-destructive/30 bg-destructive/10 rounded-lg border p-3">
        <p className="text-destructive text-sm">{searchError}</p>
      </div>
    )}
    {searchError === null && results !== null && results.length === 0 && (
      <p className="text-muted-foreground text-sm">
        no results — broaden the query or check the namespace.
      </p>
    )}
    {results !== null && results.length > 0 && (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          {results.length} result{results.length === 1 ? "" : "s"} · ranked by
          fused score
          {runId !== null && ` · run ${runId.slice(0, 18)}`}
        </p>
        {results.map((hit) => (
          <SearchResult
            key={hit.chunkId}
            hit={hit}
            expanded={expandedId === hit.chunkId}
            onToggle={() => onToggle(hit.chunkId)}
          />
        ))}
      </div>
    )}
  </>
);

// Full-page explorer: cited search, history, and source health + sync controls.
export const KnowledgeExplorer = () => {
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceRow[]>([]);

  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [job, setJob] = useState<SyncJob | null>(null);
  const [jobMsg, setJobMsg] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [topK, setTopK] = useState(10);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  // Poll the sync job every 2s until it reaches a terminal state.
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

  const runSearch = useCallback(
    async (params: Record<string, unknown>, label: string) => {
      setSearching(true);
      setSearchError(null);
      setExpandedId(null);
      try {
        const { body, ok } = await postJson("/api/knowledge/search", params);
        if (!ok) {
          setSearchError(String(body.error ?? "search failed"));
          return;
        }
        setResults((body.results ?? []) as SearchHit[]);
        setRunId(typeof body.runId === "string" ? body.runId : null);
        setHistory((prev) => {
          const next = [
            { params, query: label },
            ...prev.filter((h) => h.query !== label),
          ];
          return next.slice(0, HISTORY_MAX);
        });
      } catch (error) {
        setSearchError(String(error));
      } finally {
        setSearching(false);
      }
    },
    []
  );

  const buildParams = (q: string): Record<string, unknown> => {
    const params: Record<string, unknown> = {
      mode,
      query: q,
      topK,
    };
    if (namespace.trim() !== "") {
      params.namespace = namespace.trim();
    }
    if (includeSuperseded) {
      params.includeSuperseded = true;
    }
    return params;
  };

  const submitSearch = () => {
    if (!query.trim()) {
      return;
    }
    runSearch(buildParams(query), query);
  };

  const rerunHistory = (h: HistoryEntry) => {
    setQuery(h.query);
    runSearch(h.params, h.query);
  };

  const totalDocs = sources.reduce((sum, s) => sum + s.documentCount, 0);
  const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="cited search"
          subtitle="hybrid BM25 + vector retrieval over every registered source — click a passage to expand the full chunk"
        />
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <Search
                size={14}
                className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
              />
              <Input
                placeholder="search the knowledge base…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                className="pl-8"
                aria-label="search query"
              />
            </div>
            <Input
              placeholder="namespace (default)"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="w-40"
              aria-label="namespace"
            />
            <Select
              ariaLabel="retrieval mode"
              value={mode}
              onChange={setMode}
              options={[
                { label: "hybrid", value: "hybrid" },
                { label: "bm25", value: "bm25" },
                { label: "vector", value: "vector" },
              ]}
            />
            <Select
              ariaLabel="top-k"
              value={String(topK)}
              onChange={(v) => {
                setTopK(Number(v));
              }}
              options={[
                { label: "top 5", value: "5" },
                { label: "top 10", value: "10" },
                { label: "top 20", value: "20" },
                { label: "top 50", value: "50" },
              ]}
            />
            <Button
              onClick={submitSearch}
              disabled={searching || !query.trim()}
            >
              <Search size={14} /> {searching ? "searching…" : "search"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Checkbox
                ariaLabel="include superseded versions"
                checked={includeSuperseded}
                onCheckedChange={setIncludeSuperseded}
              />
              <span
                className="cursor-pointer select-none"
                onClick={() => {
                  setIncludeSuperseded(!includeSuperseded);
                }}
              >
                include superseded versions (deleted content is never served)
              </span>
            </span>
            {history.length > 0 && (
              <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
                <History size={11} />
                {history.map((h) => (
                  <button
                    key={h.query}
                    onClick={() => rerunHistory(h)}
                    className="border-border bg-muted/50 hover:bg-muted rounded-full border px-2 py-0.5 font-mono"
                    title="rerun this search"
                  >
                    {h.query.length > 24 ? `${h.query.slice(0, 24)}…` : h.query}
                  </button>
                ))}
              </span>
            )}
          </div>

          <SearchResults
            expandedId={expandedId}
            onToggle={(chunkId) =>
              setExpandedId(expandedId === chunkId ? null : chunkId)
            }
            results={results}
            runId={runId}
            searchError={searchError}
          />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="sources"
          subtitle={`${sources.length} registered · ${totalDocs} documents · ${totalChunks} chunks — click a namespace to scope search`}
          action={
            <Button
              onClick={loadSources}
              className="bg-muted text-foreground h-7 px-2 py-1 text-xs hover:opacity-80"
            >
              <RefreshCw size={12} /> reload
            </Button>
          }
        />
        <div className="space-y-3 p-5">
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
              {sources.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  no sources registered yet — register one through the knowledge
                  API to see ingestion health here.
                </p>
              )}
              <div className="divide-border border-border divide-y rounded-lg border">
                {sources.map((s) => (
                  <SourceItem
                    key={s.sourceId}
                    s={s}
                    busy={syncBusy !== null}
                    watching={job?.sourceId === s.sourceId ? job : null}
                    onSync={triggerSync}
                    onNamespace={setNamespace}
                  />
                ))}
              </div>
              {jobMsg && (
                <p className="text-muted-foreground text-xs">{jobMsg}</p>
              )}
            </>
          )}
        </div>
      </Card>

      {phase === "ready" && sources.length > 0 && (
        <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-xs">
          <Database size={11} /> knowledge base · retrieval over {totalChunks}{" "}
          chunks from {sources.length} source
          {sources.length === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
};
