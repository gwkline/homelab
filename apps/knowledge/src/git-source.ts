/**
 * Incremental Git repository knowledge source (#61).
 *
 * The first real ingestion source: sync selected files from a Git repository
 * into normalized, provenance-complete documents. This module ENDS at
 * whole-file documents — chunking and embeddings are downstream workers'
 * job (#59+); nothing here pretends Markdown and code chunk alike, it only
 * tags each document with a `contentKind` the chunker dispatches on.
 *
 * Provenance (every document carries all of it):
 * - `repositoryUrl` + `ref`: where the content came from
 * - `commitSha`: the exact commit the sync read
 * - `path` / `externalId`: repo-relative path at that commit
 * - `blobHash`: git blob SHA — what the incremental manifest diffs on
 * - `contentHash`: sha256 of the stored text (the D3/D10 no-op key)
 * - `url`: canonical commit-pinned web URL (GitHub/GitLab/Bitbucket exact)
 * - `lineRange`: inclusive 1-based range covered (whole file; chunkers
 *   narrow it per chunk)
 * - `firstCommitSha`, `renamedFrom`, `previousBlobHash`,
 *   `previousContentHash`: enough to explain history after renames and
 *   re-ingests
 *
 * Incremental sync: the manifest maps path → last-ingested blob hash. Each
 * sync diffs the current tree against it, so unchanged blobs are never read
 * (`cat-file` runs only for adds/changes), modified files bump the document
 * version, deletions tombstone the path, and a deleted blob reappearing at
 * a new path is a rename (same blob hash): the old path is tombstoned with
 * `renamedTo`, the new document records `renamedFrom` — stale paths never
 * serve results and history stays explainable.
 *
 * Defaults: binary extensions, NUL/mojibake-sniffed blobs, generated dirs
 * (`node_modules`, `dist`, `vendor`, …), lockfiles, and secret-looking
 * files (name patterns + PEM private-key content sniff) are excluded
 * without configuration. `applyDefaultExcludes: false` drops only the
 * directory/lockfile/generated sets — secret detection stays on in every
 * mode, because credentials must never reach the corpus by opt-out.
 *
 * Auth: an optional token is applied per invocation through the
 * `http.extraheader` git config override passed via `GIT_CONFIG_*`
 * environment variables (the mechanism GitHub Actions' checkout uses).
 * The token never lands in any `.git/config`, never appears in argv or
 * logs, and works for authorized private repos over HTTPS; public repos
 * need no token at all.
 *
 * Like `src/bm25.ts`/`src/pgvector.ts`: pure pieces (glob matching, tree
 * filtering, planning, assessment, normalization) are covered by offline
 * unit tests; `openGitRepository` is the only piece that spawns `git`.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Documents produced by this source carry `source = "git"` (ADR-002 D3). */
export const GIT_SOURCE_KIND = "git";

/**
 * Default cap on blob size; anything bigger is skipped as `too-large`
 * (knowledge ingestion, not bulk load). Configurable per source.
 */
export const DEFAULT_MAX_BLOB_BYTES = 1_048_576;

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;
const BLOB_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u;
const UTF8_REPLACEMENT_RATIO = 0.01;

const globSegmentSource = (segment: string): string =>
  segment
    .replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");

/** Test one repo-relative POSIX path against one pattern. */
/**
 * gitignore-lite matching for include/exclude patterns: `*`/`?` within a
 * segment, `**` across segments, trailing `/` means the whole subtree, a
 * leading `/` anchors at the repo root, and a pattern without `/` matches
 * the basename at any depth (so a bare dir name excludes its whole
 * subtree — the gitignore intuition).
 */
const globRegexCache = new Map<string, RegExp>();

const compileGlob = (pattern: string): RegExp => {
  const cached = globRegexCache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  if (pattern.length === 0 || /[\0\r\n]/u.test(pattern)) {
    throw new Error(
      `git-source: invalid path pattern ${JSON.stringify(pattern)}`
    );
  }
  let body = pattern.replace(/\/+$/u, "");
  if (body.length === 0) {
    throw new Error(
      `git-source: invalid path pattern ${JSON.stringify(pattern)}`
    );
  }
  const anchored = body.startsWith("/");
  if (anchored) {
    body = body.slice(1);
  }
  const segments = body.split("/");
  let source = "";
  for (const [index, segment] of segments.entries()) {
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      source += isLast ? "(?:[^/]+/)*[^/]*" : "(?:[^/]+/)*";
      continue;
    }
    source += globSegmentSource(segment);
    if (!isLast) {
      source += "/";
    }
  }
  if (!anchored && segments.length === 1) {
    // Bare name / basename glob: hit any single segment; a directory hit
    // carries its whole subtree with it.
    source = `(?:.*/)?${source}(?:/.*)?`;
  } else if (!anchored) {
    source = `(?:.*/)?${source}`;
  }
  const regex = new RegExp(`^${source}$`, "u");
  globRegexCache.set(pattern, regex);
  return regex;
};
export const matchGitPath = (pattern: string, filePath: string): boolean =>
  compileGlob(pattern).test(filePath);

const EXCLUDED_DIRECTORIES = [
  ".cache",
  ".git",
  ".gradle",
  ".hg",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svn",
  ".terraform",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "bower_components",
  "build",
  "codegen",
  "coverage",
  "dist",
  "gen",
  "generated",
  "node_modules",
  "out",
  "target",
  "third-party",
  "third_party",
  "venv",
  "vendor",
];

