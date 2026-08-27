import { useEffect, useState } from "react";
import { RefreshCw, Rocket, Hash, Factory, GitPullRequest } from "lucide-react";
import { Card, CardHeader, Badge, Button, Input } from "./components/ui";

interface Job {
  name: string;
  status: string;
  issue: string | null;
  age: string;
  repo: string | null;
  kind: string;
}
interface CronJob {
  name: string;
  schedule: string;
  suspended: boolean;
  lastScheduled: string | null;
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

export default function App() {
  const [state, setState] = useState<State>({ jobs: [], cronjobs: [] });
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState("");
  const [issue, setIssue] = useState("");
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [allIssues, setAllIssues] = useState<Array<{ repo: string; issues: FactoryIssue[]; error?: string }>>([]);
  const [factoryRepo, setFactoryRepo] = useState("gwkline/launchpad");
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null); // "repo#num"
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
    } catch (e) {
      setState({ jobs: [], cronjobs: [], error: String(e) });
    }
    setLoading(false);
  };

  const refreshFactoryIssues = async () => {
    try {
      const res = await fetch("/api/factory/all-issues");
      const body = await res.json();
      if (res.ok) setAllIssues(body.repos ?? []);
      else setFactoryMsg(body.error ?? "failed to load issues");
    } catch (e) {
      setFactoryMsg(String(e));
    }
  };

  useEffect(() => {
    refresh();
    refreshFactoryIssues();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, []);

  // ── Review Queue ──────────────────────────────────────────────────────
  const refreshReviewQueue = async () => {
    try {
      const res = await fetch(`/api/factory/prs?repo=${encodeURIComponent(factoryRepo)}`);
      const body = await res.json();
      if (res.ok) setReviewPrs(body.prs ?? []);
      else setReviewMsg(body.error ?? "failed to load PRs");
    } catch (e) {
      setReviewMsg(String(e));
    }
  };

  const reviewAction = async (pr: ReviewPr, action: "approve" | "changes" | "ready" | "merge") => {
    setReviewBusy(`${factoryRepo}#${pr.number}`);
    setReviewMsg(null);
    try {
      let res: Response;
      if (action === "approve" || action === "changes") {
        res = await fetch("/api/factory/review", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            repo: factoryRepo, pr: pr.number,
            event: action === "approve" ? "APPROVE" : "REQUEST_CHANGES",
            body: action === "approve" ? "LGTM via panel review queue" : "Changes requested via panel",
          }),
        });
      } else if (action === "ready") {
        res = await fetch(`/api/factory/review`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: factoryRepo, pr: pr.number, event: "COMMENT", body: "Ready for review — flipping draft via panel" }),
        });
      } else {
        res = await fetch("/api/factory/merge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo: factoryRepo, pr: pr.number, strategy: "squash" }),
        });
      }
      const body = await res.json();
      if (res.ok) {
        setReviewMsg(
          action === "merge"
            ? `merged #${pr.number} (${body.strategy ?? "squash"})`
            : `${action} recorded on #${pr.number}`,
        );
      } else {
        setReviewMsg(body.error ?? `action failed on #${pr.number}`);
      }
      refreshReviewQueue();
      refreshFactoryIssues();
      refresh();
    } catch (e) {
      setReviewMsg(String(e));
    } finally {
      setReviewBusy(null);
    }
  };

  const launch = async () => {
    if (!command.trim()) return;
    setLaunching(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, issue: issue || undefined, repo: issue ? launchRepo : undefined }),
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

  const runFactory = async () => {
    if (selectedIssue == null) return;
    const [repo, numStr] = selectedIssue.split("#");
    setFactoryRunning(true);
    setFactoryMsg(null);
    try {
      const res = await fetch("/api/factory/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issue: Number(numStr), repo, profile: selectedProfile }),
      });
      const body = await res.json();
      if (res.ok) {
        setFactoryMsg(`queued ${repo}#${body.issue} [${body.profile ?? selectedProfile}] → ${body.jobName ?? "scheduled (next tick)"} — watching…`);
        setSelectedIssue(null);
        refresh();
        refreshFactoryIssues();
      } else {
        setFactoryMsg(body.error ?? "failed");
      }
    } catch (e) {
      setFactoryMsg(String(e));
    } finally {
      setFactoryRunning(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">homelab factory</h1>
          <p className="text-xs text-muted-foreground">sandbox workloads</p>
        </div>
        <Button onClick={refresh} className="bg-muted text-foreground hover:opacity-80">
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> refresh
        </Button>
      </header>

      <Card>
        <CardHeader
          title="factory — issues across all repos"
          subtitle="pick any open issue and dispatch the orchestrator immediately · label it factory/queued to auto-pickup on the next tick"
          action={
            <Button
              onClick={refreshFactoryIssues}
              className="bg-muted text-foreground hover:opacity-80 h-7 px-2 py-1 text-xs"
            >
              <RefreshCw size={12} /> reload
            </Button>
          }
        />
        <div className="space-y-3 p-5">
          {allIssues.length === 0 && <p className="text-sm text-muted-foreground">loading repos…</p>}
          <div className="space-y-2">
            {allIssues.map(({ repo, issues, error }) => {
              const expanded = openRepo === repo;
              const queuedCount = issues.filter((fi) => fi.labels.some((l) => l.startsWith("factory/"))).length;
              return (
                <div key={repo} className="rounded-lg border border-border">
                  <button
                    onClick={() => setOpenRepo(expanded ? null : repo)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    <span className="font-mono font-medium">{repo}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {error ? <Badge status="failed" /> : null}
                      {queuedCount > 0 && <Badge status="running" />}
                      {issues.length} open
                      <span className="ml-1">{expanded ? "▾" : "▸"}</span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="max-h-64 divide-y divide-border overflow-auto rounded-b-lg border-t border-border">
                      {error && <p className="px-3 py-3 text-xs text-destructive">{error}</p>}
                      {!error && issues.length === 0 && <p className="px-3 py-3 text-xs text-muted-foreground">no open issues</p>}
                      {issues.map((fi) => {
                        const key = `${repo}#${fi.number}`;
                        const isSelected = selectedIssue === key;
                        const isQueued = fi.labels.includes("factory/queued");
                        const isInProgress = fi.labels.includes("factory/in-progress");
                        const isDone = fi.labels.includes("factory/draft-pr");
                        const disabled = isQueued || isInProgress || isDone;
                        return (
                          <button
                            key={key}
                            onClick={() => !disabled && setSelectedIssue(isSelected ? null : key)}
                            disabled={disabled}
                            className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${isSelected ? "bg-primary/10" : "hover:bg-muted/50"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                          >
                            <span className="min-w-0">
                              <span className="font-mono font-medium">#{fi.number}</span> {fi.title}
                              <span className="ml-2 text-xs text-muted-foreground">{fi.labels.join(", ") || "no labels"}</span>
                            </span>
                            {disabled && <Badge status={isQueued ? "queued" : isInProgress ? "running" : "complete"} />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedIssue != null ? `selected ${selectedIssue}` : "select an issue above"}
            </span>
            <select
              value={selectedProfile}
              onChange={(e) => setSelectedProfile(e.target.value)}
              className="ml-2 rounded-md border border-border bg-background px-2 py-1 text-xs"
              aria-label="profile"
            >
              <option value="code-pr">code-pr</option>
              <option value="security">security</option>
            </select>
            <div className="ml-auto" />
            <Button onClick={runFactory} disabled={factoryRunning || selectedIssue == null}>
              <Factory size={14} /> {factoryRunning ? "queuing…" : `run ${selectedProfile}`}
            </Button>
          </div>
          {factoryMsg && <p className="text-xs text-muted-foreground">{factoryMsg}</p>}
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
                className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                aria-label="review repo"
              >
                {allIssues.map(({ repo }) => (
                  <option key={repo} value={repo}>{repo}</option>
                ))}
              </select>
              <Button
                onClick={refreshReviewQueue}
                className="bg-muted text-foreground hover:opacity-80 h-7 px-2 py-1 text-xs"
              >
                <RefreshCw size={12} /> reload
              </Button>
            </div>
          }
        />
        <div className="divide-y divide-border">
          {reviewPrs.length === 0 && (
            <p className="px-5 py-4 text-sm text-muted-foreground">no open factory PRs (or not loaded)</p>
          )}
          {reviewPrs.map((pr) => {
            const checksGreen = pr.checks?.state === "success";
            const checksPending = pr.checks?.state === "pending" || pr.checks?.state === "none";
            const approved = pr.reviewDecision === "APPROVED";
            const changes = pr.reviewDecision === "CHANGES_REQUESTED";
            const badge = pr.isDraft ? "draft"
              : changes ? "failed"
              : approved ? "complete"
              : checksPending ? "running" : "queued";
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
                      <GitPullRequest size={12} className="mr-1 inline text-muted-foreground" />
                      <span className="font-mono font-medium">#{pr.number}</span> {pr.title}
                    </a>
                    <p className="text-xs text-muted-foreground">
                      {pr.headRef}
                      {pr.linkedIssue != null && <> · issue #{pr.linkedIssue}</>}
                      {" · "}checks {pr.checks?.state ?? "?"}
                    </p>
                  </div>
                  <Badge status={badge} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!approved && (
                    <Button
                      onClick={() => reviewAction(pr, "approve")}
                      disabled={busy}
                      className="h-7 px-2 py-1 text-xs bg-success/15 text-success border border-success/30 hover:bg-success/25"
                    >
                      approve
                    </Button>
                  )}
                  <Button
                    onClick={() => reviewAction(pr, "changes")}
                    disabled={busy}
                    className="h-7 px-2 py-1 text-xs bg-muted text-foreground border border-border hover:opacity-80"
                  >
                    request changes
                  </Button>
                  {pr.isDraft && (
                    <Button
                      onClick={() => reviewAction(pr, "ready")}
                      disabled={busy}
                      className="h-7 px-2 py-1 text-xs bg-muted text-foreground border border-border hover:opacity-80"
                    >
                      ready for review
                    </Button>
                  )}
                  <Button
                    onClick={() => reviewAction(pr, "merge")}
                    disabled={busy || !canMerge}
                    title={canMerge ? "squash merge" : "needs: draft off + APPROVED + green checks"}
                    className="h-7 px-2 py-1 text-xs"
                  >
                    {busy ? "…" : "merge (squash)"}
                  </Button>
                </div>
              </div>
            );
          })}
          {reviewMsg && <p className="px-5 py-2 text-xs text-muted-foreground">{reviewMsg}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="launch a run" subtitle="runs the loop-agent image in sandbox; results export themselves" />
        <div className="space-y-3 p-5">
          <Input
            placeholder="command, e.g. node /data/repos/homelab/examples/loop-hello.mjs"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && launch()}
          />
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="issue # (optional)"
                value={issue}
                onChange={(e) => setIssue(e.target.value.replace(/\D/g, ""))}
                className="pl-8"
              />
            </div>
            <select
              value={launchRepo}
              onChange={(e) => setLaunchRepo(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              aria-label="watcher repo"
            >
              {allIssues.map(({ repo }) => (
                <option key={repo} value={repo}>{repo.split("/")[1]}</option>
              ))}
            </select>
            <Button onClick={launch} disabled={launching || !command.trim()}>
              <Rocket size={14} /> {launching ? "dispatching" : "dispatch"}
            </Button>
          </div>
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="jobs" subtitle={`${state.jobs.length} in sandbox — factory runs + loop agents`} />
        <div className="divide-y divide-border">
          {state.jobs.length === 0 && (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {state.error ? `cluster unreachable: ${state.error}` : "no jobs yet"}
            </p>
          )}
          {state.jobs.map((j) => (
            <div key={j.name} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-muted-foreground">{j.name}</p>
                <p className="text-sm">
                  <span className="mr-2 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{j.kind}</span>
                  {j.repo && <span className="mr-1 font-mono text-xs">{j.repo}</span>}
                  {j.issue && <span className="text-xs">issue #{j.issue}</span>}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-muted-foreground">{j.age}</span>
                <Badge status={j.status} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="schedules" subtitle="cronjobs in sandbox" />
        <div className="divide-y divide-border">
          {state.cronjobs.map((cj) => (
            <div key={cj.name} className="flex items-center justify-between px-5 py-3">
              <div>
                <p className="font-mono text-sm">{cj.name}</p>
                <p className="text-xs text-muted-foreground">
                  {cj.suspended ? "suspended" : `last ${cj.lastScheduled ? new Date(cj.lastScheduled).toLocaleString() : "never"}`}
                </p>
              </div>
              <code className="rounded bg-muted px-2 py-1 text-xs">{cj.schedule}</code>
            </div>
          ))}
        </div>
      </Card>
    </main>
  );
}
