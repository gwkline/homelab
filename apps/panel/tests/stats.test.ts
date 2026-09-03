import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface StatsModule {
  collectRepoStats: (
    repo: string,
    weeks: string[],
    ghFetch: (route: string) => Promise<unknown>
  ) => Promise<Record<string, unknown>>;
  historyFromStore: (store: unknown) => unknown[];
  loadStatsStore: (file: string) => { weeks: Record<string, unknown> };
  upsertSnapshot: (file: string, snapshot: unknown) => void;
  weekKeysBack: (now: Date | number | string, count: number) => string[];
  weekStart: (input: Date | number | string) => string;
}

const stats = (async () =>
  (await import(path.join(root, "dist", "stats.js"))) as StatsModule)();

// Snapshot factory — fixed capturedAt is fine, upserts only key on `week`.
const snap = (week: string, openIssues: number) => ({
  capturedAt: "2026-09-02T00:00:00Z",
  repos: {
    "gwkline/x": {
      issuesClosed: 0,
      issuesOpened: 1,
      openIssues,
      openPrs: 0,
      prsMerged: 0,
      prsOpened: 0,
    },
  },
  totals: {
    issuesClosed: 0,
    issuesOpened: 1,
    openIssues,
    openPrs: 0,
    prsMerged: 0,
    prsOpened: 0,
  },
  week,
});

test("weekStart snaps to Monday 00:00 UTC", async () => {
  const { weekStart } = await stats;
  assert.equal(weekStart("2026-09-02T15:04:05Z"), "2026-08-31");
  assert.equal(weekStart("2026-08-31T00:00:00Z"), "2026-08-31");
  // Sunday belongs to the week that started the previous Monday.
  assert.equal(weekStart("2026-08-30T23:59:59Z"), "2026-08-24");
  // Epoch (Thursday 1970-01-01) falls in the week starting 1969-12-29.
  assert.equal(weekStart(0), "1969-12-29");
});

test("weekKeysBack returns ascending keys ending at the current week", async () => {
  const { weekKeysBack } = await stats;
  const keys = weekKeysBack("2026-09-02T12:00:00Z", 8);
  assert.equal(keys.length, 8);
  assert.equal(keys[0], "2026-07-13");
  assert.equal(keys.at(-1), "2026-08-31");
  for (let i = 1; i < keys.length; i += 1) {
    assert.ok(
      (keys[i] ?? "") > (keys[i - 1] ?? ""),
      `keys not ascending at ${i}`
    );
  }
});

test("collectRepoStats buckets GitHub activity into weekly series", async () => {
  const { collectRepoStats, weekKeysBack } = await stats;
  // Fixed Wednesday so the bucket math is readable; fixtures are placed
  // relative to the week boundaries, never to "now".
  const weeks = weekKeysBack("2026-09-02T12:00:00Z", 8);
  const mondayMs = Date.parse("2026-08-31T00:00:00Z");
  const at = (weeksAgo: number, hour: number): string =>
    new Date(mondayMs - weeksAgo * WEEK_MS + hour * 3_600_000).toISOString();

  const routes: Record<string, unknown> = {
    "/repos/gwkline/x/issues?state=all&sort=created&direction=desc&per_page=100":
      [
        // opened this week (bucket 7)
        { created_at: at(0, 12), number: 1 },
        // opened last week, closed this week
        { closed_at: at(0, 40), created_at: at(1, 12), number: 2 },
        // opened 3 weeks ago (bucket 4), closed last week (bucket 6)
        { closed_at: at(1, 48), created_at: at(3, 12), number: 3 },
        // PRs are excluded from issue buckets entirely
        { created_at: at(0, 12), number: 4, pull_request: {} },
        // closed before the window: ignored
        {
          closed_at: at(10, 12),
          created_at: at(12, 12),
          number: 5,
        },
      ],
    "/repos/gwkline/x/pulls?state=all&sort=created&direction=desc&per_page=100":
      [
        // opened this week, still open
        { created_at: at(0, 16), number: 10 },
        // opened 2 weeks ago (bucket 5), merged this week (bucket 7)
        { created_at: at(2, 16), merged_at: at(0, 60), number: 11 },
        // closed without merge: no bucket
        { created_at: at(5, 16), merged_at: null, number: 12 },
      ],
    "/search/issues?q=repo%3Agwkline%2Fx%20is%3Aissue%20is%3Aopen&per_page=1": {
      total_count: 5,
    },
    "/search/issues?q=repo%3Agwkline%2Fx%20is%3Apr%20is%3Aopen&per_page=1": {
      total_count: 2,
    },
  };
  const ghFetch = (route: string): Promise<unknown> => {
    const hit = routes[route];
    if (hit === undefined) {
      return Promise.reject(new Error(`unexpected route: ${route}`));
    }
    return Promise.resolve(hit);
  };

  const s = await collectRepoStats("gwkline/x", weeks, ghFetch);
  assert.equal(s.openIssues, 5);
  assert.equal(s.openPrs, 2);
  assert.deepEqual(s.issuesOpened, [0, 0, 0, 0, 1, 0, 1, 1]);
  assert.deepEqual(s.issuesClosed, [0, 0, 0, 0, 0, 0, 1, 1]);
  assert.deepEqual(s.prsOpened, [0, 0, 1, 0, 0, 1, 0, 1]);
  assert.deepEqual(s.prsMerged, [0, 0, 0, 0, 0, 0, 0, 1]);
});