const EXCLUDED_LOCKFILES = [
  "*.lock",
  "bun.lockb",
  "Cargo.lock",
  "Cartfile.resolved",
  "composer.lock",
  "flake.lock",
  "Gemfile.lock",
  "go.sum",
  "go.work.sum",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "Package.resolved",
  "packages.lock.json",
  "Paket.lock",
  "Pipfile.lock",
  "pdm.lock",
  "pnpm-lock.yaml",
  "Podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
];

const EXCLUDED_GENERATED_FILES = [
  "*.d.ts",
  "*.freezed.dart",
  "*.g.dart",
  "*.generated.*",
  "*.map",
  "*.min.css",
  "*.min.js",
  "*.min.mjs",
  "*.pb.cc",
  "*.pb.go",
  "*.pb.h",
  "*_pb2.py",
  "*_pb2_grpc.py",
];

const BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "avif",
  "bin",
  "bmp",
  "bz2",
  "class",
  "db",
  "deb",
  "dll",
  "doc",
  "docx",
  "dylib",
  "eot",
  "exe",
  "flac",
  "gif",
  "gz",
  "h5",
  "heic",
  "ico",
  "img",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "o",
  "ogg",
  "onnx",
  "otf",
  "parquet",
  "pdf",
  "pickle",
  "pkl",
  "png",
  "ppt",
  "pptx",
  "pt",
  "pyd",
  "rar",
  "rpm",
  "so",
  "sqlite",
  "sqlite3",
  "tar",
  "tgz",
  "tif",
  "tiff",
  "ttf",
  "wav",
  "wasm",
  "webp",
  "woff",
  "woff2",
  "xls",
  "xlsx",
  "xz",
  "zip",
  "zst",
]);

/**
 * Secret-looking NAME patterns. Applied in every mode (even with
 * `applyDefaultExcludes: false`) — credentials must never reach the corpus
 * because a user opted out of the convenience excludes.
 */
const SECRET_NAME_PATTERNS = [
  ".env",
  ".env.*",
  ".htpasswd",
  ".netrc",
  "credentials",
  "credentials.*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "id_rsa*",
  "*.gpg",
  "*.jks",
  "*.keystore",
  "*.key",
  "*.ovpn",
  "*.p12",
  "*.pem",
  "*.pfx",
  "*.ppk",
  "secrets",
  "secrets.*",
];

/**
 * Excluded by default before any caller-supplied `exclude` patterns:
 * generated/vendored directories, lockfiles, generated files, and
 * secret-named files. Toggle off with `applyDefaultExcludes: false`
 * (secret-name and private-key content detection still apply).
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  ...EXCLUDED_DIRECTORIES,
  ...EXCLUDED_LOCKFILES,
  ...EXCLUDED_GENERATED_FILES,
  ...SECRET_NAME_PATTERNS,
];

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mdx", "mkd"]);

const CODE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bazel",
  "bzl",
  "c",
  "cc",
  "cfg",
  "clj",
  "cljs",
  "conf",
  "cpp",
  "cs",
  "css",
  "cxx",
  "dart",
  "el",
  "erl",
  "ex",
  "exs",
  "fish",
  "gql",
  "go",
  "gradle",
  "graphql",
  "groovy",
  "h",
  "haml",
  "hcl",
  "hpp",
  "hs",
  "htm",
  "html",
  "hxx",
  "ini",
  "ipynb",
  "java",
  "jl",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsonnet",
  "jsx",
  "kt",
  "kts",
  "less",
  "lua",
  "m",
  "mm",
  "nix",
  "php",
  "pl",
  "pm",
  "proto",
  "ps1",
  "py",
  "pyi",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "svelte",
  "sql",
  "swift",
  "tf",
  "toml",
  "ts",
  "tsx",
  "vim",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zig",
  "zsh",
]);

const CODE_FILENAMES = new Set([
  "cmakelists.txt",
  "dockerfile",
  "gemfile",
  "justfile",
  "makefile",
  "makefile.am",
  "makefile.in",
  "rakefile",
  "vagrantfile",
]);

export interface ContentClassification {
  contentKind: "code" | "markdown" | "text";
  language: string | null;
}

/**
 * Markdown and source code get distinct `contentKind` values so the
 * downstream chunker can use heading/paragraph semantics for prose and
 * line/AST semantics for code — this module never chunks, it only tags.
 */
const fileExtension = (filePath: string): string | null => {
  const fileName = path.basename(filePath);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    return null;
  }
  return fileName.slice(dot + 1).toLowerCase();
};

export const classifyContent = (filePath: string): ContentClassification => {
  const extension = fileExtension(filePath);
  if (extension !== null && MARKDOWN_EXTENSIONS.has(extension)) {
    return { contentKind: "markdown", language: "markdown" };
  }
  if (extension !== null && CODE_EXTENSIONS.has(extension)) {
    return { contentKind: "code", language: extension };
  }
  const fileName = path.basename(filePath).toLowerCase();
  if (CODE_FILENAMES.has(fileName)) {
    return {
      contentKind: "code",
      language: fileName.replace(/\..*$/u, ""),
    };
  }
  return { contentKind: "text", language: null };
};

export const isBinaryExtension = (filePath: string): boolean => {
  const extension = fileExtension(filePath);
  return extension !== null && BINARY_EXTENSIONS.has(extension);
};

/**
 * NUL byte anywhere, or a decode dominated by U+FFFD replacements (>1% —
 * real UTF-8 text never trips this; latin-1/UTF-16 payloads do), marks a
 * blob binary. Called on blobs already bounded by `maxBlobBytes`.
 */
