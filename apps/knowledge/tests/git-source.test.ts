import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  assessBlob,
  canonicalSourceUrl,
  classifyContent,
  createInMemoryGitSourceStore,
  DEFAULT_EXCLUDE_PATTERNS,
  deriveSourceKey,
  documentIdFor,
  filterGitTree,
  gitProcessEnv,
  isBinaryExtension,
  isDefaultExcluded,
  looksSecretNamed,
  matchGitPath,
  normalizeRepositoryUrl,
  openGitRepository,
  planGitSource,
  resolveGitSourceConfig,
  sha256Hex,
  sniffBinary,
  syncGitRepository,
  syncGitSource,
} from "../src/git-source.ts";
import type {
  GitManifestEntry,
  GitRepository,
  GitSourceConfig,
} from "../src/git-source.ts";

const NAMESPACE = "git-source-test";

const git = (repoDir: string, args: string[]): Buffer =>
  execFileSync("git", args, {
    cwd: repoDir,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });

const commitAll = (repoDir: string, message: string): string => {
  git(repoDir, ["add", "-A"]);
  git(repoDir, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-m",
    message,
  ]);
  return git(repoDir, ["rev-parse", "HEAD"]).toString("utf-8").trim();
};

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
]);

const writeFixtureFile = async (
  repoDir: string,
  relativePath: string,
  content: string | Uint8Array
): Promise<void> => {
  const target = path.join(repoDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
};

const createFixtureRepository = async (): Promise<{
  cacheDir: string;
  cleanup: () => Promise<void>;
  repoDir: string;
  root: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "git-source-test-"));
  const repoDir = path.join(root, "repo");
  const cacheDir = path.join(root, "cache");
  await mkdir(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  await writeFixtureFile(
    repoDir,
    "README.md",
    "# Fixture repo\n\nUsed by the git-source tests.\n"
  );
  await writeFixtureFile(repoDir, "notes.txt", "scratch notes\n");
  await writeFixtureFile(repoDir, "empty.txt", "");
  await writeFixtureFile(
    repoDir,
    "src/app.ts",
    'export const main = (): string => "hello";\n'
  );
  await writeFixtureFile(repoDir, "src/lib.ts", "export const answer = 42;\n");
  await writeFixtureFile(
    repoDir,
    "package-lock.json",
    '{"lockfileVersion": 3}\n'
  );
  await writeFixtureFile(repoDir, ".env", "API_TOKEN=supersecret\n");
  await writeFixtureFile(repoDir, "assets/logo.png", PNG_BYTES);
  await writeFixtureFile(repoDir, "vendor/dep.js", "module.exports = 1;\n");
  await writeFixtureFile(repoDir, "secrets/key.txt", "k\n");
  commitAll(repoDir, "initial");
  return {
    cacheDir,
    cleanup: () => rm(root, { force: true, recursive: true }),
    repoDir,
    root,
  };
};

const sourceConfig = (
  repoDir: string,
  overrides: Partial<GitSourceConfig> = {}
): GitSourceConfig => ({
  cacheDir: path.join(repoDir, "..", "cache"),
  namespace: NAMESPACE,
  ref: "main",
  repositoryUrl: repoDir,
  ...overrides,
});

const manifestEntry = (
  filePath: string,
  blobHash: string,
  version = 1
): GitManifestEntry => ({
  blobHash,
  contentHash: `hash-${filePath}`,
  documentId: documentIdFor(NAMESPACE, filePath),
  firstCommitSha: "a".repeat(40),
  path: filePath,
  version,
});

