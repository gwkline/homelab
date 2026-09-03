import { useEffect, useState } from "react";

import { Badge, Card, CardHeader } from "./ui";

interface FactoryStats {
  cached?: boolean;
  generatedAt: string;
  queue: {
    draftPr: number;
    failed: number;
    inProgress: number;
    queued: number;
  };
  repo: string;
  totals: {
    additions: number;
    approvedOpen: number;
    ciGreen: number;
    ciPassRate: number | null;
    commits: number;
    deletions: number;
    factoryPrs: number;
    factoryShare: number | null;
    loc: number;
    mergeRate: number | null;
    merged: number;
    open: number;
    reviewRate: number | null;
  };
  weekly: { loc: number; merged: number; week: string }[];
}

const pct = (v: number | null): string =>
  v === null ? "—" : `${Math.round(v * 100)}%`;

const num = (v: number): string => v.toLocaleString("en-US");

const Stat = ({
  label,
  value,
  sub,
}: {
  label: string;
  sub?: string;
  value: string;
}) => (
  <div className="bg-muted/40 rounded-lg px-3 py-2">
    <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
      {label}
    </p>
    <p className="text-lg font-semibold tabular-nums">{value}</p>
    {sub && <p className="text-muted-foreground text-xs">{sub}</p>}
  </div>
);

const barPx = (merged: number, max: number): number =>
  merged === 0 ? 4 : Math.max(8, Math.round((merged / max) * 64));

export const FactoryHealthCard = ({ repo }: { repo: string }) => {
  const [stats, setStats] = useState<FactoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/factory/stats?repo=${encodeURIComponent(repo)}`
        );
        const body = await res.json();
        if (!live) {
          return;
        }
        if (res.ok) {
          setStats(body);
          setError(null);
        } else {
          setError(body.error ?? "failed to load stats");
        }
      } catch (loadError) {
        if (live) {
          setError(String(loadError));
        }
      }
    };
    setStats(null);
    setError(null);
    load();
    const id = setInterval(load, 120_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [repo]);

  const maxMerged = Math.max(1, ...(stats?.weekly.map((w) => w.merged) ?? [1]));

  return (
    <Card>
      <CardHeader
        title="factory health"
        subtitle={
          stats
            ? `${stats.repo} · ${stats.totals.merged}/${stats.totals.factoryPrs} merged${stats.cached ? " · cached" : ""}`
            : `${repo} · loading…`
        }
      />
      {error !== null && (
        <p className="text-destructive px-5 py-4 text-sm">{error}</p>
      )}
      {error === null && stats === null && (
        <p className="text-muted-foreground px-5 py-4 text-sm">
          crunching factory numbers…
        </p>
      )}
      {stats !== null && (
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="auto commits"
              sub={`${stats.totals.factoryPrs} factory PRs`}
              value={num(stats.totals.commits)}
            />
            <Stat
              label="auto LOC"
              sub={`+${num(stats.totals.additions)} / -${num(stats.totals.deletions)}`}
              value={num(stats.totals.loc)}
            />
            <Stat
              label="review rate"
              sub={`${stats.totals.approvedOpen}/${stats.totals.open} open approved`}
              value={pct(stats.totals.reviewRate)}
            />
            <Stat
              label="merge rate"
              sub={`${stats.totals.merged} merged`}
              value={pct(stats.totals.mergeRate)}
            />
            <Stat
              label="CI pass"
              sub={`${stats.totals.ciGreen}/${stats.totals.open} open green`}
              value={pct(stats.totals.ciPassRate)}
            />
            <Stat
              label="factory share"
              sub="of all PRs"
              value={pct(stats.totals.factoryShare)}
            />
            <div className="bg-muted/40 col-span-2 rounded-lg px-3 py-2">
              <p className="text-muted-foreground text-[11px] tracking-wide uppercase">
                queue
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="flex items-center gap-1">
                  queued {stats.queue.queued} <Badge status="queued" />
                </span>
                <span className="flex items-center gap-1">
                  running {stats.queue.inProgress} <Badge status="running" />
                </span>
                <span className="flex items-center gap-1">
                  draft-pr {stats.queue.draftPr} <Badge status="draft" />
                </span>
                <span className="flex items-center gap-1">
                  failed {stats.queue.failed} <Badge status="failed" />
                </span>
              </div>
            </div>
          </div>
          <div>
            <p className="text-muted-foreground mb-2 text-[11px] tracking-wide uppercase">
              merges / week (last 8)
            </p>
            <div className="flex items-end gap-1.5">
              {stats.weekly.map((w) => (
                <div
                  key={w.week}
                  title={`${w.week}: ${w.merged} merged, ${num(w.loc)} LOC`}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                >
                  <span className="text-muted-foreground text-[10px] tabular-nums">
                    {w.merged > 0 ? w.merged : ""}
                  </span>
                  <div
                    className="bg-primary/70 w-full rounded-sm"
                    style={{ height: `${barPx(w.merged, maxMerged)}px` }}
                  />
                  <span className="text-muted-foreground text-[10px]">
                    {w.week.slice(5).replace("-", "/")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