export const sniffBinary = (bytes: Uint8Array): boolean => {
  if (bytes.includes(0)) {
    return true;
  }
  const decoded = new TextDecoder("utf-8").decode(bytes);
  if (decoded.length === 0) {
    return false;
  }
  const replacements = decoded.split("�").length - 1;
  return replacements / decoded.length > UTF8_REPLACEMENT_RATIO;
};

export const contentLooksSecret = (text: string): boolean =>
  PRIVATE_KEY_PATTERN.test(text);

export const looksSecretNamed = (filePath: string): boolean =>
  SECRET_NAME_PATTERNS.some((pattern) => matchGitPath(pattern, filePath));

/** Outcome of examining one blob for ingestion. */
export type BlobAssessment =
  | { contentHash: string; kind: "text"; text: string }
  | { kind: "binary" | "empty" | "secret" | "too-large" };

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf-8").digest("hex");

/**
 * Full ingest gate for one blob, in strict order: empty → too-large →
 * secret-named → binary → secret content → text. The returned
 * `contentHash` covers the exact stored text, so equal hashes mean
 * byte-equal documents (the D10 no-op contract).
 */
export const assessBlob = (
  filePath: string,
  blob: Uint8Array,
  maxBlobBytes: number
): BlobAssessment => {
  if (blob.byteLength === 0) {
    return { kind: "empty" };
  }
  if (blob.byteLength > maxBlobBytes) {
    return { kind: "too-large" };
  }
  if (looksSecretNamed(filePath)) {
    return { kind: "secret" };
  }
  if (isBinaryExtension(filePath) || sniffBinary(blob)) {
    return { kind: "binary" };
  }
  const text = new TextDecoder("utf-8").decode(blob);
  if (contentLooksSecret(text)) {
    return { kind: "secret" };
  }
  return { contentHash: sha256Hex(text), kind: "text", text };
};

/** Normalize `git@host:path` scp syntax to a plain `ssh://` URL. */
export const normalizeRepositoryUrl = (raw: string): string => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(
      "git-source: repositoryUrl must be a non-empty string (https URL, ssh URL/scp syntax, or absolute local path)"
    );
  }
  const value = raw.trim();
  if (path.isAbsolute(value) || value.startsWith("file://")) {
    return value;
  }
  const scpMatch =
    /^(?<user>[^/@\s]+)@(?<host>[^:/\s]+):(?<repoPath>.+)$/u.exec(value);
  if (scpMatch !== null) {
    const { host, repoPath, user } = scpMatch.groups ?? {};
    if (
      user === undefined ||
      host === undefined ||
      repoPath === undefined ||
      repoPath.length === 0
    ) {
      throw new Error(
        `git-source: repositoryUrl ${JSON.stringify(value)} is not a valid scp-style URL`
      );
    }
    return `ssh://${user}@${host}/${repoPath.replace(/^\/+/u, "")}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `git-source: repositoryUrl ${JSON.stringify(value)} is not a valid URL or absolute local path`
    );
  }
  if (!["file:", "git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) {
    throw new Error(
      `git-source: repositoryUrl protocol ${JSON.stringify(parsed.protocol)} is not supported (use https, ssh, or a local path)`
    );
  }
  return value;
};

/**
 * Canonical, commit-pinned web URL for one file. Exact for GitHub,
 * GitLab, and Bitbucket; best-effort `<repo>/blob/<sha>/<path>` for other
 * forges; `file://` URL for local checkouts (the commit fields carry the
 * revision there).
 */
export const canonicalSourceUrl = (
  repositoryUrl: string,
  commitSha: string,
  filePath: string
): string => {
  const normalized = normalizeRepositoryUrl(repositoryUrl);
  if (normalized.startsWith("file://")) {
    return pathToFileURL(path.join(fileURLToPath(normalized), filePath)).href;
  }
  if (path.isAbsolute(normalized)) {
    return pathToFileURL(path.join(normalized, filePath)).href;
  }
  const url = new URL(normalized);
  // `url.origin` is "null" for non-special schemes (ssh:, git:); build the
  // base explicitly and map clone transports to their web scheme.
  const scheme =
    url.protocol === "ssh:" || url.protocol === "git:"
      ? "https:"
      : url.protocol;
  const host = `${url.hostname.toLowerCase()}${
    url.port.length > 0 ? `:${url.port}` : ""
  }`;
  const base = `${scheme}//${host}${url.pathname
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "")}`;
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return `${base}/-/blob/${commitSha}/${filePath}`;
  }
  if (host === "bitbucket.org") {
    return `${base}/src/${commitSha}/${filePath}`;
  }
  return `${base}/blob/${commitSha}/${filePath}`;
};

