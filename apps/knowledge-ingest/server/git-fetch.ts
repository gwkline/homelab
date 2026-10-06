/**
 * Single-blob git fetch for `document` jobs with `github` sources: resolve
 * the ref, find the path in the commit's tree, read the blob, and gate it
 * through the same assessBlob filter sync uses (empty/too-large/secret/
 * binary refuse loudly instead of ingesting garbage). Reuses the git-source
 * clone cache (`openGitRepository`), so a source that also runs syncs shares
 * one clone. Read-only: clone/fetch, never push; tokens ride via
 * `GIT_SOURCE_TOKEN`(_FILE) env exactly as in git-source.
 */

import type { ChunkFormat } from "../../knowledge/src/chunk.ts";
import {
  classifyContent,
  DEFAULT_MAX_BLOB_BYTES,
  assessBlob,
  documentIdFor,
  openGitRepository,
} from "../../knowledge/src/git-source.ts";

export interface GitHubBlobRequest {
  /** Blob size cap; defaults to git-source's 1 MiB. */
  maxBlobBytes?: number;
  /** Knowledge namespace the document belongs to (for the document id). */
  namespace: string;
  /** Repo-relative POSIX path to read. */
  path: string;
  /** Branch/tag/commit-ish to read at. */
  ref: string;
  /** `owner/name` when `repositoryUrl` is absent. */
  repo: string | null;
  /** Repository URL (https, ssh, or local path). */
  repositoryUrl: string | null;
}

export interface GitHubBlob {
  /** The commit actually read (pinned provenance for the fetched text). */
  commitSha: string;
  /** Deterministic #56 document id for (namespace, path). */
  documentId: string;
  /** Chunker format for the path (extension → markdown/code/text). */
  format: ChunkFormat;
  /** Decoded UTF-8 text of the blob. */
  text: string;
}

const normalizeUrl = (request: {
  repo: string | null;
  repositoryUrl: string | null;
}): string => {
  if (request.repositoryUrl !== null && request.repositoryUrl.trim() !== "") {
    return request.repositoryUrl;
  }
  if (request.repo !== null && request.repo.trim() !== "") {
    return `https://github.com/${request.repo.trim()}`;
  }
  throw new Error(
    "git-fetch: no repository URL (source.url or source.repo required)"
  );
};

/** Read one path at one ref. Throws with a short reason on every bad path. */
export const readGitHubBlob = async (
  request: GitHubBlobRequest
): Promise<GitHubBlob> => {
  const repositoryUrl = normalizeUrl(request);
  const repository = await openGitRepository({ repositoryUrl });
  const commitSha = await repository.resolveCommit(request.ref);
  const tree = await repository.listBlobs(commitSha);
  const entry = tree.find((candidate) => candidate.path === request.path);
  if (entry === undefined) {
    throw new Error(
      `git-fetch: path ${JSON.stringify(request.path)} not found at ${request.ref}`
    );
  }
  const maxBlobBytes = request.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const assessment = assessBlob(
    request.path,
    await repository.readBlob(entry.blobHash),
    maxBlobBytes
  );
  if (assessment.kind !== "text") {
    throw new Error(
      `git-fetch: ${request.path} is not ingestable text (${assessment.kind})`
    );
  }
  return {
    commitSha,
    documentId: documentIdFor(request.namespace, request.path),
    format: classifyContent(request.path).contentKind,
    text: assessment.text,
  };
};
