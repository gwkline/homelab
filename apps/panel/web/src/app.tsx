import {
  RefreshCw,
  Rocket,
  Hash,
  Factory,
  GitPullRequest,
  Play,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ClusterCard } from "./components/cluster-card";
import { DevToolsCard } from "./components/dev-tools-card";
import { FactoryHealthCard } from "./components/factory-health-card";
import { JobsTable } from "./components/jobs-table";
import { ScheduleRow } from "./components/schedule-row";
import { Card, CardHeader, Badge, Button, Input } from "./components/ui";

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
  const [state, setState] = useState<State>({ cronjobs: [], jobs: [] });
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState("");
  const [issue, setIssue] = useState("");
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
  const [launchRepo, setLaunchRepo] = useState("gwkline/homelab");

  const refresh = async () => {
    try {
      const res = await fetch("/api/state");
      setState(await res.json());
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
        res = await fetch("/api/factory/review", {
          body: JSON.stringify({
            body: "Ready for review — flipping draft via panel",
            event: "COMMENT",
            pr: pr.number,
            repo: factoryRepo,
          }),
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
          action === "merge"
            ? `merged #${pr.number} (${body.strategy ?? "squash"})`
            : `${action} recorded on #${pr.number}`
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

  const launch = async () => {
    if (!command.trim()) {
      return;
    }
    setLaunching(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        body: JSON.stringify({
          command,
          issue: issue || undefined,
          repo: issue ? launchRepo : undefined,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await res.json();
      setMessage(res.ok ? `dispatched ${body.name}` : body.error);
      if (res.ok) {
        setCommand("");
        setIssue("");
        refresh();
      }
    } finally {
      setLaunching(false);
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

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">homelab factory</h1>
          <p className="text-muted-foreground text-xs">sandbox workloads</p>
        </div>
        <Button
          onClick={refresh}
          className="bg-muted text-foreground hover:opacity-80"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />{" "}
          refresh
        </Button>
      </header>

      <DevToolsCard />

      <FactoryHealthCard repo={factoryRepo} />

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
            <p className="text-muted-foreground text-sm">loading repos…</p>
          )}
          <div className="space-y-2">
            {allIssues.map(({ repo, issues, error }) => {
              const expanded = openRepo === repo;
              const queuedCount = issues.filter((fi) =>
                fi.labels.some((l) => l.startsWith("factory/"))
              ).length;
              return (
                <div key={repo} className="border-border rounded-lg border">
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
                        const isQueued = fi.labels.includes("factory/queued");
                        const isInProgress = fi.labels.includes(
                          "factory/in-progress"
                        );
                        const isDone = fi.labels.includes("factory/draft-pr");
                        const disabled = isQueued || isInProgress || isDone;
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
                                  status={issueBadge(isQueued, isInProgress)}
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
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              className="border-border bg-background ml-2 rounded-md border px-2 py-1 text-xs"
              aria-label="profile"
            >
              <option value="code-pr">code-pr</option>
              <option value="security">security</option>
            </select>
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
              <select
                value={factoryRepo}
                onChange={(e) => setFactoryRepo(e.target.value)}
                className="border-border bg-background rounded-md border px-2 py-1 text-xs"
                aria-label="review repo"
              >
                {allIssues.map(({ repo }) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
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
          title="launch a run"
          subtitle="runs the loop-agent image in sandbox; results export themselves"
        />
        <div className="space-y-3 p-5">
          <Input
            placeholder="command, e.g. node /data/repos/homelab/examples/loop-hello.mjs"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && launch()}
          />
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Hash
                size={14}
                className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
              />
              <Input
                placeholder="issue # (optional)"
                value={issue}
                onChange={(e) =>
                  setIssue(e.target.value.replaceAll(/\D/gu, ""))
                }
                className="pl-8"
              />
            </div>
            <select
              value={launchRepo}
              onChange={(e) => setLaunchRepo(e.target.value)}
              className="border-border bg-background rounded-md border px-2 py-1 text-xs"
              aria-label="watcher repo"
            >
              {allIssues.map(({ repo }) => (
                <option key={repo} value={repo}>
                  {repo.split("/")[1]}
                </option>
              ))}
            </select>
            <Button onClick={launch} disabled={launching || !command.trim()}>
              <Rocket size={14} /> {launching ? "dispatching" : "dispatch"}
            </Button>
          </div>
          {message && (
            <p className="text-muted-foreground text-xs">{message}</p>
          )}
        </div>
      </Card>

      <ClusterCard />

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
    </main>
  );
}