/** Deterministic RFC-4122-v5-shaped document id: sha1(ns, "git", path). */
export const documentIdFor = (
  namespace: string,
  externalId: string
): string => {
  const digest = createHash("sha1")
    .update(`${namespace}\u0000${GIT_SOURCE_KIND}\u0000${externalId}`, "utf-8")
    .digest("hex");
  const variantNibble = Number.parseInt(digest[16] ?? "8", 16);
  const variant = ((variantNibble % 4) + 8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
};

/**
 * Stable store key for one configured source: (namespace, repositoryUrl,
 * ref). Changing the ref starts a fresh manifest — old refs stay intact.
 */
export const deriveSourceKey = (resolved: {
  namespace: string;
  ref: string;
  repositoryUrl: string;
}): string =>
  `git-${createHash("sha256")
    .update(
      `${resolved.namespace}\u0000${resolved.repositoryUrl}\u0000${resolved.ref}`,
      "utf-8"
    )
    .digest("hex")
    .slice(0, 24)}`;

/**
 * Reject refs that could smuggle git options or break ref syntax
 * (leading `-`, whitespace, `~^:?*[\`, `..`, `@{`, trailing `.`/`/`,
 * `.lock` suffix) — refs are the only caller-controlled git argument.
 */
export const assertValidGitRef = (ref: string): string => {
  if (
    typeof ref !== "string" ||
    ref.length === 0 ||
    ref.length > 256 ||
    /\s/u.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    /[~^:?*[\]\\]/u.test(ref) ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock")
  ) {
    throw new Error(`git-source: invalid git ref ${JSON.stringify(ref)}`);
  }
  return ref;
};

/**
 * One configured knowledge source: repository URL, branch/ref, include and
 * exclude globs, and the knowledge namespace the documents land in. The
 * optional token authorizes private repos and is never persisted anywhere.
 */
export interface GitSourceConfig {
  /** Local clone cache directory override (exec adapter). */
  cacheDir?: string | null;
  /** Drop the default dir/lockfile/generated excludes. Default `false`. */
  applyDefaultExcludes?: boolean;
  /** Exclude globs (gitignore-lite), unioned with the defaults. */
  exclude?: string[];
  /** Include globs (gitignore-lite). Defaults to `["**"]`. */
  include?: string[];
  /** Max blob size to ingest. Defaults to `DEFAULT_MAX_BLOB_BYTES`. */
  maxBlobBytes?: number;
  /** Knowledge namespace (collection key, ADR-002 D9). Required. */
  namespace: string;
  /** Branch, tag, or commit-ish to sync. Required. */
  ref: string;
  /** Fetch new commits on open. Default `true`. */
  refresh?: boolean;
  /** Repository URL (https, ssh/scp, or local path) or clone. Required. */
  repositoryUrl: string;
  /** Access token for private repos; used in-memory only, never stored. */
  token?: string | null;
}

export interface ResolvedGitSourceConfig {
  applyDefaultExcludes: boolean;
  cacheDir: string | null;
  exclude: string[];
  include: string[];
  maxBlobBytes: number;
  namespace: string;
  ref: string;
  refresh: boolean;
  repositoryUrl: string;
  token: string | null;
}

const validatedPatterns = (
  patterns: string[],
  field: "exclude" | "include"
): string[] => {
  if (
    !Array.isArray(patterns) ||
    (field === "include" && patterns.length === 0)
  ) {
    throw new TypeError(
      `git-source: ${field} must be a non-empty array of glob strings`
    );
  }
  return patterns.map((pattern) => {
    if (
      typeof pattern !== "string" ||
      pattern.trim().length === 0 ||
      pattern.length > 4096 ||
      pattern.includes("\0")
    ) {
      throw new TypeError(
        `git-source: ${field} contains an invalid pattern ${JSON.stringify(pattern)}`
      );
    }
    compileGlob(pattern);
    return pattern;
  });
};

const validatedToken = (token: string): string => {
  if (typeof token !== "string" || !/^\S{8,512}$/u.test(token)) {
    throw new Error(
      "git-source: token must be a whitespace-free string (8-512 chars)"
    );
  }
  return token;
};

/** Validate and normalize a source config before any git command runs. */
export const resolveGitSourceConfig = (
  config: GitSourceConfig
): ResolvedGitSourceConfig => {
  const repositoryUrl = normalizeRepositoryUrl(config.repositoryUrl);
  const ref = assertValidGitRef(config.ref);
  const { namespace } = config;
  if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `git-source: invalid namespace ${JSON.stringify(namespace)}`
    );
  }
  if (config.maxBlobBytes !== undefined) {
    const { maxBlobBytes: max } = config;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(
        `git-source: maxBlobBytes must be an integer >= 1, got ${max}`
      );
    }
  }
  return {
    applyDefaultExcludes: config.applyDefaultExcludes !== false,
    cacheDir: config.cacheDir ?? null,
    exclude: validatedPatterns(config.exclude ?? [], "exclude"),
    include: validatedPatterns(config.include ?? ["**"], "include"),
    maxBlobBytes: config.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
    namespace,
    ref,
    refresh: config.refresh !== false,
    repositoryUrl,
    token:
      config.token === undefined || config.token === null
        ? null
        : validatedToken(config.token),
  };
};

/** One file entry from `git ls-tree -r`: a blob at a path in a commit. */
export interface GitTreeEntry {
  blobHash: string;
  path: string;
  /** Blob size in bytes when the repo knows it, else `null`. */
  size: number | null;
}

/**
 * Minimal repository surface sync consumes. `openGitRepository` builds one
 * from a real clone/fetch; tests can hand-sync with a fixture object.
 */
export interface GitRepository {
  listBlobs: (commitSha: string) => Promise<GitTreeEntry[]>;
  readBlob: (blobHash: string) => Promise<Uint8Array>;
  resolveCommit: (ref: string) => Promise<string>;
}

/** Last-ingested state of one path, the unit of incremental sync. */
export interface GitManifestEntry {
  blobHash: string;
  contentHash: string;
  documentId: string;
  firstCommitSha: string;
  path: string;
  version: number;
}

export interface GitSourceManifest {
  /** Commit of the last successful sync; `null` before the first sync. */
  commitSha: string | null;
  /** path → last-ingested entry. */
  entries: Record<string, GitManifestEntry>;
  sourceKey: string;
}