test("config validation: urls, refs, namespace, patterns, token", () => {
  assert.deepEqual(
    resolveGitSourceConfig({
      namespace: "docs",
      ref: "main",
      repositoryUrl: "git@github.com:owner/repo.git",
    }).repositoryUrl,
    "ssh://git@github.com/owner/repo.git"
  );

  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "main",
        repositoryUrl: "not a url",
      }),
    /repositoryUrl/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "-c",
        repositoryUrl: "/tmp/x",
      }),
    /invalid git ref/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "a..b",
        repositoryUrl: "/tmp/x",
      }),
    /invalid git ref/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "HEAD@{0}",
        repositoryUrl: "/tmp/x",
      }),
    /invalid git ref/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "x.lock",
        repositoryUrl: "/tmp/x",
      }),
    /invalid git ref/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "bad namespace!",
        ref: "main",
        repositoryUrl: "/tmp/x",
      }),
    /invalid namespace/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        include: [],
        namespace: "n",
        ref: "main",
        repositoryUrl: "/tmp/x",
      }),
    /include/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        exclude: ["ok", ""],
        namespace: "n",
        ref: "main",
        repositoryUrl: "/tmp/x",
      }),
    /exclude/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        maxBlobBytes: 0,
        namespace: "n",
        ref: "main",
        repositoryUrl: "/tmp/x",
      }),
    /maxBlobBytes/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "main",
        repositoryUrl: "/tmp/x",
        token: "short",
      }),
    /token/u
  );
  assert.throws(
    () =>
      resolveGitSourceConfig({
        namespace: "n",
        ref: "main",
        repositoryUrl: "/tmp/x",
        token: "has space",
      }),
    /token/u
  );
});

test("token is carried in env-scoped git config, never in argv or plain env", () => {
  const withToken = gitProcessEnv("ghp_super-secret-token-123456");
  assert.equal(withToken.GIT_TERMINAL_PROMPT, "0");
  assert.equal(withToken.GIT_CONFIG_KEY_0, "http.extraheader");
  assert.match(withToken.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /u);
  assert.equal(
    withToken.GIT_CONFIG_VALUE_0?.includes("ghp_super-secret-token-123456"),
    false
  );
  const withoutToken = gitProcessEnv(null);
  assert.equal(withoutToken.GIT_CONFIG_COUNT, undefined);
  assert.equal(withoutToken.GIT_TERMINAL_PROMPT, "0");
});

test("document ids are deterministic, UUID-shaped, and path-scoped", () => {
  const first = documentIdFor("ns", "README.md");
  const again = documentIdFor("ns", "README.md");
  const other = documentIdFor("ns", "docs/README.md");
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
});

test("source keys separate namespace, repository, and ref", () => {
  const base = { namespace: "n", ref: "main", repositoryUrl: "/tmp/r" };
  assert.equal(deriveSourceKey(base), deriveSourceKey({ ...base }));
  assert.notEqual(
    deriveSourceKey(base),
    deriveSourceKey({ ...base, ref: "dev" })
  );
});

test("glob matching covers **, dir subtrees, bare names, and anchoring", () => {
  assert.equal(matchGitPath("**", "any/where.md"), true);
  assert.equal(matchGitPath("*.md", "docs/a.md"), true);
  assert.equal(matchGitPath("*.md", "docs/a.txt"), false);
  assert.equal(matchGitPath("src/**", "src/a/b.ts"), true);
  assert.equal(matchGitPath("src/**", "other/x.ts"), false);
  assert.equal(matchGitPath("docs/", "docs/x.md"), true);
  assert.equal(matchGitPath("docs/", "other/x.md"), false);
  assert.equal(matchGitPath("**/*.ts", "a.ts"), true);
  assert.equal(matchGitPath("**/*.ts", "x/y.ts"), true);
  assert.equal(matchGitPath("/README.md", "README.md"), true);
  assert.equal(matchGitPath("/README.md", "docs/README.md"), false);
  assert.equal(matchGitPath("vendor", "vendor/x.js"), true);
  assert.equal(matchGitPath("vendor", "src/vendor/y.js"), true);
  assert.equal(matchGitPath("vendor", "src/myvendor.js"), false);
  assert.equal(matchGitPath("a/**/b.ts", "a/b.ts"), true);
  assert.equal(matchGitPath("a/**/b.ts", "a/x/y/b.ts"), true);
  assert.equal(matchGitPath("?.ts", "a.ts"), true);
  assert.equal(matchGitPath("?.ts", "ab.ts"), false);
  assert.equal(matchGitPath(".env.*", ".env.local"), true);
  assert.throws(() => matchGitPath("", "x"), /invalid path pattern/u);
});

