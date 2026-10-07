// Collector configuration, read entirely from CronJob env (see README).
import { createHash } from "node:crypto";

export class ConfigError extends Error {
  readonly exitCode = 78;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface CollectorConfig {
  repos: string[];
  eligibilityLabel: string | null;
  defaultProfile: string;
  ruleVersion: string;
  since: string | null;
  queuedLabel: string;
  dryRun: boolean;
  apiBase: string;
  maxPages: number;
  maxRetries: number;
}

// Every factory lifecycle label. An issue carrying any of these already maps
// to a logical Run.
export const FACTORY_LIFECYCLE_LABELS: readonly string[] = [
  "factory/queued",
  "factory/in-progress",
  "factory/draft-pr",
  "factory/needs-review",
  "factory/failed",
  "factory/cancelled",
  "factory/stuck",
];

const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export const parseRepos = (value: string | undefined): string[] => {
  const repos = (value ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo.length > 0);
  if (repos.length === 0) {
    throw new ConfigError(
      "FACTORY_REPOS is required (comma-separated owner/name allowlist)"
    );
  }
  for (const repo of repos) {
    if (!REPO_SHAPE.test(repo)) {
      throw new ConfigError(`invalid repo in FACTORY_REPOS: '${repo}'`);
    }
  }
  return [...new Set(repos)];
};

const optionalTrimmed = (
  env: NodeJS.ProcessEnv,
  name: string
): string | null => {
  const value = (env[name] ?? "").trim();
  return value.length > 0 ? value : null;
};

const positiveInt = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const raw = (env[name] ?? "").trim();
  if (raw.length === 0) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} must be a positive integer (got '${raw}')`);
  }
  return value;
};

export const parseSince = (env: NodeJS.ProcessEnv): string | null => {
  const since = optionalTrimmed(env, "FACTORY_SINCE");
  if (since === null) {
    return null;
  }
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new ConfigError(
      `FACTORY_SINCE must be an ISO-8601 timestamp (got '${since}')`
    );
  }
  return parsed.toISOString();
};

export const loadConfig = (env: NodeJS.ProcessEnv): CollectorConfig => {
  const defaultProfile = (env.FACTORY_DEFAULT_PROFILE ?? "code-pr").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(defaultProfile)) {
    throw new ConfigError(
      `FACTORY_DEFAULT_PROFILE must be a profile name (got '${defaultProfile}')`
    );
  }
  const ruleVersion = (env.FACTORY_RULE_VERSION ?? "v1").trim();
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(ruleVersion)) {
    throw new ConfigError(
      `FACTORY_RULE_VERSION must be a version tag (got '${ruleVersion}')`
    );
  }
  const queuedLabel = (env.FACTORY_QUEUED_LABEL ?? "factory/queued").trim();
  if (!/^[\w/-]+$/u.test(queuedLabel)) {
    throw new ConfigError(
      `FACTORY_QUEUED_LABEL must be a label name (got '${queuedLabel}')`
    );
  }
  return {
    apiBase: (env.GITHUB_API_BASE ?? "https://api.github.com").trim(),
    defaultProfile,
    dryRun: (env.FACTORY_COLLECTOR_DRY_RUN ?? "").trim() === "true",
    eligibilityLabel: optionalTrimmed(env, "FACTORY_ELIGIBILITY_LABEL"),
    maxPages: positiveInt(env, "FACTORY_MAX_PAGES", 10),
    maxRetries: positiveInt(env, "FACTORY_MAX_RETRIES", 4),
    queuedLabel,
    repos: parseRepos(env.FACTORY_REPOS),
    ruleVersion,
    since: parseSince(env),
  };
};

// One repository/issue/rule version maps to exactly one logical Run. The key
// is logged for audit; the durable ledger is the GitHub label set.
export const runIdempotencyKey = (
  repo: string,
  issueNumber: number,
  profile: string,
  ruleVersion: string
): string => {
  const identity = `github:${repo}:${issueNumber}:${profile}@${ruleVersion}`;
  return createHash("sha256").update(identity).digest("hex");
};