export type GitSyncOp =
  | {
      blobHash: string;
      documentId: string;
      kind: "added";
      path: string;
      size: number | null;
    }
  | {
      blobHash: string;
      documentId: string;
      kind: "deleted";
      path: string;
      previous: GitManifestEntry;
    }
  | {
      blobHash: string;
      documentId: string;
      kind: "modified";
      path: string;
      previous: GitManifestEntry;
      size: number | null;
    }
  | {
      blobHash: string;
      documentId: string;
      fromPath: string;
      kind: "renamed";
      previous: GitManifestEntry;
      size: number | null;
      toPath: string;
    }
  | {
      blobHash: string;
      documentId: string;
      kind: "unchanged";
      path: string;
    };

const primaryPath = (op: GitSyncOp): string =>
  op.kind === "renamed" ? op.toPath : op.path;

/**
 * Diff the previous manifest against the current tree. Pure and
 * deterministic: ops are grouped unchanged → added → modified → renamed →
 * deleted, each group sorted by path. A deletion is paired with an added
 * path carrying the same blob hash as a rename (one-to-one, sorted order);
 * an identical blob at two live paths is a copy and both stay adds.
 */
export const planGitSource = (
  manifest: GitSourceManifest,
  tree: GitTreeEntry[],
  namespace: string
): GitSyncOp[] => {
  const current = tree.toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const currentPaths = new Set(current.map((entry) => entry.path));
  const previousPaths = Object.keys(manifest.entries).toSorted();
  const unchanged: GitSyncOp[] = [];
  const added: Extract<GitSyncOp, { kind: "added" }>[] = [];
  const modified: Extract<GitSyncOp, { kind: "modified" }>[] = [];
  const deleted: Extract<GitSyncOp, { kind: "deleted" }>[] = [];
  for (const entry of current) {
    const previous = manifest.entries[entry.path];
    if (previous === undefined) {
      added.push({
        blobHash: entry.blobHash,
        documentId: documentIdFor(namespace, entry.path),
        kind: "added",
        path: entry.path,
        size: entry.size,
      });
    } else if (previous.blobHash === entry.blobHash) {
      unchanged.push({
        blobHash: entry.blobHash,
        documentId: previous.documentId,
        kind: "unchanged",
        path: entry.path,
      });
    } else {
      modified.push({
        blobHash: entry.blobHash,
        documentId: previous.documentId,
        kind: "modified",
        path: entry.path,
        previous,
        size: entry.size,
      });
    }
  }
  for (const stalePath of previousPaths) {
    if (!currentPaths.has(stalePath)) {
      const previous = manifest.entries[stalePath];
      if (previous === undefined) {
        throw new Error(`git-source: manifest lost entry ${stalePath}`);
      }
      deleted.push({
        blobHash: previous.blobHash,
        documentId: previous.documentId,
        kind: "deleted",
        path: stalePath,
        previous,
      });
    }
  }
  // Pair each deletion with an added path carrying the same blob hash:
  // that is a rename (git mv without edits). Copies keep both adds.
  const consumedDeletes = new Set<string>();
  const renamed: Extract<GitSyncOp, { kind: "renamed" }>[] = [];
  for (const add of added) {
    const source = deleted.find(
      (candidate) =>
        !consumedDeletes.has(candidate.path) &&
        candidate.blobHash === add.blobHash
    );
    if (source === undefined) {
      continue;
    }
    consumedDeletes.add(source.path);
    renamed.push({
      blobHash: add.blobHash,
      documentId: documentIdFor(namespace, add.path),
      fromPath: source.path,
      kind: "renamed",
      previous: source.previous,
      size: add.size,
      toPath: add.path,
    });
  }
  const renamedPaths = new Set(renamed.map((rename) => rename.toPath));
  const keptAdds = added.filter((add) => !renamedPaths.has(add.path));
  const remainingDeletes = deleted.filter(
    (candidate) => !consumedDeletes.has(candidate.path)
  );
  return [
    ...unchanged,
    ...keptAdds,
    ...modified,
    ...renamed,
    ...remainingDeletes,
  ];
};

/** One normalized document with full Git provenance (see module header). */
export interface GitSourceDocument {
  blobHash: string;
  commitSha: string;
  contentHash: string;
  contentKind: "code" | "markdown" | "text";
  documentId: string;
  externalId: string;
  firstCommitSha: string;
  language: string | null;
  lineRange: { end: number; start: number };
  namespace: string;
  path: string;
  previousBlobHash: string | null;
  previousContentHash: string | null;
  ref: string;
  renamedFrom: string | null;
  repositoryUrl: string;
  source: typeof GIT_SOURCE_KIND;
  text: string;
  title: string;
  url: string;
  version: number;
}

/** Tombstone: a path that stopped existing (or moved) at `tombstoneCommitSha`. */
export interface GitTombstone {
  blobHash: string;
  contentHash: string;
  documentId: string;
  externalId: string;
  namespace: string;
  renamedTo: string | null;
  tombstoneCommitSha: string;
  version: number;
}

/**
 * Persistence contract for sync. A durable implementation maps onto the
 * ADR-002 D3 `document` table (`source = "git"`, `external_id = path`,
 * `content_hash`, version bumps, `deleted_at` tombstones); the in-memory
 * store keeps tests offline.
 */
export interface GitSourceStore {
  loadManifest: (sourceKey: string) => Promise<GitSourceManifest>;
  saveManifest: (manifest: GitSourceManifest) => Promise<void>;
  tombstoneDocument: (tombstone: GitTombstone) => Promise<void>;
  upsertDocument: (document: GitSourceDocument) => Promise<void>;
}

export interface InMemoryGitSourceStore extends GitSourceStore {
  documents: Map<string, GitSourceDocument>;
  manifests: Map<string, GitSourceManifest>;
  tombstones: GitTombstone[];
}