test("defaults exclude vendored, generated, lockfiles, binaries, and secrets", () => {
  // Name-based defaults cover vendored/generated dirs, lockfiles, and
  // secret-looking names; binary payloads are excluded by default at
  // assessment time (the fixture sync proves that end to end).
  for (const excluded of [
    "package-lock.json",
    "yarn.lock",
    "Cargo.lock",
    "node_modules/x.js",
    "vendor/y.go",
    "third_party/z.cc",
    "dist/bundle.js",
    "gen/proto/api.pb.go",
    "src/types.d.ts",
    "app.min.js",
    ".env",
    ".env.local",
    "server.pem",
    "host.key",
    "id_rsa",
    "secrets/key.txt",
    "credentials.json",
  ]) {
    assert.equal(isDefaultExcluded(excluded), true, excluded);
  }
  assert.equal(isBinaryExtension("logo.png"), true);
  assert.equal(isBinaryExtension("archive.zip"), true);
  for (const kept of [
    "README.md",
    "src/app.ts",
    "docs/guide.md",
    "assets/diagram.svg",
    "requirements.txt",
    "infra/main.tf",
  ]) {
    assert.equal(isDefaultExcluded(kept), false, kept);
  }
  assert.ok(DEFAULT_EXCLUDE_PATTERNS.includes("node_modules"));
});

test("secret-name detection applies in every mode", () => {
  assert.equal(looksSecretNamed(".env"), true);
  assert.equal(looksSecretNamed("config/.env.production"), true);
  assert.equal(looksSecretNamed("secrets/api.txt"), true);
  assert.equal(looksSecretNamed("src/app.ts"), false);
});

test("binary detection: extensions, NUL bytes, and mojibake ratio", () => {
  assert.equal(isBinaryExtension("logo.png"), true);
  assert.equal(isBinaryExtension("notes.txt"), false);
  assert.equal(sniffBinary(PNG_BYTES), true);
  assert.equal(sniffBinary(Uint8Array.from([0x61, 0x62, 0x63])), false);
  const latin1 = Uint8Array.from([0x61, 0xe9, 0xff, 0xe9, 0xff, 0xe9, 0xff]);
  assert.equal(sniffBinary(latin1), true);
});

test("blob assessment gates: empty, too-large, secret, binary, text", () => {
  assert.deepEqual(assessBlob("empty.txt", Uint8Array.of(), 1000), {
    kind: "empty",
  });
  assert.deepEqual(assessBlob("big.txt", Uint8Array.from([1, 2, 3, 4]), 3), {
    kind: "too-large",
  });
  assert.deepEqual(assessBlob(".env", Uint8Array.from([0x41]), 1000), {
    kind: "secret",
  });
  assert.deepEqual(assessBlob("blob.bin", PNG_BYTES, 1000), {
    kind: "binary",
  });
  const pem =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
  assert.deepEqual(
    assessBlob("id_file", Uint8Array.from(Buffer.from(pem, "utf-8")), 1000),
    { kind: "secret" }
  );
  const text = assessBlob(
    "src/app.ts",
    Uint8Array.from(Buffer.from("export {};\n", "utf-8")),
    1000
  );
  assert.equal(text.kind, "text");
  assert.ok(text.kind === "text");
  assert.equal(text.contentHash, sha256Hex("export {};\n"));
  assert.equal(
    text.contentHash,
    createHash("sha256").update("export {};\n", "utf-8").digest("hex")
  );
});

test("content classification separates markdown, code, and plain text", () => {
  assert.deepEqual(classifyContent("README.md"), {
    contentKind: "markdown",
    language: "markdown",
  });
  assert.deepEqual(classifyContent("src/app.ts"), {
    contentKind: "code",
    language: "ts",
  });
  assert.deepEqual(classifyContent("Dockerfile"), {
    contentKind: "code",
    language: "dockerfile",
  });
  assert.deepEqual(classifyContent("notes.txt"), {
    contentKind: "text",
    language: null,
  });
});

