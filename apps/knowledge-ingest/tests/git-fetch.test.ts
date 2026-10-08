import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { documentIdFor } from "../../knowledge/src/git-source.ts";
import { readGitHubBlob } from "../server/git-fetch.ts";

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });

const fixtureRepo = async (): Promise<{
  cleanup: () => Promise<void>;
  repoDir: string;
}> => {
  const root = await mkdtemp(path.join(tmpdir(), "git-fetch-test-"));
  const repoDir = path.join(root, "repo");
  await mkdir(path.join(repoDir, "docs"), { recursive: true });
  git(repoDir, ["init", "-q", "-b", "main"]);
  await writeFile(
    path.join(repoDir, "docs/runbook.md"),
    "# Runbook\n\nRestart.\n"
  );
  await writeFile(path.join(repoDir, "docs/big.txt"), "x".repeat(4096));
  await writeFile(
    path.join(repoDir, "docs/logo.png"),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
  );
  git(repoDir, ["add", "-A"]);
  git(repoDir, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  return {
    cleanup: () => rm(root, { force: true, recursive: true }),
    repoDir,
  };
};

const request = (repoDir: string, filePath: string, maxBlobBytes?: number) => ({
  ...(maxBlobBytes === undefined ? {} : { maxBlobBytes }),
  namespace: "homelab-docs",
  path: filePath,
  ref: "main",
  repo: null,
  repositoryUrl: repoDir,
});

test("a document job reads exactly its one path at the ref", async (t) => {
  const fixture = await fixtureRepo();
  t.after(fixture.cleanup);
  const blob = await readGitHubBlob(
    request(fixture.repoDir, "docs/runbook.md")
  );
  assert.equal(blob.text, "# Runbook\n\nRestart.\n");
  assert.equal(blob.format, "markdown");
  assert.equal(
    blob.documentId,
    documentIdFor("homelab-docs", "docs/runbook.md")
  );
  assert.equal(
    blob.commitSha,
    git(fixture.repoDir, ["rev-parse", "HEAD"]).trim()
  );
});

test("missing, binary, and oversized paths fail loudly", async (t) => {
  const fixture = await fixtureRepo();
  t.after(fixture.cleanup);
  await assert.rejects(
    readGitHubBlob(request(fixture.repoDir, "docs/missing.md")),
    /not found at main/u
  );
  await assert.rejects(
    readGitHubBlob(request(fixture.repoDir, "docs/logo.png")),
    /not ingestable text \(binary\)/u
  );
  await assert.rejects(
    readGitHubBlob(request(fixture.repoDir, "docs/big.txt", 1024)),
    /not ingestable text \(too-large\)/u
  );
  await assert.rejects(
    readGitHubBlob(request(fixture.repoDir, "docs/*.md")),
    /not found/u,
    "paths are literal, not globs"
  );
});