export const createInMemoryGitSourceStore = (): InMemoryGitSourceStore => {
  const documents = new Map<string, GitSourceDocument>();
  const manifests = new Map<string, GitSourceManifest>();
  const tombstones: GitTombstone[] = [];
  return {
    documents,
    loadManifest: (sourceKey) =>
      Promise.resolve(
        manifests.get(sourceKey) ?? {
          commitSha: null,
          entries: {},
          sourceKey,
        }
      ),
    manifests,
    saveManifest: (manifest) => {
      manifests.set(manifest.sourceKey, manifest);
      return Promise.resolve();
    },
    tombstoneDocument: (tombstone) => {
      tombstones.push(tombstone);
      documents.delete(tombstone.documentId);
      return Promise.resolve();
    },
    tombstones,
    upsertDocument: (document) => {
      documents.set(document.documentId, document);
      return Promise.resolve();
    },
  };
};

const lineCount = (text: string): number => {
  if (text.length === 0) {
    return 0;
  }
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
};

const buildGitDocument = (
  resolved: ResolvedGitSourceConfig,
  op: Extract<GitSyncOp, { kind: "added" | "modified" | "renamed" }>,
  assessment: Extract<BlobAssessment, { kind: "text" }>,
  commitSha: string
): GitSourceDocument => {
  const filePath = primaryPath(op);
  const previous = op.kind === "added" ? undefined : op.previous;
  const classification = classifyContent(filePath);
  const firstCommitSha = previous?.firstCommitSha ?? commitSha;
  // A renamed path is a fresh document row (new external_id): version 1,
  // with the lineage carried by renamedFrom/previous* provenance.
  const version =
    op.kind === "renamed" || previous === undefined ? 1 : previous.version + 1;
  return {
    blobHash: op.blobHash,
    commitSha,
    contentHash: assessment.contentHash,
    contentKind: classification.contentKind,
    documentId: documentIdFor(resolved.namespace, filePath),
    externalId: filePath,
    firstCommitSha,
    language: classification.language,
    lineRange: { end: lineCount(assessment.text), start: 1 },
    namespace: resolved.namespace,
    path: filePath,
    previousBlobHash: previous?.blobHash ?? null,
    previousContentHash: previous?.contentHash ?? null,
    ref: resolved.ref,
    renamedFrom: op.kind === "renamed" ? op.fromPath : null,
    repositoryUrl: resolved.repositoryUrl,
    source: GIT_SOURCE_KIND,
    text: assessment.text,
    title: path.basename(filePath),
    url: canonicalSourceUrl(resolved.repositoryUrl, commitSha, filePath),
    version,
  };
};

const manifestEntryOf = (document: GitSourceDocument): GitManifestEntry => ({
  blobHash: document.blobHash,
  contentHash: document.contentHash,
  documentId: document.documentId,
  firstCommitSha: document.firstCommitSha,
  path: document.path,
  version: document.version,
});

const tombstoneOf = (
  previous: GitManifestEntry,
  externalId: string,
  namespace: string,
  commitSha: string,
  renamedTo: string | null
): GitTombstone => ({
  blobHash: previous.blobHash,
  contentHash: previous.contentHash,
  documentId: previous.documentId,
  externalId,
  namespace,
  renamedTo,
  tombstoneCommitSha: commitSha,
  version: previous.version,
});

export interface GitTreeFilter {
  entries: GitTreeEntry[];
  excluded: number;
}

export const isDefaultExcluded = (filePath: string): boolean =>
  DEFAULT_EXCLUDE_PATTERNS.some((pattern) => matchGitPath(pattern, filePath));
/** Include/exclude/default filtering over one commit's blobs. */
export const filterGitTree = (
  tree: GitTreeEntry[],
  resolved: ResolvedGitSourceConfig
): GitTreeFilter => {
  const entries = tree.filter(
    (entry) =>
      resolved.include.some((pattern) => matchGitPath(pattern, entry.path)) &&
      !resolved.exclude.some((pattern) => matchGitPath(pattern, entry.path)) &&
      !(resolved.applyDefaultExcludes && isDefaultExcluded(entry.path))
  );
  return { entries, excluded: tree.length - entries.length };
};

export interface GitSyncCounts {
  added: number;
  deleted: number;
  modified: number;
  renamed: number;
  skippedBinary: number;
  skippedEmpty: number;
  skippedSecret: number;
  skippedTooLarge: number;
  unchanged: number;
}

export interface GitSyncReport extends GitSyncCounts {
  /** Entries kept after include/exclude filtering. */
  excluded: number;
  commitSha: string;
  /** Changed ops only (add/change/rename/delete); unchanged is a count. */
  ops: GitSyncOp[];
  scanned: number;
  sourceKey: string;
}

/**
 * Apply one diffed plan. Content reads run concurrently (`Promise.all`)
 * but every store write is derived from the deterministic op order, so
 * the resulting manifest and report are stable for a given commit.
 */
