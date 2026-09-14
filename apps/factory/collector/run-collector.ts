// Durable GitHub issue collector (#78, ADR-002 GitHub-as-ledger).
//
// Replaces the demo dispatcher (examples/dispatch-watcher.mjs +
// deploy/dispatcher/base): GitHub issues are the primary work generator, not
// shell commands embedded in CronJob configuration.
//
// One tick:
//   1. Load declarative config (repos, eligibility label/status, default
//      profile, rule version, polling cursor).
//   2. Mint a short-lived, read-scoped GitHub App installation token (#70).
//   3. Poll each allowlisted repo's open issues (paginated, conditional,
//      rate-limit-aware).
//   4. For every eligible issue, create the logical Run idempotently: the
//      queued label IS the Run's ledger record (one issue + one label event =
//      one Run per #71); the #71 idempotency key is computed and logged.
//   5. Print a machine-readable summary + the next polling cursor.
//
// Trust boundary: issue titles/bodies/comments are UNTRUSTED task context.
// The collector reads none of them — eligibility uses only number, state,
// labels, updated_at and the pull_request flag. A title is only ever written
// to stdout JSON-encoded and truncated, never interpolated into any shell
// command, manifest, or YAML. See apps/factory/collector/README.md for the
// full behavior matrix (label removal, close/reopen, edits, retries).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createTokenService } from "../github-app/token-service.ts";
import type { PermissionRequest } from "../github-app/token-service.ts";
import {
  ConfigError,
  FACTORY_LIFECYCLE_LABELS,
  loadConfig,
  runIdempotencyKey,
} from "./config.ts";
import type { CollectorConfig } from "./config.ts";
import { GitHubClient } from "./github-client.ts";
import type { IssueRef } from "./github-client.ts";
import { GitHubApiError } from "./github-errors.ts";

// The collector's GitHub surface per docs/github-app.md: pure reads plus the
// one unavoidable ledger write (adding the queued label). `issues:write`
// implies read; the App-level installation never grants more than the table
// in docs/github-app.md.
const COLLECTOR_PERMISSIONS: PermissionRequest = {
  contents: "read",
  issues: "write",
  metadata: "read",
};

// Everything the collector needs from GitHub — structural, so tests can stub
// it without any HTTP (the real GitHubClient satisfies this shape).
export interface CollectorClient {
  addLabels: (
    repo: string,
    issueNumber: number,
    labels: string[]
  ) => Promise<void>;
  getIssue: (repo: string, issueNumber: number) => Promise<IssueRef | null>;
  listOpenIssues: (
    repo: string,
    options?: { since?: string | null; etag?: string | null }
  ) => Promise<{
    issues: IssueRef[];
    etag: string | null;
    notModified: boolean;
    pages: number;
  }>;
}

export interface SkipCounts {
  "already-run": number;
  closed: number;
  duplicate: number;
  "not-eligible-label": number;
  "not-found": number;
  "pull-request": number;
}

type SkipReason = Exclude<keyof SkipCounts, never>;

const skipReasons = (): SkipCounts => ({
  "already-run": 0,
  closed: 0,
  duplicate: 0,
  "not-eligible-label": 0,
  "not-found": 0,
  "pull-request": 0,
});

export interface TickResult {
  errors: string[];
  /** ISO cursor for the next tick; null when it must not advance. */
  nextSince: string | null;
  queued: number;
  reposOk: number;
  seen: number;
  skipped: SkipCounts;
  wouldQueue: number;
}

// Mutable tick accumulator, threaded through the helpers below.
interface TickState {
  capOrError: boolean;
  errors: string[];
  queued: number;
  skipped: SkipCounts;
  wouldQueue: number;
}

const errText = (error: unknown): string =>
  error instanceof GitHubApiError ? error.message : "unexpected error";

const fail = (state: TickState, repo: string, message: string): void => {
  console.error(`[collector] ${repo}: ${message}`);
  state.errors.push(`${repo}: ${message}`);
  state.capOrError = true;
};

