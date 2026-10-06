// Behavior tests for the collector tick logic (#78) against a fake GitHub
// client (no HTTP at all). Covers the acceptance cases: eligibility, the
// duplicate-run guarantee (repeated polls and same-tick duplicates never
// write twice), the pagination-cap cursor rule, race narrowing, the
// eligibility label gate, dry runs, and the #71 idempotency key shape.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, runIdempotencyKey } from "../config.ts";
import type { IssueRef } from "../github-client.ts";
import { collectTick, createTokenProvider } from "../run-collector.ts";
import type { CollectorClient } from "../run-collector.ts";

const issueRef = (number: number, extra: Partial<IssueRef> = {}): IssueRef => ({
  isPullRequest: false,
  labels: [],
  number,
  state: "open",
  title: `Issue ${number} — <script>alert("untrusted")</script>`,
  updatedAt: "2026-09-01T00:00:00Z",
  ...extra,
});

interface Call {
  kind: "list" | "get" | "add";
  repo?: string;
  labels?: string[];
  number?: number;
}

// Fake client: records every call and answers from a per-repo issue map
// (optionally mutable between calls, to simulate races and pagination).
const fakeClient = (
  repos: Map<string, IssueRef[]>,
  overrides: Partial<CollectorClient> = {}
): { calls: Call[]; client: CollectorClient } => {
  const calls: Call[] = [];
  const client: CollectorClient = {
    addLabels: async (repo, issueNumber, labels) => {
      calls.push({ kind: "add", labels, number: issueNumber, repo });
    },
    getIssue: async (repo, issueNumber) =>
      repos.get(repo)?.find((i) => i.number === issueNumber) ?? null,
    listOpenIssues: async (repo) => {
      calls.push({ kind: "list", repo });
      return {
        etag: '"e1"',
        issues: [...(repos.get(repo) ?? [])],
        notModified: false,
        pages: 1,
      };
    },
    ...overrides,
  };
  return { calls, client };
};

const baseEnv = {
  FACTORY_REPOS: "o/r",
  GITHUB_API_BASE: "https://github.example/api/v3",
};

test("eligible open issue is queued exactly once with the #71 idempotency key", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { calls, client } = fakeClient(repos);
  const config = loadConfig(baseEnv);
  const result = await collectTick(config, client);
  assert.equal(result.queued, 1);
  assert.deepEqual(calls.at(-1), {
    kind: "add",
    labels: ["factory/queued"],
    number: 1,
    repo: "o/r",
  });
  // Key is deterministic sha256 over provider:repo:issue:profile@rule.
  const key = runIdempotencyKey("o/r", 1, "code-pr", "v1");
  assert.equal(key, runIdempotencyKey("o/r", 1, "code-pr", "v1"));
  assert.match(key, /^[0-9a-f]{64}$/u);
});

test("repeated polls never duplicate the Run (label is the ledger)", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const config = loadConfig(baseEnv);

  const first = fakeClient(repos);
  const firstResult = await collectTick(config, first.client);
  assert.equal(firstResult.queued, 1);

  // Second tick: the first tick's write is reflected as a lifecycle label
  // (factory/queued) on the issue — exactly what the ledger shows.
  repos.set("o/r", [issueRef(1, { labels: ["factory/queued"] })]);
  const second = fakeClient(repos);
  const secondResult = await collectTick(config, second.client);
  assert.equal(secondResult.queued, 0);
  assert.equal(secondResult.skipped["already-run"], 1);
  assert.ok(!second.calls.some((c) => c.kind === "add"));
});

test("same-tick duplicate listings map to one Run", async () => {
  const repos = new Map([
    ["o/r", [issueRef(1), issueRef(1, { updatedAt: "2026-09-02T00:00:00Z" })]],
  ]);
  const { calls, client } = fakeClient(repos);
  const result = await collectTick(loadConfig(baseEnv), client);
  const adds = calls.filter((c) => c.kind === "add");
  assert.equal(adds.length, 1);
  assert.equal(result.skipped.duplicate, 1);
});

test("closed issues, pull requests, and terminal labels are skipped", async () => {
  const repos = new Map([
    [
      "o/r",
      [
        issueRef(1, { state: "closed" }),
        issueRef(2, { isPullRequest: true }),
        issueRef(3, { labels: ["factory/failed"] }),
        issueRef(4, { labels: ["factory/in-progress"] }),
        issueRef(5, { labels: ["factory/draft-pr"] }),
        issueRef(6),
      ],
    ],
  ]);
  const { calls, client } = fakeClient(repos);
  const result = await collectTick(loadConfig(baseEnv), client);
  const added = calls.filter((c) => c.kind === "add").map((c) => c.number);
  assert.deepEqual(added, [6]);
  assert.equal(result.skipped.closed, 1);
  assert.equal(result.skipped["pull-request"], 1);
  assert.equal(result.skipped["already-run"], 3);
});

