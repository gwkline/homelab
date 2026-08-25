import { useEffect, useState } from "react";
import { RefreshCw, Rocket, Hash } from "lucide-react";
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

export default function App() {
  const [state, setState] = useState<State>({ jobs: [], cronjobs: [] });
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState("");
  const [issue, setIssue] = useState("");
  const [launching, setLaunching] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch("/api/state");
      setState(await res.json());
    } catch (e) {
      setState({ jobs: [], cronjobs: [], error: String(e) });
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
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
