// Durable GitHub issue collector: each tick polls allowlisted repos and adds
// the queued label to eligible issues — that label is the Run's ledger record.
//
// Issue titles and bodies are untrusted. Eligibility reads only number, state,
// labels, updated_at and the pull_request flag; titles reach stdout only
// truncated and JSON-encoded. See README.md for the full behavior matrix.
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

// Reads plus the one ledger write (adding the queued label); see
// docs/github-app.md.
const COLLECTOR_PERMISSIONS: PermissionRequest = {
  contents: "read",
  issues: "write",
  metadata: "read",
};

// Structural, so tests can stub it without HTTP.
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

// Truncate, then JSON-encode, so control characters and quotes can never
// break the log line.
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

const queueCandidate = async (
  config: CollectorConfig,
  client: CollectorClient,
  repo: string,
  issue: IssueRef,
  state: TickState
): Promise<void> => {
  // The listing can be seconds stale: re-read so an issue claimed or closed
  // meanwhile is not queued again.
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
      console.log(
        `[collector] ${repo}: pagination cap (${page.pages} pages) — cursor will not advance this tick`
      );
      state.capOrError = true;
    }

    const seenThisTick = new Set<number>();
    for (const issue of page.issues) {
      seen += 1;
      maxSeenUpdatedAt = latest(maxSeenUpdatedAt, issue.updatedAt);
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

  // Advance only when every repo was listed completely, so a failed or capped
  // tick never skips work.
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

// Prefers a short-lived App installation token; falls back to GH_TOKEN.
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
  // Healthy repos were still processed; the non-zero exit keeps the failure
  // visible in CronJob history.
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