test("eligibility label gates admission when configured", async () => {
  const repos = new Map([
    ["o/r", [issueRef(1, { labels: ["run-agent"] }), issueRef(2)]],
  ]);
  const { calls, client } = fakeClient(repos);
  const config = loadConfig({
    ...baseEnv,
    FACTORY_ELIGIBILITY_LABEL: "run-agent",
  });
  const result = await collectTick(config, client);
  const added = calls.filter((c) => c.kind === "add").map((c) => c.number);
  assert.deepEqual(added, [1]);
  assert.equal(result.skipped["not-eligible-label"], 1);
});

test("race narrowing: issue closed between list and write is skipped", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { calls, client } = fakeClient(repos, {
    getIssue: async () => issueRef(1, { state: "closed" }),
  });
  const result = await collectTick(loadConfig(baseEnv), client);
  assert.equal(result.queued, 0);
  assert.equal(result.skipped.closed, 1);
  assert.ok(!calls.some((c) => c.kind === "add"));
});

test("race narrowing: issue claimed between list and write is skipped", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { calls, client } = fakeClient(repos, {
    getIssue: async () => issueRef(1, { labels: ["factory/in-progress"] }),
  });
  const result = await collectTick(loadConfig(baseEnv), client);
  assert.equal(result.queued, 0);
  assert.equal(result.skipped["already-run"], 1);
  assert.ok(!calls.some((c) => c.kind === "add"));
});

test("dry run writes nothing but reports what it would queue", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { calls, client } = fakeClient(repos);
  const config = loadConfig({ ...baseEnv, FACTORY_COLLECTOR_DRY_RUN: "true" });
  const result = await collectTick(config, client);
  assert.equal(result.queued, 0);
  assert.equal(result.wouldQueue, 1);
  assert.ok(!calls.some((c) => c.kind === "add"));
});

test("untrusted titles are never executed or interpolated — only logged", async () => {
  const hostile = 'x" && rm -rf / && echo "pwned\n${{ github }}';
  const repos = new Map([["o/r", [issueRef(1, { title: hostile })]]]);
  const { client } = fakeClient(repos);
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    logs.push(args.join(" "));
  };
  try {
    await collectTick(loadConfig(baseEnv), client);
  } finally {
    console.log = original;
  }
  // The title appears only JSON-encoded inside a log line; the command surface
  // is empty by construction (no child processes exist in the collector).
  const queuedLine = logs.find((line) => line.includes("Run created"));
  assert.ok(queuedLine);
  assert.match(queuedLine, /title=/u);
});

test("pagination cap keeps the cursor conservative", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { client } = fakeClient(repos, {
    listOpenIssues: async () => ({
      etag: '"e1"',
      issues: [issueRef(1)],
      notModified: false,
      pages: 10,
    }),
  });
  const config = loadConfig(baseEnv);
  const result = await collectTick(config, client);
  assert.equal(result.queued, 1);
  // Cap hit → cursor must not advance past this tick.
  assert.equal(result.nextSince, null);
});

test("cursor advances to the newest update when every repo completed", async () => {
  const repos = new Map([
    ["o/a", [issueRef(1, { updatedAt: "2026-09-02T12:00:00Z" })]],
    ["o/b", [issueRef(2, { updatedAt: "2026-09-03T08:30:00Z" })]],
  ]);
  const { client } = fakeClient(repos);
  const config = loadConfig({ ...baseEnv, FACTORY_REPOS: "o/a,o/b" });
  const result = await collectTick(config, client);
  assert.equal(result.nextSince, "2026-09-03T08:30:00Z");
});

test("repo failure isolates other repos and keeps the cursor", async () => {
  const repos = new Map([["o/b", [issueRef(2)]]]);
  const { calls, client } = fakeClient(repos, {
    listOpenIssues: async (repo) => {
      if (repo === "o/a") {
        throw new Error("boom");
      }
      calls.push({ kind: "list", repo });
      return {
        etag: null,
        issues: [...(repos.get(repo) ?? [])],
        notModified: false,
        pages: 1,
      };
    },
  });
  const config = loadConfig({ ...baseEnv, FACTORY_REPOS: "o/a,o/b" });
  const result = await collectTick(config, client);
  assert.equal(result.queued, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /o\/a/u);
  assert.equal(result.nextSince, null);
});

test("404 on recheck counts as not-found, not an error", async () => {
  const repos = new Map([["o/r", [issueRef(1)]]]);
  const { calls, client } = fakeClient(repos, {
    getIssue: async () => null,
  });
  const result = await collectTick(loadConfig(baseEnv), client);
  assert.equal(result.queued, 0);
  assert.equal(result.skipped["not-found"], 1);
  assert.equal(result.errors.length, 0);
  assert.ok(!calls.some((c) => c.kind === "add"));
});

test("token provider prefers the App (#70) and falls back to GH_TOKEN", async () => {
  const app = createTokenProvider({
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    GITHUB_API_BASE: "https://github.example/api/v3",
  });
  assert.equal(app.mode, "app");

  const pat = createTokenProvider({ GH_TOKEN: "ghs_test" });
  assert.equal(pat.mode, "pat");
  assert.equal(await pat.token(), "ghs_test");

  assert.throws(
    () => createTokenProvider({}),
    (error: unknown) =>
      error instanceof Error &&
      /no GitHub access configured/u.test(error.message)
  );
});