export const syncGitSource = async (
  repository: GitRepository,
  store: GitSourceStore,
  config: GitSourceConfig
): Promise<GitSyncReport> => {
  const resolved = resolveGitSourceConfig(config);
  const sourceKey = deriveSourceKey(resolved);
  const commitSha = await repository.resolveCommit(resolved.ref);
  const tree = await repository.listBlobs(commitSha);
  const { entries: keptEntries, excluded } = filterGitTree(tree, resolved);
  const manifest = await store.loadManifest(sourceKey);
  const ops = planGitSource(manifest, keptEntries, resolved.namespace);
  const changed = ops.filter((op) => op.kind !== "unchanged");
  const counts: GitSyncCounts = {
    added: 0,
    deleted: 0,
    modified: 0,
    renamed: 0,
    skippedBinary: 0,
    skippedEmpty: 0,
    skippedSecret: 0,
    skippedTooLarge: 0,
    unchanged: ops.length - changed.length,
  };
  const nextEntries = new Map<string, GitManifestEntry>(
    Object.entries(manifest.entries)
  );
  const tombstones: GitTombstone[] = [];
  const examined = await Promise.all(
    changed
      .filter(
        (
          op
        ): op is Extract<
          GitSyncOp,
          { kind: "added" | "modified" | "renamed" }
        > => op.kind !== "deleted"
      )
      .map(async (op) => ({
        assessment:
          op.size !== null && op.size > resolved.maxBlobBytes
            ? ({ kind: "too-large" } as const)
            : assessBlob(
                primaryPath(op),
                await repository.readBlob(op.blobHash),
                resolved.maxBlobBytes
              ),
        op,
      }))
  );
  const upserts: GitSourceDocument[] = [];
  const skipCount = (assessment: { kind: string }): void => {
    if (assessment.kind === "binary") {
      counts.skippedBinary += 1;
    } else if (assessment.kind === "empty") {
      counts.skippedEmpty += 1;
    } else if (assessment.kind === "secret") {
      counts.skippedSecret += 1;
    } else if (assessment.kind === "too-large") {
      counts.skippedTooLarge += 1;
    }
  };
  for (const { assessment, op } of examined) {
    if (assessment.kind !== "text") {
      skipCount(assessment);
      if (op.kind === "modified") {
        // The path no longer yields ingestable text: tombstone the stale
        // document so the old version stops serving.
        tombstones.push(
          tombstoneOf(op.previous, op.path, resolved.namespace, commitSha, null)
        );
        nextEntries.delete(op.path);
      }
      continue;
    }
    const document = buildGitDocument(resolved, op, assessment, commitSha);
    upserts.push(document);
    nextEntries.set(document.path, manifestEntryOf(document));
    if (op.kind === "renamed") {
      tombstones.push(
        tombstoneOf(
          op.previous,
          op.fromPath,
          resolved.namespace,
          commitSha,
          op.toPath
        )
      );
      nextEntries.delete(op.fromPath);
      counts.renamed += 1;
    } else if (op.kind === "added") {
      counts.added += 1;
    } else {
      counts.modified += 1;
    }
  }
  for (const op of changed) {
    if (op.kind !== "deleted") {
      continue;
    }
    tombstones.push(
      tombstoneOf(op.previous, op.path, resolved.namespace, commitSha, null)
    );
    nextEntries.delete(op.path);
    counts.deleted += 1;
  }
  await Promise.all([
    ...upserts.map((document) => store.upsertDocument(document)),
    ...tombstones.map((tombstone) => store.tombstoneDocument(tombstone)),
  ]);
  await store.saveManifest({
    commitSha,
    entries: Object.fromEntries(nextEntries),
    sourceKey,
  });
  return {
    ...counts,
    commitSha,
    excluded,
    ops: changed,
    scanned: keptEntries.length,
    sourceKey,
  };
};

/**
 * Per-invocation auth environment. The token rides in `GIT_CONFIG_*` env
 * vars as an `http.extraheader` override — scoped to exactly these git
 * processes, never written to any config file, never part of argv. Also
 * disables interactive prompts so a private repo with a missing/invalid
 * token fails fast instead of hanging.
 */
const gitAuthConfig = (token: string): NodeJS.ProcessEnv => {
  const authorization = Buffer.from(
    `x-access-token:${token}`,
    "utf-8"
  ).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
  };
};

/**
 * Per-invocation auth environment. The token rides in `GIT_CONFIG_*` env
 * vars as an `http.extraheader` override — scoped to exactly these git
 * processes, never written to any config file, never part of argv. Also
 * disables interactive prompts so a private repo with a missing/invalid
 * token fails fast instead of hanging.
 */
export const gitProcessEnv = (token: string | null): NodeJS.ProcessEnv => {
  const auth = token === null ? {} : gitAuthConfig(token);
  return {
    ...process.env,
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
    GIT_TERMINAL_PROMPT: "0",
    ...auth,
  };
};

interface ExecGitError extends Error {
  stderr?: Buffer | string;
}

const execGit = async (
  args: string[],
  options: {
    cwd?: string | undefined;
    env: NodeJS.ProcessEnv;
    maxBuffer?: number | undefined;
  }
): Promise<Buffer> => {
  try {
    const { stdout } = await promisify(execFile)("git", args, {
      cwd: options.cwd,
      encoding: "buffer",
      env: options.env,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      timeout: 300_000,
    });
    return stdout;
  } catch (error) {
    const { stderr } = error as ExecGitError;
    const text =
      typeof stderr === "string"
        ? stderr.trim()
        : (stderr?.toString("utf-8").trim() ?? "");
    throw new Error(
      `git ${args[0] ?? "git"} failed${text.length > 0 ? `: ${text}` : ""}`,
      { cause: error }
    );
  }
};

const GIT_LS_TREE_PATTERN =
  /^(?<mode>\d{6}) (?<type>\w+) (?<sha>[0-9a-f]{40})\s+(?<size>\S+)$/u;

