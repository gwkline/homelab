import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, CardHeader } from "./ui";

interface WeeklyMerge {
  label: string;
  merged: number;
}

interface FactoryStats {
  autonomous: { additions: number; commits: number; deletions: number };
  ci: { green: number; total: number };
  merge: { merged: number; total: number };
  queue: { draftPr: number; inProgress: number; queued: number };
  repo: string;
  review: { approved: number; total: number };
  weeklyMerges: WeeklyMerge[];
}

const num = (n: number): string => n.toLocaleString("en-US");

const pctStr = (part: number, total: number): string =>
  total > 0 ? `${Math.round((part / total) * 100)}%` : "—";

// Badge tones only cover complete/failed/running; anything else renders muted.
const ciBadge = (ci: FactoryStats["ci"]): string => {
  if (ci.total === 0) {
    return "no checks";
  }
  return ci.green === ci.total ? "complete" : "failed";
};

const queueBadge = (q: FactoryStats["queue"]): string => {
  if (q.inProgress > 0) {
    return "running";
  }
  return q.queued > 0 ? "queued" : "complete";
};

const StatTile = ({
  badge,
  label,
  sub,
  value,
}: {
  badge?: ReactNode;
  label: string;
  sub?: string;
  value: string;
}) => (
  <div className="border-border bg-background/40 flex min-w-0 flex-col gap-1 rounded-lg border p-3">
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground truncate text-xs">{label}</span>
      {badge}
    </div>
    <span className="truncate text-lg font-semibold tabular-nums">{value}</span>
    {sub !== undefined && (
      <span className="text-muted-foreground truncate text-[10px]">{sub}</span>
    )}
  </div>
);

// Lightweight weekly merge trend: proportional divs, no chart lib.
const MergeTrend = ({ weeks }: { weeks: WeeklyMerge[] }) => {
  const max = Math.max(1, ...weeks.map((w) => w.merged));
  return (
    <div className="border-border bg-background/40 col-span-2 rounded-lg border p-3 sm:col-span-3">
      <span className="text-muted-foreground text-xs">weekly merge trend</span>
      <div className="mt-2 flex h-20 gap-2">
        {weeks.map((w) => (
          <div
            key={w.label}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
          >
            <span className="text-muted-foreground text-[10px] tabular-nums">
              {w.merged}
            </span>
            <div className="flex w-full flex-1 items-end">
              <div
                className={`w-full rounded-sm ${w.merged > 0 ? "bg-primary/70" : "bg-muted"}`}
                style={{ height: `${Math.max((w.merged / max) * 100, 3)}%` }}
              />
            </div>
            <span className="text-muted-foreground text-[10px]">{w.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const FactoryHealthCard = ({
  onRepoChange,
  repo,
  repos,
}: {
  onRepoChange: (repo: string) => void;
  repo: string;
  repos: string[];
}) => {
  const [stats, setStats] = useState<FactoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/factory/stats?repo=${encodeURIComponent(repo)}`
      );
      const body = await res.json();
      if (res.ok) {
        setStats(body);
        setError(null);
      } else {
        setError(body.error ?? "failed to load factory stats");
      }
    } catch (loadError) {
      setError(String(loadError));
    } finally {
      setLoading(false);
    }
  }, [repo]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader
        title="factory health"
        subtitle={`${repo} · what the factory produced lately — commits/LOC from recent merged PRs, rates from open + closed factory PRs`}
        action={
          <div className="flex items-center gap-2">
            <select
              value={repo}
              onChange={(e) => onRepoChange(e.target.value)}
              className="border-border bg-background rounded-md border px-2 py-1 text-xs"
              aria-label="stats repo"
            >
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <Button
              onClick={load}
              className="bg-muted text-foreground h-7 px-2 py-1 text-xs hover:opacity-80"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />{" "}
              reload
            </Button>
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">
        {error !== null && (
          <p className="text-destructive text-sm sm:col-span-3">{error}</p>
        )}
        {error === null && stats === null && (
          <p className="text-muted-foreground text-sm sm:col-span-3">
            loading stats…
          </p>
        )}
        {error === null && stats !== null && (
          <>
            <StatTile
              label="autonomous commits"
              value={num(stats.autonomous.commits)}
              sub="recent merged factory PRs"
            />
            <StatTile
              label="autonomous LOC"
              value={`+${num(stats.autonomous.additions)}`}
              sub={`−${num(stats.autonomous.deletions)} removed`}
            />
            <StatTile
              label="review rate"
              value={pctStr(stats.review.approved, stats.review.total)}
              sub={`${stats.review.approved}/${stats.review.total} open PRs approved`}
            />
            <StatTile
              label="merge rate"
              value={pctStr(stats.merge.merged, stats.merge.total)}
              sub={`${stats.merge.merged}/${stats.merge.total} closed PRs merged`}
            />
            <StatTile
              label="CI pass"
              badge={<Badge status={ciBadge(stats.ci)} />}
              value={pctStr(stats.ci.green, stats.ci.total)}
              sub={`${stats.ci.green}/${stats.ci.total} PRs with checks green`}
            />
            <StatTile
              label="queue depth"
              badge={<Badge status={queueBadge(stats.queue)} />}
              value={num(stats.queue.queued + stats.queue.inProgress)}
              sub={`${stats.queue.queued} queued · ${stats.queue.inProgress} running · ${stats.queue.draftPr} draft`}
            />
            <MergeTrend weeks={stats.weeklyMerges} />
          </>
        )}
      </div>
    </Card>
  );
};
