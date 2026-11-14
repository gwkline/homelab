import {
  ArrowRight,
  Brain,
  RefreshCw,
  Factory,
  GitPullRequest,
  LayoutDashboard,
  Play,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ClusterCard } from "./components/cluster-card";
import { DevToolsCard } from "./components/dev-tools-card";
import { FactoryHealthCard } from "./components/factory-health-card";
import { JobsTable } from "./components/jobs-table";
import { KnowledgeCard } from "./components/knowledge-card";
import { KnowledgeExplorer } from "./components/knowledge-explorer";
import { ScheduleRow } from "./components/schedule-row";
import { Card, CardHeader, Badge, Button, Select } from "./components/ui";

interface Job {
  name: string;
  status: string;
  issue: string | null;
  age: string;
  repo: string | null;
  kind: string;
  created: string | null;
}
interface CronJob {
  name: string;
  schedule: string;
  suspended: boolean;
  lastScheduled: string | null;
  active: number;
}
interface State {
  jobs: Job[];
  cronjobs: CronJob[];
  error?: string;
}
interface FactoryIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}
interface ReviewPr {
  number: number;
  title: string;
  headRef: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string;
  state: string;
  checks: { state: string };
  labels: string[];
  linkedIssue: number | null;
}

// Badge state for a factory-labeled issue in the dispatch list.
const issueBadge = (isQueued: boolean, isInProgress: boolean): string => {
  if (isQueued) {
    return "queued";
  }
  if (isInProgress) {
    return "running";
  }
  return "complete";
};

// Badge state for a factory PR in the review queue.
const reviewBadge = (pr: ReviewPr): string => {
  if (pr.isDraft) {
    return "draft";
  }
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return "failed";
  }
  if (pr.reviewDecision === "APPROVED") {
    return "complete";
  }
  const pending = pr.checks?.state === "pending" || pr.checks?.state === "none";
  return pending ? "running" : "queued";
};