test("snapshot artifact upserts per week, trims old weeks, tolerates corruption", async () => {
  const { loadStatsStore, upsertSnapshot, weekKeysBack } = await stats;
  const dir = mkdtempSync(path.join(tmpdir(), "panel-stats-"));
  const file = path.join(dir, "nested", "factory-stats.json");

  // Missing file → empty store
  assert.deepEqual(loadStatsStore(file), { weeks: {} });

  const weeks = weekKeysBack("2026-09-02T12:00:00Z", 2);
  const [prevWeek = "", currWeek = ""] = weeks;
  upsertSnapshot(file, snap(prevWeek, 10));
  // Same week upserts in place instead of appending.
  upsertSnapshot(file, snap(prevWeek, 12));
  upsertSnapshot(file, snap(currWeek, 14));
  let store = loadStatsStore(file);
  assert.deepEqual(Object.keys(store.weeks).toSorted(), weeks);
  assert.equal(
    (store.weeks[prevWeek] as { totals: { openIssues: number } }).totals
      .openIssues,
    12
  );

  // Corruption degrades to an empty store; the next upsert rewrites cleanly.
  writeFileSync(file, "{not json");
  assert.deepEqual(loadStatsStore(file), { weeks: {} });
  upsertSnapshot(file, snap(currWeek, 14));
  store = loadStatsStore(file);
  assert.equal(Object.keys(store.weeks).length, 1);

  // Cap: the oldest weeks are trimmed once the store exceeds 520 entries.
  const allWeeks = weekKeysBack("2026-09-02T12:00:00Z", 521);
  for (const w of allWeeks) {
    upsertSnapshot(file, snap(w, 1));
  }
  store = loadStatsStore(file);
  const keys = Object.keys(store.weeks).toSorted();
  assert.equal(keys.length, 520);
  assert.equal(keys[0], allWeeks[1]);
  assert.equal(keys.at(-1), allWeeks.at(-1));
});

test("historyFromStore lists weeks ascending", async () => {
  const { historyFromStore, loadStatsStore, upsertSnapshot, weekKeysBack } =
    await stats;
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "panel-hist-")),
    "s.json"
  );
  const weeks = weekKeysBack("2026-09-02T12:00:00Z", 3);
  for (const w of weeks.toReversed()) {
    upsertSnapshot(file, {
      capturedAt: "2026-09-02T00:00:00Z",
      repos: {},
      totals: {},
      week: w,
    });
  }
  const history = historyFromStore(loadStatsStore(file));
  assert.deepEqual(
    history.map((h) => (h as { week: string }).week),
    weeks
  );
});