const parseGitLsTree = (output: string): GitTreeEntry[] => {
  const entries: GitTreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const tabIndex = record.indexOf("\t");
    const meta = record.slice(0, Math.max(tabIndex, 0));
    const filePath = tabIndex === -1 ? "" : record.slice(tabIndex + 1);
    // `--long` right-aligns the size column: `100644 blob <sha>     22\t<path>`.
    const match = GIT_LS_TREE_PATTERN.exec(meta);
    if (tabIndex === -1 || filePath.length === 0 || match === null) {
      throw new TypeError(
        `git-source: malformed ls-tree record ${JSON.stringify(record.slice(0, 80))}`
      );
    }
    const { mode, sha, size, type } = match.groups ?? {};
    if (
      mode === undefined ||
      type === undefined ||
      sha === undefined ||
      size === undefined
    ) {
      throw new TypeError("git-source: malformed ls-tree record");
    }
    if (type !== "blob" || mode === "120000" || mode === "160000") {
      continue;
    }
    const parsedSize = Math.trunc(Number(size));
    const parsed = size === "-" ? null : parsedSize;
    if (parsed !== null && !Number.isInteger(parsed)) {
      throw new TypeError(
        `git-source: malformed ls-tree size ${JSON.stringify(size)}`
      );
    }
    entries.push({ blobHash: sha, path: filePath, size: parsed });
  }
  return entries;
};

/**
 * Real repository backed by a local clone/fetch cache: one directory per
 * repository URL under `cacheDir` (default
 * `<tmpdir>/knowledge-git-source`), refreshed with `git fetch --prune`.
 * Blobs are read on demand with `git cat-file`; the tree comes from
 * `git ls-tree -r`. Never shells out — every command is a direct exec
 * with validated arguments, and the access token (if any) reaches git
 * only through `GIT_CONFIG_*` env vars.
 */
export interface OpenGitRepositoryOptions {
  cacheDir?: string | null;
  /** Fetch new commits on open. Default `true`. */
  refresh?: boolean;
  repositoryUrl: string;
  token?: string | null;
}

export const openGitRepository = async (
  options: OpenGitRepositoryOptions
): Promise<GitRepository> => {
  const repositoryUrl = normalizeRepositoryUrl(options.repositoryUrl);
  const cacheDir =
    options.cacheDir ?? path.join(tmpdir(), "knowledge-git-source");
  await mkdir(cacheDir, { recursive: true });
  const localDir = path.join(
    cacheDir,
    createHash("sha1").update(repositoryUrl, "utf-8").digest("hex").slice(0, 20)
  );
  const env = gitProcessEnv(options.token ?? null);
  const localRoot =
    repositoryUrl.startsWith("/") || repositoryUrl.startsWith("file://");
  let cloned = false;
  try {
    await stat(path.join(localDir, "HEAD"));
    cloned = true;
  } catch {
    cloned = false;
  }
  if (!cloned) {
    await execGit(
      localRoot
        ? ["clone", "--bare", repositoryUrl, localDir]
        : ["clone", "--bare", "--filter=blob:none", repositoryUrl, localDir],
      { env }
    );
  } else if (options.refresh !== false) {
    await execGit(
      [
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ],
      { cwd: localDir, env }
    );
  }
  const run = (args: string[], maxBuffer?: number): Promise<Buffer> =>
    execGit(args, { cwd: localDir, env, maxBuffer });
  const revParse = async (candidate: string): Promise<string | null> => {
    try {
      const output = await run([
        "rev-parse",
        "--verify",
        "--end-of-options",
        candidate,
      ]);
      const commit = output.toString("utf-8").trim();
      return BLOB_SHA_PATTERN.test(commit) ? commit : null;
    } catch {
      return null;
    }
  };
  return {
    listBlobs: async (commitSha) => {
      const output = await run(["ls-tree", "-r", "--long", "-z", commitSha]);
      return parseGitLsTree(output.toString("utf-8"));
    },
    readBlob: async (blobHash) => {
      if (!BLOB_SHA_PATTERN.test(blobHash)) {
        throw new TypeError(
          `git-source: invalid blob sha ${JSON.stringify(blobHash)}`
        );
      }
      try {
        return await run(["cat-file", "blob", blobHash]);
      } catch (error) {
        if (
          error instanceof Error &&
          /maxBuffer|ENOBUFS/u.test(error.message)
        ) {
          throw new RangeError(
            `git-source: blob ${blobHash} exceeds the configured maxBlobBytes`,
            { cause: error }
          );
        }
        throw error;
      }
    },
    resolveCommit: async (ref) => {
      assertValidGitRef(ref);
      // Fetch-updated remote tracking refs first (a bare clone's local
      // heads go stale on refresh), then git's DWIM (tags, raw SHAs).
      const fromOrigin = await revParse(`refs/remotes/origin/${ref}^{commit}`);
      if (fromOrigin !== null) {
        return fromOrigin;
      }
      const direct = await revParse(`${ref}^{commit}`);
      if (direct !== null) {
        return direct;
      }
      throw new Error(
        `git-source: ref ${JSON.stringify(ref)} not found in ${repositoryUrl}`
      );
    },
  };
};

/**
 * Convenience: open (clone/fetch) the configured repository, then sync.
 * Reuses the shared local clone cache between runs.
 */
export const syncGitRepository = async (
  store: GitSourceStore,
  config: GitSourceConfig
): Promise<GitSyncReport> => {
  const resolved = resolveGitSourceConfig(config);
  const repository = await openGitRepository({
    cacheDir: resolved.cacheDir,
    refresh: resolved.refresh,
    repositoryUrl: resolved.repositoryUrl,
    token: resolved.token,
  });
  return syncGitSource(repository, store, resolved);
};
