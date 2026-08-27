import { useEffect, useState } from "react";
import { RefreshCw, Rocket, Hash, Factory } from "lucide-react";
import { Card, CardHeader, Badge, Button, Input } from "./components/ui";

interface Job {
  name: string;
  status: string;
  issue: string | null;
  age: string;
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

export default function App() {
  const [state, setState] = useState<State>({ jobs: [], cronjobs: [] });
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState("");
  const [issue, setIssue] = useState("");
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [factoryIssues, setFactoryIssues] = useState<FactoryIssue[]>([]);
  const [factoryRepo] = useState("gwkline/launchpad");
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [selectedProfile, setSelectedProfile] = useState("code-pr");
  const [factoryRunning, setFactoryRunning] = useState(false);
  const [factoryMsg, setFactoryMsg] = useState<string | null>(null);

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
      const res = await fetch(`/api/factory/issues?repo=${encodeURIComponent(factoryRepo)}`);
      const body = await res.json();
      if (res.ok) setFactoryIssues(body.issues ?? []);
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

  const launch = async () => {
    if (!command.trim()) return;
    setLaunching(true);
    setMessage(null);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, issue: issue || undefined }),
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
    setFactoryRunning(true);
    setFactoryMsg(null);
    try {
      const res = await fetch("/api/factory/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issue: selectedIssue, repo: factoryRepo, profile: selectedProfile }),
      });
      const body = await res.json();
      if (res.ok) {
        setFactoryMsg(`queued #${body.issue} [${body.profile ?? selectedProfile}] → ${body.jobName ?? "scheduled (next tick)"} — watching…`);
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
          title="factory — run an issue"
          subtitle={`${factoryRepo} · pick an open issue and dispatch the orchestrator immediately (no 6h wait)`}
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
          <div className="max-h-64 divide-y divide-border overflow-auto rounded-lg border border-border">
            {factoryIssues.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">no open issues (or not loaded)</p>}
            {factoryIssues.map((fi) => {
              const isSelected = selectedIssue === fi.number;
              const isQueued = fi.labels.includes("factory/queued");
              const isInProgress = fi.labels.includes("factory/in-progress");
              const isDone = fi.labels.includes("factory/draft-pr");
              const disabled = isQueued || isInProgress || isDone;
              return (
                <button
                  key={fi.number}
                  onClick={() => !disabled && setSelectedIssue(isSelected ? null : fi.number)}
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
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedIssue != null ? `selected #${selectedIssue}` : "select an issue above"}
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
            <Button onClick={launch} disabled={launching || !command.trim()}>
              <Rocket size={14} /> {launching ? "dispatching" : "dispatch"}
            </Button>
          </div>
          {message && <p className="text-xs text-muted-foreground">{message}</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="jobs" subtitle={`${state.jobs.length} in sandbox`} />
        <div className="divide-y divide-border">
          {state.jobs.length === 0 && (
            <p className="px-5 py-6 text-sm text-muted-foreground">
              {state.error ? `cluster unreachable: ${state.error}` : "no jobs yet"}
            </p>
          )}
          {state.jobs.map((j) => (
            <div key={j.name} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm">{j.name}</p>
                {j.issue && <p className="text-xs text-muted-foreground">issue #{j.issue}</p>}
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