test("GET /api/factory/stats/rollup aggregates all repos and persists weekly history", async () => {
  const { weekStart } = await stats;
  const stage = mkdtempSync(path.join(tmpdir(), "panel-rollup-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  for (const f of ["index.js", "jobs.js", "k8s.js"]) {
    copyFileSync(path.join(root, "dist", f), path.join(stage, f));
  }
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );

  const now = new Date();
  const mondayMs = Date.parse(`${weekStart(now)}T00:00:00Z`);
  const at = (weeksAgo: number, hour: number): string =>
    new Date(mondayMs - weeksAgo * WEEK_MS + hour * 3_600_000).toISOString();
  // A snapshot from 40 weeks ago — far outside anything GitHub-derived lists
  // would return — pre-seeds the artifact to prove trends outlive the window.
  const oldWeek = weekStart(mondayMs - 40 * WEEK_MS);
  const statsFile = path.join(stage, "factory-stats.json");
  writeFileSync(
    statsFile,
    JSON.stringify({
      weeks: {
        [oldWeek]: {
          capturedAt: at(40, 48),
          repos: {
            "gwkline/homelab": {
              issuesClosed: 3,
              issuesOpened: 4,
              openIssues: 9,
              openPrs: 1,
              prsMerged: 2,
              prsOpened: 2,
            },
          },
          totals: {
            issuesClosed: 3,
            issuesOpened: 4,
            openIssues: 9,
            openPrs: 1,
            prsMerged: 2,
            prsOpened: 2,
          },
          week: oldWeek,
        },
      },
    })
  );

  const ghCalls: string[] = [];
  const gh = createServer((req, res) => {
    const url = req.url ?? "";
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401).end('{"message":"unauthorized"}');
      return;
    }
    ghCalls.push(url);
    if (url.startsWith("/search/issues?")) {
      const q = new URL(url, "http://gh").searchParams.get("q") ?? "";
      // One allowlisted repo (pr-czar) fails, exercising per-repo degradation.
      if (q.includes("gwkline/pr-czar")) {
        res.writeHead(500).end('{"message":"boom"}');
        return;
      }
      const total = q.includes("is:pr") ? 1 : 2;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ total_count: total }));
      return;
    }
    if (url.startsWith("/repos/") && url.includes("/issues?")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          { created_at: at(0, 12), number: 1 },
          { closed_at: at(0, 40), created_at: at(1, 12), number: 2 },
          { closed_at: at(1, 48), created_at: at(3, 12), number: 3 },
          { created_at: at(0, 12), number: 4, pull_request: {} },
        ])
      );
      return;
    }
    if (url.startsWith("/repos/") && url.includes("/pulls?")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([
          { created_at: at(0, 16), number: 10 },
          { created_at: at(2, 16), merged_at: at(0, 60), number: 11 },
          { created_at: at(5, 16), merged_at: null, number: 12 },
        ])
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => gh.listen(0, "127.0.0.1", r));
  const ghPort = (gh.address() as AddressInfo).port;

  const port = 3971;
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      FACTORY_STATS_PATH: statsFile,
      GH_API_BASE: `http://127.0.0.1:${ghPort}`,
      GH_TOKEN: "test-token",
      PANEL_K8S_BASE: "http://127.0.0.1:1",
      PANEL_ROOT: stage,
      PORT: String(port),
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("server did not start")),
        5000
      );
      child.stdout.on(
        "data",
        (d) =>
          d.toString().includes("listening") && (clearTimeout(t), resolve())
      );
    });
    const base = `http://127.0.0.1:${port}`;

    // Per-repo stats endpoint guards the allowlist.
    const badRepo = await fetch(`${base}/api/factory/stats?repo=evil/repo`);
    assert.equal(badRepo.status, 400);

    const one = (await (
      await fetch(`${base}/api/factory/stats?repo=gwkline/homelab`)
    ).json()) as {
      repo: string;
      stats: Record<string, unknown>;
      weeks: string[];
    };
    assert.equal(one.repo, "gwkline/homelab");
    assert.equal(one.weeks.length, 8);
    assert.deepEqual(one.stats.issuesOpened, [0, 0, 0, 0, 1, 0, 1, 1]);
    assert.equal(one.stats.openIssues, 2);

    // Rollup: one call, every FACTORY_REPOS repo.
    const callsBeforeRollup = ghCalls.length;
    const r = await fetch(`${base}/api/factory/stats/rollup`);
    assert.equal(r.status, 200);
    const j = (await r.json()) as {
      history: { totals: { openIssues: number }; week: string }[];
      persisted: boolean;
      repos: Record<string, unknown>[];
      totals: Record<string, unknown>;
      weeks: string[];
    };
    assert.equal(j.weeks.length, 8);
    assert.equal(j.persisted, true);

    // pr-czar failed upstream → 6 repos with stats, 1 with an error, and the
    // cross-repo totals only count the healthy repos.
    const okRepos = j.repos.filter((x) => x.error === undefined);
    const failed = j.repos.find((x) => x.repo === "gwkline/pr-czar");
    assert.equal(okRepos.length, j.repos.length - 1);
    assert.equal(failed?.error, "boom");
    assert.equal(j.totals.openIssues, 12);
    assert.equal(j.totals.openPrs, 6);
    const series = j.totals.issuesOpened as number[];
    assert.equal(series.length, 8);
    assert.deepEqual(series, [0, 0, 0, 0, 6, 0, 6, 6]);
    assert.deepEqual(j.totals.prsOpened, [0, 0, 6, 0, 0, 6, 0, 6]);
    assert.deepEqual(j.totals.prsMerged, [0, 0, 0, 0, 0, 0, 0, 6]);

    // 4 GitHub calls per healthy repo per rollup (2 search + 2 list). The
    // failed repo's two search requests fire in parallel before the 500
    // surfaces, so it adds 2 calls of its own.
    assert.equal(ghCalls.length - callsBeforeRollup, 6 * 4 + 2);

    // Trend history: the pre-seeded 40-week-old snapshot plus the current
    // week — history is read from the artifact, not GitHub. The current
    // entry's totals are the cross-repo week sums (open counts exclude the
    // failed repo).
    assert.equal(j.history.length, 2);
    assert.equal((j.history[0] ?? { week: "" }).week, oldWeek);
    assert.equal(
      (j.history.at(-1) as { totals: { openIssues: number } }).totals
        .openIssues,
      12
    );

    // The artifact on disk holds both weeks; a second call upserts the same
    // week instead of duplicating it.
    assert.ok(existsSync(statsFile));
    const again = await fetch(`${base}/api/factory/stats/rollup`);
    const j2 = (await again.json()) as { history: unknown[] };
    assert.equal(j2.history.length, 2);
  } finally {
    child.kill();
    gh.close();
  }
});