test("canonical URLs are commit-pinned per forge and file:// for local", () => {
  const sha = "a".repeat(40);
  assert.equal(
    canonicalSourceUrl("https://github.com/owner/repo.git", sha, "a/b.md"),
    `https://github.com/owner/repo/blob/${sha}/a/b.md`
  );
  assert.equal(
    canonicalSourceUrl("https://gitlab.com/owner/repo", sha, "a.md"),
    `https://gitlab.com/owner/repo/-/blob/${sha}/a.md`
  );
  assert.equal(
    canonicalSourceUrl("https://bitbucket.org/owner/repo", sha, "a.md"),
    `https://bitbucket.org/owner/repo/src/${sha}/a.md`
  );
  assert.equal(
    canonicalSourceUrl("git@github.com:owner/repo.git", sha, "a.md"),
    `https://github.com/owner/repo/blob/${sha}/a.md`
  );
  assert.equal(
    canonicalSourceUrl("/tmp/repo", sha, "a.md"),
    pathToFileURL(path.join("/tmp/repo", "a.md")).href
  );
});

test("tree filtering: include, exclude, and default exclusions compose", () => {
  const resolved = resolveGitSourceConfig({
    exclude: ["src/legacy/**"],
    include: ["**"],
    namespace: "n",
    ref: "main",
    repositoryUrl: "/tmp/r",
  });
  const tree = [
    { blobHash: "1".repeat(40), path: "README.md", size: 10 },
    { blobHash: "2".repeat(40), path: "src/app.ts", size: 10 },
    { blobHash: "3".repeat(40), path: "src/legacy/old.ts", size: 10 },
    { blobHash: "4".repeat(40), path: "vendor/dep.js", size: 10 },
  ];
  const filtered = filterGitTree(tree, resolved);
  assert.deepEqual(
    filtered.entries.map((entry) => entry.path),
    ["README.md", "src/app.ts"]
  );
  assert.equal(filtered.excluded, 2);
});

test("plan diffs add/change/delete/rename and skips unchanged blobs", () => {
  const manifest = {
    commitSha: "a".repeat(40),
    entries: {
      "kept.ts": manifestEntry("kept.ts", "b".repeat(40)),
      "old.txt": manifestEntry("old.txt", "c".repeat(40)),
      "same.ts": manifestEntry("same.ts", "d".repeat(40)),
    },
    sourceKey: "k",
  };
  const tree = [
    { blobHash: "9".repeat(40), path: "kept.ts", size: 1 },
    { blobHash: "e".repeat(40), path: "changed.ts", size: 1 },
    { blobHash: "c".repeat(40), path: "moved.ts", size: 1 },
    { blobHash: "d".repeat(40), path: "same.ts", size: 1 },
    { blobHash: "f".repeat(40), path: "new.ts", size: 1 },
  ];
  const ops = planGitSource(manifest, tree, NAMESPACE);
  const kinds = Object.fromEntries(ops.map((op) => [op.kind, op]));
  assert.ok(kinds["unchanged"]);
  assert.ok(kinds["added"]);
  assert.ok(kinds["modified"]);
  assert.ok(kinds["renamed"]);
  // The deleted old.txt blob reappearing at moved.ts is the rename; no
  // plain deletion remains.
  assert.equal(
    ops.some((op) => op.kind === "deleted"),
    false
  );
  if (kinds["renamed"]?.kind === "renamed") {
    assert.equal(kinds["renamed"].fromPath, "old.txt");
    assert.equal(kinds["renamed"].toPath, "moved.ts");
    assert.equal(
      kinds["renamed"].documentId,
      documentIdFor(NAMESPACE, "moved.ts")
    );
  } else {
    assert.fail("expected rename op");
  }
  // Deterministic: same inputs, same ops.
  assert.deepEqual(planGitSource(manifest, tree, NAMESPACE), ops);
});

test("plan keeps copies as separate adds (same blob, both paths live)", () => {
  const ops = planGitSource(
    { commitSha: null, entries: {}, sourceKey: "k" },
    [
      { blobHash: "f".repeat(40), path: "a.txt", size: 1 },
      { blobHash: "f".repeat(40), path: "b.txt", size: 1 },
    ],
    NAMESPACE
  );
  assert.equal(
    ops.every((op) => op.kind === "added"),
    true
  );
  assert.equal(ops.length, 2);
  assert.notEqual(ops[0]?.documentId, ops[1]?.documentId);
});

