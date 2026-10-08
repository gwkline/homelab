import { useCallback, useEffect, useState } from "react";

import type {
  KnowledgeSource,
  KnowledgeSyncJob,
} from "../../../server/knowledge";
import { getJson, postJson } from "./knowledge";

type SourcesPhase = "error" | "loading" | "ready" | "unconfigured";

// Registered sources (refreshed every 15 s) and one sync at a time, polled
// every 2 s until it finishes.
export const useKnowledgeSources = () => {
  const [phase, setPhase] = useState<SourcesPhase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [syncBusy, setSyncBusy] = useState<string | null>(null);
  const [job, setJob] = useState<KnowledgeSyncJob | null>(null);
  const [jobMsg, setJobMsg] = useState<string | null>(null);

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
    setSources((body.sources ?? []) as KnowledgeSource[]);
    setPhase("ready");
  }, []);

  useEffect(() => {
    loadSources();
    const id = setInterval(loadSources, 15_000);
    return () => clearInterval(id);
  }, [loadSources]);

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
      const next = body as unknown as KnowledgeSyncJob;
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

  return {
    errorMsg,
    job,
    jobMsg,
    loadSources,
    phase,
    sources,
    syncBusy,
    triggerSync,
  };
};