// Untrusted title → log-safe string: truncated first, then JSON-encoded, so
// control characters and quotes can never break the log line shape.
const logTitle = (title: string): string => JSON.stringify(title.slice(0, 80));

const latest = (a: string | null, b: string): string | null => {
  if (a === null || Date.parse(b) > Date.parse(a)) {
    return b;
  }
  return a;
};

const classifySkip = (
  config: CollectorConfig,
  issue: IssueRef
): SkipReason | null => {
  if (issue.isPullRequest) {
    return "pull-request";
  }
  if (issue.state !== "open") {
    return "closed";
  }
  if (
    config.eligibilityLabel !== null &&
    !issue.labels.includes(config.eligibilityLabel)
  ) {
    return "not-eligible-label";
  }
  const labelSet = new Set(issue.labels);
  for (const lifecycle of FACTORY_LIFECYCLE_LABELS) {
    if (labelSet.has(lifecycle)) {
      return "already-run";
    }
  }
  return null;
};

// Creates the logical Run for one candidate: re-reads the issue to narrow the
// listing race, then adds the queued label — the ledger write.
const queueCandidate = async (
  config: CollectorConfig,
  client: CollectorClient,
  repo: string,
  issue: IssueRef,
  state: TickState
): Promise<void> => {
  // Race narrowing: the listing can be seconds stale. Re-read the issue
  // right before the ledger write so an orchestrator that claimed (or a
  // human that closed) it meanwhile is never double-queued.
  let fresh: IssueRef | null;
  try {
    fresh = await client.getIssue(repo, issue.number);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      state.skipped["not-found"] += 1;
      return;
    }
    fail(
      state,
      repo,
      `recheck failed for #${issue.number} (${errText(error)})`
    );
    return;
  }
  if (fresh === null) {
    state.skipped["not-found"] += 1;
    return;
  }
  const freshSkip = classifySkip(config, fresh);
  if (freshSkip !== null) {
    state.skipped[freshSkip] += 1;
    return;
  }

  const key = runIdempotencyKey(
    repo,
    fresh.number,
    config.defaultProfile,
    config.ruleVersion
  );
  const detail = `title=${logTitle(fresh.title)} profile=${config.defaultProfile} rule=${config.ruleVersion} key=${key}`;
  if (config.dryRun) {
    state.wouldQueue += 1;
    console.log(
      `[collector] ${repo}#${fresh.number}: would create Run (dry run) ${detail}`
    );
    return;
  }
  try {
    await client.addLabels(repo, fresh.number, [config.queuedLabel]);
  } catch (error) {
    fail(state, repo, `queue failed for #${fresh.number} (${errText(error)})`);
    return;
  }
  state.queued += 1;
  console.log(
    `[collector] ${repo}#${fresh.number}: Run created (queued) ${detail}`
  );
};