test("fixture repo: first sync ingests selected files with full provenance", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const config = sourceConfig(fixture.repoDir);
  const report = await syncGitSource(repository, store, config);

  assert.equal(report.added, 4);
  assert.equal(report.deleted, 0);
  assert.equal(report.modified, 0);
  assert.equal(report.renamed, 0);
  assert.equal(report.unchanged, 0);
  assert.equal(report.skippedBinary, 1);
  assert.equal(report.skippedEmpty, 1);
  assert.equal(report.scanned, 6);
  assert.equal(report.excluded, 4);
  assert.equal(store.documents.size, 4);

  const commit = git(fixture.repoDir, ["rev-parse", "HEAD"])
    .toString("utf-8")
    .trim();
  assert.equal(report.commitSha, commit);
  const readme = store.documents.get(documentIdFor(NAMESPACE, "README.md"));
  assert.ok(readme);
  assert.equal(readme.source, "git");
  assert.equal(readme.namespace, NAMESPACE);
  assert.equal(readme.externalId, "README.md");
  assert.equal(readme.path, "README.md");
  assert.equal(readme.title, "README.md");
  assert.equal(readme.repositoryUrl, fixture.repoDir);
  assert.equal(readme.ref, "main");
  assert.equal(readme.commitSha, commit);
  assert.equal(
    readme.blobHash,
    git(fixture.repoDir, ["rev-parse", "HEAD:README.md"])
      .toString("utf-8")
      .trim()
  );
  assert.equal(readme.contentHash, sha256Hex(readme.text));
  assert.equal(
    readme.url,
    pathToFileURL(path.join(fixture.repoDir, "README.md")).href
  );
  assert.equal(readme.contentKind, "markdown");
  assert.equal(readme.lineRange.start, 1);
  assert.equal(readme.lineRange.end, 3);
  assert.equal(readme.version, 1);
  assert.equal(readme.firstCommitSha, commit);
  assert.equal(readme.renamedFrom, null);

  const app = store.documents.get(documentIdFor(NAMESPACE, "src/app.ts"));
  assert.ok(app);
  assert.equal(app.contentKind, "code");
  assert.equal(app.language, "ts");
  assert.equal(app.lineRange.end, 1);

  const manifest = store.manifests.get(report.sourceKey);
  assert.ok(manifest);
  assert.equal(manifest.commitSha, commit);
  assert.deepEqual(Object.keys(manifest.entries).toSorted(), [
    "README.md",
    "notes.txt",
    "src/app.ts",
    "src/lib.ts",
  ]);
  assert.equal(
    report.ops.every((op) => op.kind === "added"),
    true
  );
});

test("resync with no changes skips every blob and rewrites nothing", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const config = sourceConfig(fixture.repoDir);
  const first = await syncGitSource(repository, store, config);
  const readmeBefore = store.documents.get(
    documentIdFor(NAMESPACE, "README.md")
  );
  assert.ok(readmeBefore);

  const second = await syncGitSource(repository, store, config);
  assert.equal(second.unchanged, 4);
  // Skipped blobs (empty, binary) are never manifest-tracked, so they
  // re-appear as skipped adds on every sync instead of counting as
  // unchanged.
  assert.equal(second.added, 0);
  assert.equal(second.skippedEmpty, 1);
  assert.equal(second.skippedBinary, 1);
  assert.equal(second.ops.length, 2);
  assert.equal(second.commitSha, first.commitSha);
  assert.equal(
    store.documents.get(documentIdFor(NAMESPACE, "README.md")),
    readmeBefore
  );
  assert.equal(store.tombstones.length, 0);
});