export default function App() {
  const [view, setView] = useState<"overview" | "factory" | "knowledge">(
    "overview"
  );
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState<State>({ cronjobs: [], jobs: [] });
  const [loading, setLoading] = useState(true);
  const [allIssues, setAllIssues] = useState<
    { repo: string; issues: FactoryIssue[]; error?: string }[]
  >([]);
  const [factoryRepo, setFactoryRepo] = useState("gwkline/launchpad");
  // "repo#num" — the issue picked for a factory run
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("code-pr");
  const [factoryRunning, setFactoryRunning] = useState(false);
  const [factoryMsg, setFactoryMsg] = useState<string | null>(null);
  const [reviewPrs, setReviewPrs] = useState<ReviewPr[]>([]);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [openRepo, setOpenRepo] = useState<string | null>("gwkline/launchpad");

  const refresh = async () => {
    try {
      const res = await fetch("/api/state");
      const body = await res.json();
      setState(
        res.ok
          ? body
          : {
              cronjobs: [],
              error: body.error ?? "workloads unavailable",
              jobs: [],
            }
      );
    } catch (error) {
      setState({ cronjobs: [], error: String(error), jobs: [] });
    }
    setLoading(false);
  };

  const refreshFactoryIssues = async () => {
    try {
      const res = await fetch("/api/factory/all-issues");
      const body = await res.json();
      if (res.ok) {
        setAllIssues(body.repos ?? []);
      } else {
        setFactoryMsg(body.error ?? "failed to load issues");
      }
    } catch (error) {
      setFactoryMsg(String(error));
    }
  };

  useEffect(() => {
    refresh();
    refreshFactoryIssues();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, []);

  // ── Review Queue ──────────────────────────────────────────────────────
  const refreshReviewQueue = async () => {
    try {
      const res = await fetch(
        `/api/factory/prs?repo=${encodeURIComponent(factoryRepo)}`
      );
      const body = await res.json();
      if (res.ok) {
        setReviewPrs(body.prs ?? []);
      } else {
        setReviewMsg(body.error ?? "failed to load PRs");
      }
    } catch (error) {
      setReviewMsg(String(error));
    }
  };

  const reviewAction = async (
    pr: ReviewPr,
    action: "approve" | "changes" | "ready" | "merge"
  ) => {
    setReviewBusy(`${factoryRepo}#${pr.number}`);
    setReviewMsg(null);
    try {
      let res: Response;
      if (action === "approve" || action === "changes") {
        res = await fetch("/api/factory/review", {
          body: JSON.stringify({
            body:
              action === "approve"
                ? "LGTM via panel review queue"
                : "Changes requested via panel",
            event: action === "approve" ? "APPROVE" : "REQUEST_CHANGES",
            pr: pr.number,
            repo: factoryRepo,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      } else if (action === "ready") {
        res = await fetch("/api/factory/ready", {
          body: JSON.stringify({ pr: pr.number, repo: factoryRepo }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      } else {
        res = await fetch("/api/factory/merge", {
          body: JSON.stringify({
            pr: pr.number,
            repo: factoryRepo,
            strategy: "squash",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
      }
      const body = await res.json();
      if (res.ok) {
        setReviewMsg(
          {
            approve: `approved #${pr.number}`,
            changes: `requested changes on #${pr.number}`,
            merge: `merged #${pr.number} (${body.strategy ?? "squash"})`,
            ready: `#${pr.number} is ready for review`,
          }[action]
        );
      } else {
        setReviewMsg(body.error ?? `action failed on #${pr.number}`);
      }
      refreshReviewQueue();
      refreshFactoryIssues();
      refresh();
    } catch (error) {
      setReviewMsg(String(error));
    } finally {
      setReviewBusy(null);
    }
  };

  const runFactory = async (issueStr?: string) => {
    const target = issueStr ?? selectedIssue;
    if (target === null) {
      return;
    }
    const [repo, numStr] = target.split("#");
    setFactoryRunning(true);
    setFactoryMsg(null);
    try {
      const res = await fetch("/api/factory/run", {
        body: JSON.stringify({
          issue: Number(numStr),
          profile: selectedProfile,
          repo,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await res.json();
      if (res.ok) {
        setFactoryMsg(
          `queued ${repo}#${body.issue} [${body.profile ?? selectedProfile}] → ${body.jobName ?? "scheduled (next tick)"} — watching…`
        );
        if (!issueStr) {
          setSelectedIssue(null);
        }
        refresh();
        refreshFactoryIssues();
      } else {
        setFactoryMsg(body.error ?? "failed");
      }
    } catch (error) {
      setFactoryMsg(String(error));
    } finally {
      setFactoryRunning(false);
    }
  };

  let workloadSummary = `${state.jobs.filter((job) => job.status === "running").length} running jobs · ${state.jobs.filter((job) => job.status === "failed").length} failed · ${state.cronjobs.filter((job) => !job.suspended).length} active schedules`;
  if (loading) {
    workloadSummary = "Loading workloads…";
  }
  if (state.error) {
    workloadSummary = "Workload status unavailable";
  }

  return (
    <main
      id="main"
      className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-10"
    >
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-primary mb-1 text-xs font-medium tracking-widest uppercase">
            Panel
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Homelab</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Services, cluster &amp; automation
          </p>
        </div>
        <Button
          onClick={() => {
            setLoading(true);
            refresh();
            setRefreshKey((key) => key + 1);
          }}
          className="bg-muted text-foreground hover:opacity-80"
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />{" "}
          Refresh
        </Button>
      </header>
      <nav
        aria-label="Main navigation"
        className="border-border flex flex-wrap gap-2 border-b pb-4"
      >
        <Button
          onClick={() => setView("overview")}
          aria-pressed={view === "overview"}
          className={
            view === "overview"
              ? ""
              : "bg-muted text-foreground hover:opacity-80"
          }
        >
          <LayoutDashboard size={14} /> Overview
        </Button>
        <Button
          onClick={() => setView("factory")}
          aria-pressed={view === "factory"}
          className={
            view === "factory"
              ? ""
              : "bg-muted text-foreground hover:opacity-80"
          }
        >
          <Factory size={14} /> Factory
        </Button>
        <Button
          onClick={() => setView("knowledge")}
          aria-pressed={view === "knowledge"}
          className={
            view === "knowledge"
              ? ""
              : "bg-muted text-foreground hover:opacity-80"
          }
        >
          <Brain size={14} /> Knowledge
        </Button>
      </nav>
      <div id="content" tabIndex={-1} className="space-y-6">
        {view === "overview" && (
          <>
            <ClusterCard refreshKey={refreshKey} />
            <DevToolsCard refreshKey={refreshKey} />
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <div className="flex h-full flex-col items-start gap-3 p-5">
                  <Factory size={20} className="text-primary" />
                  <div>
                    <h2 className="font-semibold">Automation</h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Dispatch issues, review pull requests, and manage sandbox
                      jobs.
                    </p>
                  </div>
                  <p className="text-muted-foreground text-xs" role="status">
                    {workloadSummary}
                  </p>
                  <Button
                    onClick={() => setView("factory")}
                    className="mt-auto"
                  >
                    Open factory <ArrowRight size={14} />
                  </Button>
                </div>
              </Card>
              <Card>
                <div className="flex h-full flex-col items-start gap-3 p-5">
                  <Brain size={20} className="text-primary" />
                  <div>
                    <h2 className="font-semibold">Knowledge</h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Search the homelab corpus with citations and inspect
                      source history.
                    </p>
                  </div>
                  <Button
                    onClick={() => setView("knowledge")}
                    className="bg-muted text-foreground mt-auto"
                  >
                    Search knowledge <ArrowRight size={14} />
                  </Button>
                </div>
              </Card>
            </div>
          </>
        )}

        {view === "knowledge" && <KnowledgeExplorer />}

        {view === "factory" && (
          <>
            <KnowledgeCard onOpenExplorer={() => setView("knowledge")} />

            <FactoryHealthCard
              onRepoChange={setFactoryRepo}
              repo={factoryRepo}
              repos={allIssues.map(({ repo }) => repo)}
            />

            <Card>
              <CardHeader
                title="factory — issues across all repos"
                subtitle="pick any open issue and dispatch the orchestrator immediately · label it factory/queued to auto-pickup on the next tick"
                action={
                  <Button
                    onClick={refreshFactoryIssues}
                    className="bg-muted text-foreground h-7 px-2 py-1 text-xs hover:opacity-80"
                  >
                    <RefreshCw size={12} /> reload
                  </Button>
                }
              />
              <div className="space-y-3 p-5">
                {allIssues.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    loading repos…
                  </p>
                )}
                <div className="space-y-2">
                  {allIssues.map(({ repo, issues, error }) => {
                    const expanded = openRepo === repo;
                    const queuedCount = issues.filter((fi) =>
                      fi.labels.some((l) => l.startsWith("factory/"))
                    ).length;
                    return (
                      <div
                        key={repo}
                        className="border-border rounded-lg border"
                      >
                        <button
                          onClick={() => setOpenRepo(expanded ? null : repo)}
                          className="hover:bg-muted/50 flex w-full items-center justify-between px-3 py-2 text-left text-sm"
                        >
                          <span className="font-mono font-medium">{repo}</span>
                          <span className="text-muted-foreground flex items-center gap-2 text-xs">
                            {error ? <Badge status="failed" /> : null}
                            {queuedCount > 0 && <Badge status="running" />}
                            {issues.length} open
                            <span className="ml-1">{expanded ? "▾" : "▸"}</span>
                          </span>
                        </button>
                        {expanded && (
                          <div className="divide-border border-border max-h-64 divide-y overflow-auto rounded-b-lg border-t">
                            {error && (
                              <p className="text-destructive px-3 py-3 text-xs">
                                {error}
                              </p>
                            )}
                            {!error && issues.length === 0 && (
                              <p className="text-muted-foreground px-3 py-3 text-xs">
                                no open issues
                              </p>
                            )}
                            {issues.map((fi) => {
                              const key = `${repo}#${fi.number}`;
                              const isSelected = selectedIssue === key;
                              const isQueued =
                                fi.labels.includes("factory/queued");
                              const isInProgress = fi.labels.includes(
                                "factory/in-progress"
                              );
                              const isDone =
                                fi.labels.includes("factory/draft-pr");
                              const disabled =
                                isQueued || isInProgress || isDone;
                              return (
                                <div
                                  key={key}
                                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${isSelected ? "bg-primary/10" : "hover:bg-muted/50"}`}
                                >
                                  <button
                                    onClick={() =>
                                      !disabled &&
                                      setSelectedIssue(isSelected ? null : key)
                                    }
                                    disabled={disabled}
                                    className={`flex min-w-0 flex-1 items-start justify-between gap-3 text-left ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                                  >
                                    <span className="min-w-0">
                                      <span className="font-mono font-medium">
                                        #{fi.number}
                                      </span>{" "}
                                      {fi.title}
                                      <span className="text-muted-foreground ml-2 text-xs">
                                        {fi.labels.join(", ") || "no labels"}
                                      </span>
                                    </span>
                                    {disabled && (
                                      <Badge
                                        status={issueBadge(
                                          isQueued,
                                          isInProgress
                                        )}
                                      />
                                    )}
                                  </button>
                                  {!disabled && (
                                    <button
                                      onClick={() => runFactory(key)}
                                      title="run code-pr on this issue now"
                                      className="text-muted-foreground hover:bg-success/10 hover:text-success shrink-0 rounded p-1"
                                    >
                                      <Play size={13} />
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {selectedIssue === null
                      ? "select an issue above"
                      : `selected ${selectedIssue}`}
                  </span>
                  <Select
                    ariaLabel="profile"
                    value={selectedProfile}
                    onChange={setSelectedProfile}
                    options={[
                      { label: "code-pr", value: "code-pr" },
                      { label: "security", value: "security" },
                    ]}
                  />
                  <div className="ml-auto" />
                  <Button
                    onClick={() => runFactory()}
                    disabled={factoryRunning || selectedIssue === null}
                  >
                    <Factory size={14} />{" "}
                    {factoryRunning ? "queuing…" : `run ${selectedProfile}`}
                  </Button>
                </div>
                {factoryMsg && (
                  <p className="text-muted-foreground text-xs">{factoryMsg}</p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="review queue"
                subtitle={`${factoryRepo} · factory draft PRs — approve & merge without leaving the panel`}
                action={
                  <div className="flex items-center gap-2">
                    <Select
                      ariaLabel="review repo"
                      value={factoryRepo}
                      onChange={setFactoryRepo}
                      options={allIssues.map(({ repo }) => ({
                        label: repo,
                        value: repo,
                      }))}
                    />
                    <Button
                      onClick={refreshReviewQueue}
                      className="bg-muted text-foreground h-7 px-2 py-1 text-xs hover:opacity-80"
                    >
                      <RefreshCw size={12} /> reload
                    </Button>
                  </div>
                }
              />
              <div className="divide-border divide-y">
                {reviewPrs.length === 0 && (
                  <p className="text-muted-foreground px-5 py-4 text-sm">
                    no open factory PRs (or not loaded)
                  </p>
                )}
                {reviewPrs.map((pr) => {
                  const checksGreen = pr.checks?.state === "success";
                  const approved = pr.reviewDecision === "APPROVED";
                  const canMerge = !pr.isDraft && approved && checksGreen;
                  const busy = reviewBusy === `${factoryRepo}#${pr.number}`;
                  return (
                    <div key={pr.number} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-sm hover:underline"
                          >
                            <GitPullRequest
                              size={12}
                              className="text-muted-foreground mr-1 inline"
                            />
                            <span className="font-mono font-medium">
                              #{pr.number}
                            </span>{" "}
                            {pr.title}
                          </a>
                          <p className="text-muted-foreground text-xs">
                            {pr.headRef}
                            {pr.linkedIssue !== null && (
                              <> · issue #{pr.linkedIssue}</>
                            )}
                            {" · "}checks {pr.checks?.state ?? "?"}
                          </p>
                        </div>
                        <Badge status={reviewBadge(pr)} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {!approved && (
                          <Button
                            onClick={() => reviewAction(pr, "approve")}
                            disabled={busy}
                            className="bg-success/15 text-success border-success/30 hover:bg-success/25 h-7 border px-2 py-1 text-xs"
                          >
                            approve
                          </Button>
                        )}
                        <Button
                          onClick={() => reviewAction(pr, "changes")}
                          disabled={busy}
                          className="bg-muted text-foreground border-border h-7 border px-2 py-1 text-xs hover:opacity-80"
                        >
                          request changes
                        </Button>
                        {pr.isDraft && (
                          <Button
                            onClick={() => reviewAction(pr, "ready")}
                            disabled={busy}
                            className="bg-muted text-foreground border-border h-7 border px-2 py-1 text-xs hover:opacity-80"
                          >
                            ready for review
                          </Button>
                        )}
                        <Button
                          onClick={() => reviewAction(pr, "merge")}
                          disabled={busy || !canMerge}
                          title={
                            canMerge
                              ? "squash merge"
                              : "needs: draft off + APPROVED + green checks"
                          }
                          className="h-7 px-2 py-1 text-xs"
                        >
                          {busy ? "…" : "merge (squash)"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {reviewMsg && (
                  <p className="text-muted-foreground px-5 py-2 text-xs">
                    {reviewMsg}
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="jobs"
                subtitle={`${state.jobs.length} in sandbox — sort, filter, clean up`}
              />
              <div className="p-4">
                {state.error ? (
                  <p className="text-destructive text-sm">
                    cluster unreachable: {state.error}
                  </p>
                ) : (
                  <JobsTable
                    jobs={state.jobs}
                    onDelete={async (name) => {
                      await fetch(`/api/jobs/${encodeURIComponent(name)}`, {
                        // Every mutating /api route requires a JSON content type.
                        headers: { "content-type": "application/json" },
                        method: "DELETE",
                      });
                      refresh();
                    }}
                  />
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="schedules"
                subtitle="cronjobs in sandbox — edit schedule, pause/resume"
              />
              <div className="divide-border divide-y">
                {state.cronjobs.map((cj) => (
                  <ScheduleRow key={cj.name} cj={cj} onSaved={refresh} />
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </main>
  );
}