export const collectTick = async (
  config: CollectorConfig,
  client: CollectorClient
): Promise<TickResult> => {
  const state: TickState = {
    capOrError: false,
    errors: [],
    queued: 0,
    skipped: skipReasons(),
    wouldQueue: 0,
  };
  let seen = 0;
  let reposOk = 0;
  let maxSeenUpdatedAt: string | null = null;

  for (const repo of config.repos) {
    let page;
    try {
      page = await client.listOpenIssues(repo, { since: config.since });
    } catch (error) {
      fail(state, repo, `list failed (${errText(error)})`);
      continue;
    }

    if (page.notModified) {
      console.log(`[collector] ${repo}: not modified since cursor`);
      reposOk += 1;
      continue;
    }
    if (page.pages >= config.maxPages && page.issues.length > 0) {
      // Pagination cap hit: the oldest updates past the cap were not seen,
      // so the cursor must not advance past this tick (conservative).
      console.log(
        `[collector] ${repo}: pagination cap (${page.pages} pages) — cursor will not advance this tick`
      );
      state.capOrError = true;
    }

    const seenThisTick = new Set<number>();
    for (const issue of page.issues) {
      seen += 1;
      maxSeenUpdatedAt = latest(maxSeenUpdatedAt, issue.updatedAt);
      // Same-tick duplicate defense (the client already dedupes pages): an
      // issue listed twice must map to one Run, never two writes.
      if (seenThisTick.has(issue.number)) {
        state.skipped.duplicate += 1;
        continue;
      }
      seenThisTick.add(issue.number);
      const preSkip = classifySkip(config, issue);
      if (preSkip !== null) {
        state.skipped[preSkip] += 1;
        continue;
      }
      await queueCandidate(config, client, repo, issue, state);
    }
    reposOk += 1;
  }

  // The cursor is an optimization, never a correctness mechanism (full scans
  // are always safe — eligibility is idempotent). It advances only when every
  // repo was listed completely, so a failed/capped tick never skips work.
  const nextSince =
    state.errors.length === 0 && !state.capOrError
      ? (maxSeenUpdatedAt ?? config.since)
      : config.since;

  const summary = {
    errors: state.errors.length,
    nextSince,
    queued: state.queued,
    repos: config.repos.length,
    reposOk,
    rule: config.ruleVersion,
    seen,
    skipped: state.skipped,
    tick: "complete",
    wouldQueue: state.wouldQueue,
  };
  console.log(`[collector] summary ${JSON.stringify(summary)}`);
  return {
    errors: state.errors,
    nextSince,
    queued: state.queued,
    reposOk,
    seen,
    skipped: state.skipped,
    wouldQueue: state.wouldQueue,
  };
};

// Short-lived read-scoped App installation token (#70) with an explicit,
// transitional PAT fallback for clusters that have not passed the App gate
// yet (docs/github-app.md).
export const createTokenProvider = (
  env: NodeJS.ProcessEnv
): { mode: "app" | "pat"; token: () => Promise<string> } => {
  const appId = (env.GITHUB_APP_ID ?? "").trim();
  const installationId = (env.GITHUB_APP_INSTALLATION_ID ?? "").trim();
  const keyFile = (env.GITHUB_APP_PRIVATE_KEY_FILE ?? "").trim();
  const inlineKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").trim();
  if (appId.length > 0 && installationId.length > 0) {
    if (keyFile.length === 0 && inlineKey.length === 0) {
      throw new ConfigError(
        "GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID set but no private key (set GITHUB_APP_PRIVATE_KEY_FILE)"
      );
    }
    const privateKey =
      keyFile.length > 0 ? readFileSync(keyFile, "utf-8").trim() : inlineKey;
    const options: Parameters<typeof createTokenService>[1] = {};
    const apiBase = (env.GITHUB_API_BASE ?? "").trim();
    if (apiBase.length > 0) {
      options.apiBase = apiBase;
    }
    const service = createTokenService(
      { appId, installationId, privateKey },
      options
    );
    console.log(
      "[collector] github access: App installation token (short-lived, read-scoped)"
    );
    return {
      mode: "app",
      token: async () => {
        const minted = await service.getToken(COLLECTOR_PERMISSIONS);
        return minted.token;
      },
    };
  }
  const pat = (env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  if (pat.length === 0) {
    throw new ConfigError(
      "no GitHub access configured: set GITHUB_APP_ID + GITHUB_APP_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY_FILE (preferred) or GH_TOKEN (transitional fallback)"
    );
  }
  console.log(
    "[collector] github access: static GH_TOKEN fallback (transitional; migrate to the GitHub App per docs/github-app.md)"
  );
  return { mode: "pat", token: (): Promise<string> => Promise.resolve(pat) };
};

const main = async (): Promise<void> => {
  let config: CollectorConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[collector] config: ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
  const { token } = createTokenProvider(process.env);
  const client = new GitHubClient({
    apiBase: config.apiBase,
    maxPages: config.maxPages,
    maxRetries: config.maxRetries,
    tokenProvider: token,
  });
  const result = await collectTick(config, client);
  // A tick with per-repo errors still processed the healthy repos; the
  // non-zero exit makes the failure visible in CronJob history and Loki and
  // (with backoffLimit: 0) leaves the failure record intact.
  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