test("fixture repo: add/change/delete/rename across syncs", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const config = sourceConfig(fixture.repoDir);
  const open = (): Promise<GitRepository> =>
    openGitRepository({
      cacheDir: fixture.cacheDir,
      repositoryUrl: fixture.repoDir,
    });
  const firstRepository = await open();
  await syncGitSource(firstRepository, store, config);
  const firstCommit = git(fixture.repoDir, ["rev-parse", "HEAD"])
    .toString("utf-8")
    .trim();
  const originalApp = store.documents.get(
    documentIdFor(NAMESPACE, "src/app.ts")
  );
  assert.ok(originalApp);
  const movedBlob = git(fixture.repoDir, ["rev-parse", "HEAD:src/lib.ts"])
    .toString("utf-8")
    .trim();
  const notesBlob = git(fixture.repoDir, ["rev-parse", "HEAD:notes.txt"])
    .toString("utf-8")
    .trim();

  await writeFixtureFile(
    fixture.repoDir,
    "src/app.ts",
    'export const main = (): string => "hello v2";\n'
  );
  await writeFixtureFile(
    fixture.repoDir,
    "NEW.md",
    "# Fresh\nno trailing newline"
  );
  git(fixture.repoDir, ["rm", "-q", "notes.txt"]);
  git(fixture.repoDir, ["mv", "src/lib.ts", "src/renamed-lib.ts"]);
  const secondCommit = commitAll(fixture.repoDir, "add/change/delete/rename");

  const repository = await open();
  const report = await syncGitSource(repository, store, config);
  assert.equal(report.added, 1);
  assert.equal(report.modified, 1);
  assert.equal(report.renamed, 1);
  assert.equal(report.deleted, 1);
  assert.equal(report.unchanged, 1);
  assert.equal(report.skippedEmpty, 1);
  assert.equal(report.commitSha, secondCommit);

  // Modified file: same document identity, new version, recorded lineage.
  const updatedApp = store.documents.get(
    documentIdFor(NAMESPACE, "src/app.ts")
  );
  assert.ok(updatedApp);
  assert.equal(updatedApp.documentId, originalApp.documentId);
  assert.equal(updatedApp.version, 2);
  assert.equal(updatedApp.commitSha, secondCommit);
  assert.equal(updatedApp.firstCommitSha, firstCommit);
  assert.equal(updatedApp.previousBlobHash, originalApp.blobHash);
  assert.equal(updatedApp.previousContentHash, originalApp.contentHash);
  assert.notEqual(updatedApp.contentHash, originalApp.contentHash);
  assert.equal(updatedApp.text.includes("v2"), true);

  // Renamed file: stale path gone, provenance links old to new.
  const moved = store.documents.get(
    documentIdFor(NAMESPACE, "src/renamed-lib.ts")
  );
  assert.ok(moved);
  assert.equal(moved.renamedFrom, "src/lib.ts");
  assert.equal(moved.blobHash, movedBlob);
  assert.equal(moved.version, 1);
  assert.equal(moved.firstCommitSha, firstCommit);
  assert.equal(
    store.documents.has(documentIdFor(NAMESPACE, "src/lib.ts")),
    false
  );
  const renameTombstone = store.tombstones.find(
    (tombstone) => tombstone.externalId === "src/lib.ts"
  );
  assert.ok(renameTombstone);
  assert.equal(renameTombstone.renamedTo, "src/renamed-lib.ts");
  assert.equal(renameTombstone.tombstoneCommitSha, secondCommit);
  assert.equal(renameTombstone.blobHash, movedBlob);

  // Deleted file: gone from documents and manifest, tombstone explains it.
  assert.equal(
    store.documents.has(documentIdFor(NAMESPACE, "notes.txt")),
    false
  );
  const deleteTombstone = store.tombstones.find(
    (tombstone) => tombstone.externalId === "notes.txt"
  );
  assert.ok(deleteTombstone);
  assert.equal(deleteTombstone.renamedTo, null);
  assert.equal(deleteTombstone.blobHash, notesBlob);
  assert.equal(deleteTombstone.tombstoneCommitSha, secondCommit);

  // Added file with a non-newline-terminated last line.
  const fresh = store.documents.get(documentIdFor(NAMESPACE, "NEW.md"));
  assert.ok(fresh);
  assert.equal(fresh.lineRange.end, 2);

  const manifest = store.manifests.get(report.sourceKey);
  assert.ok(manifest);
  assert.deepEqual(Object.keys(manifest.entries).toSorted(), [
    "NEW.md",
    "README.md",
    "src/app.ts",
    "src/renamed-lib.ts",
  ]);
  assert.equal(manifest.commitSha, secondCommit);

  // Settled state: nothing further to do, tombstones stay historical.
  const tombstoneCount = store.tombstones.length;
  const settledRepository = await open();
  const settled = await syncGitSource(settledRepository, store, config);
  assert.equal(settled.unchanged, 4);
  assert.equal(settled.added, 0);
  assert.equal(settled.ops.length, 2);
  assert.equal(store.tombstones.length, tombstoneCount);
});

