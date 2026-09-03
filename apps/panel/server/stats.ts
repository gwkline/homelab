// Factory stats: per-repo weekly buckets derived from the GitHub API, plus a
// weekly JSON snapshot artifact that survives the GitHub-derived window.
// Pure helpers live here so they are unit-testable without a server.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface RepoStats {
  issuesClosed: number[];
  issuesOpened: number[];
  openIssues: number;
  openPrs: number;
  prsMerged: number[];
  prsOpened: number[];
}

export interface RepoWeekStats {
  issuesClosed: number;
  issuesOpened: number;
  openIssues: number;
  openPrs: number;
  prsMerged: number;
  prsOpened: number;
}

export type StatsTotals = RepoWeekStats;

export interface StatsSnapshot {
  capturedAt: string;
  repos: Record<string, RepoWeekStats>;
  totals: StatsTotals;
  week: string;
}

export interface StatsStore {
  weeks: Record<string, StatsSnapshot>;
}

// Monday 00:00 UTC that starts the week containing `input`, as YYYY-MM-DD.
// Week keys are sortable identifiers: history ordering needs no date parsing.
export const weekStart = (input: Date | number | string): string => {
  const d = new Date(input);
  const back = d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1;
  d.setUTCDate(d.getUTCDate() - back);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};

// `count` week keys ending with the current week, oldest first.
export const weekKeysBack = (
  now: Date | number | string,
  count: number
): string[] => {
  const keys: string[] = [];
  const d = new Date(`${weekStart(now)}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    keys.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 7);
  }
  return keys;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Bucket a timestamp into the weekly series (`weeks` ascending). Returns -1
// for anything before the window; buckets are aligned to the week keys, so an
// index is a direct array position.
const bucketIndex = (ts: Date | number | string, weeks: string[]): number => {
  const start = Date.parse(`${weeks[0]}T00:00:00Z`);
  const idx = Math.floor((Date.parse(String(ts)) - start) / WEEK_MS);
  return idx >= 0 && idx < weeks.length ? idx : -1;
};

type GhFetcher = (route: string) => Promise<unknown>;

interface GhSearchResult {
  total_count?: number;
}
interface GhIssueItem {
  closed_at?: string | null;
  created_at: string;
  pull_request?: unknown;
}
interface GhPullItem {
  created_at: string;
  merged_at?: string | null;
}

const emptySeries = (n: number): number[] => Array.from({ length: n }, () => 0);

// One repo's stats over the weekly window. Open counts come from the search
// API's total_count (exact); weekly activity is bucketed locally from the two
// list endpoints. The lists cover the newest 100 items — far more than a
// factory repo sees in 8 weeks — so anything closed/merged inside the window
// is on page 1 even if it was created before the window.
export const collectRepoStats = async (
  repo: string,
  weeks: string[],
  ghFetch: GhFetcher
): Promise<RepoStats> => {
  const stats: RepoStats = {
    issuesClosed: emptySeries(weeks.length),
    issuesOpened: emptySeries(weeks.length),
    openIssues: 0,
    openPrs: 0,
    prsMerged: emptySeries(weeks.length),
    prsOpened: emptySeries(weeks.length),
  };
  const [issueSearch, prSearch] = await Promise.all([
    ghFetch(
      `/search/issues?q=${encodeURIComponent(
        `repo:${repo} is:issue is:open`
      )}&per_page=1`
    ),
    ghFetch(
      `/search/issues?q=${encodeURIComponent(
        `repo:${repo} is:pr is:open`
      )}&per_page=1`
    ),
  ]);
  stats.openIssues = (issueSearch as GhSearchResult)?.total_count ?? 0;
  stats.openPrs = (prSearch as GhSearchResult)?.total_count ?? 0;

  const issues = (await ghFetch(
    `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100`
  )) as GhIssueItem[];
  for (const i of issues ?? []) {
    if (i.pull_request) {
      continue;
    }
    const opened = bucketIndex(i.created_at, weeks);
    if (opened >= 0) {
      stats.issuesOpened[opened] = (stats.issuesOpened[opened] ?? 0) + 1;
    }
    if (i.closed_at) {
      const closed = bucketIndex(i.closed_at, weeks);
      if (closed >= 0) {
        stats.issuesClosed[closed] = (stats.issuesClosed[closed] ?? 0) + 1;
      }
    }
  }

  const pulls = (await ghFetch(
    `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`
  )) as GhPullItem[];
  for (const p of pulls ?? []) {
    const opened = bucketIndex(p.created_at, weeks);
    if (opened >= 0) {
      stats.prsOpened[opened] = (stats.prsOpened[opened] ?? 0) + 1;
    }
    if (p.merged_at) {
      const merged = bucketIndex(p.merged_at, weeks);
      if (merged >= 0) {
        stats.prsMerged[merged] = (stats.prsMerged[merged] ?? 0) + 1;
      }
    }
  }
  return stats;
};

// Element-wise sum across repos — the rollup's weekly series.
export const sumSeries = (series: number[][]): number[] => {
  const out = emptySeries(series[0]?.length ?? 0);
  for (const s of series) {
    for (let i = 0; i < s.length; i += 1) {
      out[i] = (out[i] ?? 0) + (s[i] ?? 0);
    }
  }
  return out;
};

// The snapshot's week is the current one: the last bucket of each series.
export const weekStatsOf = (s: RepoStats): RepoWeekStats => ({
  issuesClosed: s.issuesClosed.at(-1) ?? 0,
  issuesOpened: s.issuesOpened.at(-1) ?? 0,
  openIssues: s.openIssues,
  openPrs: s.openPrs,
  prsMerged: s.prsMerged.at(-1) ?? 0,
  prsOpened: s.prsOpened.at(-1) ?? 0,
});

export const sumWeekStats = (repos: RepoWeekStats[]): StatsTotals => {
  const totals: StatsTotals = {
    issuesClosed: 0,
    issuesOpened: 0,
    openIssues: 0,
    openPrs: 0,
    prsMerged: 0,
    prsOpened: 0,
  };
  for (const r of repos) {
    for (const k of Object.keys(totals) as (keyof StatsTotals)[]) {
      totals[k] += r[k];
    }
  }
  return totals;
};

// History beyond 2 years is dead weight for a trend view; trim the oldest.
const MAX_WEEKS = 520;

// Corrupt or missing artifacts degrade to an empty store — stats stay
// viewable and the next upsert rewrites a clean file.
export const loadStatsStore = (file: string): StatsStore => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as StatsStore;
    if (parsed && typeof parsed === "object" && parsed.weeks) {
      return { weeks: parsed.weeks };
    }
  } catch {
    // fall through to the empty store
  }
  return { weeks: {} };
};

export const upsertSnapshot = (file: string, snapshot: StatsSnapshot): void => {
  const store = loadStatsStore(file);
  store.weeks[snapshot.week] = snapshot;
  // Week keys are ISO dates, so lexical order is chronological; keep the
  // newest MAX_WEEKS entries and rewrite the whole file atomically.
  const kept = Object.entries(store.weeks)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .slice(Math.max(0, Object.keys(store.weeks).length - MAX_WEEKS));
  const trimmed: StatsStore = { weeks: Object.fromEntries(kept) };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(trimmed));
  renameSync(tmp, file);
};

// Ascending weekly history for the trend view.
export const historyFromStore = (store: StatsStore): StatsSnapshot[] =>
  Object.keys(store.weeks)
    .toSorted()
    .flatMap((week) => {
      const snapshot = store.weeks[week];
      return snapshot ? [snapshot] : [];
    });
