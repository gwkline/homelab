/**
 * Which source URLs ingest will clone or fetch. Ingest holds a GitHub PAT
 * and has public egress, so a caller with the ingest token must not be able
 * to point it at another host, plain http, or the local filesystem.
 */

export const DEFAULT_SOURCE_URL_PREFIXES: readonly string[] = [
  "https://github.com/",
];

/** `KNOWLEDGE_INGEST_SOURCE_URL_PREFIXES`: comma-separated https prefixes. */
export const sourceUrlPrefixesFromEnv = (
  env: Record<string, string | undefined>
): string[] => {
  const raw = env.KNOWLEDGE_INGEST_SOURCE_URL_PREFIXES?.trim();
  if (raw === undefined || raw === "") {
    return [...DEFAULT_SOURCE_URL_PREFIXES];
  }
  const prefixes = raw
    .split(",")
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0);
  for (const prefix of prefixes) {
    let href = "";
    try {
      ({ href } = new URL(prefix));
    } catch {
      href = "";
    }
    // A prefix without its trailing slash would admit look-alike hosts
    // such as github.com.example.net.
    if (
      !href.startsWith("https://") ||
      !prefix.endsWith("/") ||
      href !== prefix
    ) {
      throw new Error(
        `KNOWLEDGE_INGEST_SOURCE_URL_PREFIXES entries must be normalized https URLs ending in "/", got ${JSON.stringify(prefix)}`
      );
    }
  }
  return prefixes;
};

/** Compared on the parsed URL, so dot segments and case can't sneak past. */
export const isAllowedSourceUrl = (
  raw: string,
  prefixes: readonly string[]
): boolean => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return false;
  }
  return prefixes.some((prefix) => url.href.startsWith(prefix));
};

/** GitHub `owner/name`, the only shape a `repo` field may take. */
export const GITHUB_REPO_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[\w.-]{1,100}$/u;