test("syncGitRepository drives clone/fetch + sync end to end", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const report = await syncGitRepository(
    store,
    sourceConfig(fixture.repoDir, { cacheDir: fixture.cacheDir })
  );
  assert.equal(report.added, 4);
  assert.equal(store.documents.size, 4);
});

test("include patterns scope a namespace without touching other sources", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const report = await syncGitSource(
    repository,
    store,
    sourceConfig(fixture.repoDir, {
      include: ["src/**"],
      namespace: "src-only",
    })
  );
  assert.equal(report.scanned, 2);
  assert.equal(report.added, 2);
  assert.ok(store.documents.has(documentIdFor("src-only", "src/app.ts")));
  assert.equal(
    store.documents.has(documentIdFor(NAMESPACE, "src/app.ts")),
    false
  );
});

test("secret and binary detection survives applyDefaultExcludes: false", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const report = await syncGitSource(
    repository,
    store,
    sourceConfig(fixture.repoDir, { applyDefaultExcludes: false })
  );
  assert.equal(report.scanned, 10);
  assert.equal(report.added, 6);
  assert.equal(report.skippedBinary, 1);
  assert.equal(report.skippedEmpty, 1);
  assert.equal(report.skippedSecret, 2);
  assert.ok(store.documents.has(documentIdFor(NAMESPACE, "package-lock.json")));
  assert.ok(store.documents.has(documentIdFor(NAMESPACE, "vendor/dep.js")));
  assert.equal(store.documents.has(documentIdFor(NAMESPACE, ".env")), false);
});

test("oversized blobs are skipped as too-large without ingestion", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const store = createInMemoryGitSourceStore();
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const report = await syncGitSource(
    repository,
    store,
    sourceConfig(fixture.repoDir, {
      include: ["notes.txt"],
      maxBlobBytes: 4,
    })
  );
  assert.equal(report.scanned, 1);
  assert.equal(report.skippedTooLarge, 1);
  assert.equal(report.added, 0);
  assert.equal(store.documents.size, 0);
});

test("normalized URLs cover scp syntax and reject garbage", () => {
  assert.equal(
    normalizeRepositoryUrl("git@github.com:owner/repo.git"),
    "ssh://git@github.com/owner/repo.git"
  );
  assert.equal(normalizeRepositoryUrl("/srv/git/repo"), "/srv/git/repo");
  assert.equal(
    normalizeRepositoryUrl("https://github.com/owner/repo.git"),
    "https://github.com/owner/repo.git"
  );
  assert.throws(() => normalizeRepositoryUrl(""), /repositoryUrl/u);
  assert.throws(
    () => normalizeRepositoryUrl("ftp://example.com/repo"),
    /protocol/u
  );
  assert.throws(
    () => normalizeRepositoryUrl("relative/path"),
    /repositoryUrl/u
  );
});

test("empty and missing refs fail loudly", async (t) => {
  const fixture = await createFixtureRepository();
  t.after(fixture.cleanup);
  const repository = await openGitRepository({
    cacheDir: fixture.cacheDir,
    repositoryUrl: fixture.repoDir,
  });
  const commit = await repository.resolveCommit("main");
  assert.match(commit, /^[0-9a-f]{40}$/u);
  await assert.rejects(
    () => repository.resolveCommit("no-such-branch"),
    /not found/u
  );
  const blobs = await repository.listBlobs(commit);
  assert.ok(blobs.length >= 6);
  const readme = blobs.find((entry) => entry.path === "README.md");
  assert.ok(readme);
  assert.equal(typeof readme.size, "number");
  const blob = await repository.readBlob(readme.blobHash);
  assert.equal(
    Buffer.from(blob).toString("utf-8").startsWith("# Fixture repo"),
    true
  );
});
