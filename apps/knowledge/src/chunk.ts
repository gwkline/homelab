/**
 * Deterministic, citation-preserving chunking: boundaries are a pure function
 * of `(content, format, maxChars)`, so reprocessing yields identical chunks
 * and ids. `text === content.slice(startOffset, endOffset)` always holds.
 *
 * Markdown chunks never straddle a heading and keep fenced code whole; they
 * cite the heading path plus character offsets. Code chunks never split a
 * line and cite a 1-based `L<first>-L<last>` range. Blank chunks are dropped
 * before ids are assigned, so `idx` stays gapless.
 */

import { createHash } from "node:crypto";

import type { CitationAnchor } from "./pgvector.ts";

/** Bump on any boundary-, text-, or id-affecting change to this module. */
export const CHUNKER_VERSION = "chunk-v1";

/** Soft cap in characters (~300 tokens). */
export const DEFAULT_MAX_CHARS = 1200;

export type ChunkFormat = "markdown" | "code" | "text";

const CHUNK_FORMATS: ReadonlySet<string> = new Set([
  "markdown",
  "code",
  "text",
]);

const NAMESPACE_PATTERN = /^[\w.-]{1,128}$/u;

export interface NormalizedDocumentVersion {
  content: string;
  documentId: string;
  /** Defaults to `"text"`. */
  format?: ChunkFormat;
  namespace: string;
  versionId: string;
}

export interface ChunkerOptions {
  /** Overrides `doc.format` when both are given. */
  format?: ChunkFormat;
  maxChars?: number;
}

/** Lines are 1-based inclusive; offsets are 0-based, end-exclusive. */
export interface PreparedChunk {
  anchors: CitationAnchor[];
  chunkId: string;
  chunkerVersion: string;
  contentHash: string;
  documentId: string;
  endLine: number;
  endOffset: number;
  idx: number;
  namespace: string;
  startLine: number;
  startOffset: number;
  text: string;
  versionId: string;
}

interface Segment {
  end: number;
  headingPath: string;
  /** `line` = one source-code line; `fence` = a whole markdown code fence. */
  kind: "fence" | "heading" | "line" | "prose";
  start: number;
}

interface Line {
  end: number;
  start: number;
  text: string;
}

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf-8").digest("hex");

export interface ChunkIdentity {
  chunkerVersion?: string;
  contentHash: string;
  documentId: string;
  idx: number;
}

/**
 * Mixes document, chunker version, position, and content hash, so any content
 * or chunker change derives a new id instead of mutating a chunk in place.
 */
export const deriveChunkId = (identity: ChunkIdentity): string => {
  const version = identity.chunkerVersion ?? CHUNKER_VERSION;
  const digest = createHash("sha256")
    .update(
      `${identity.documentId}\u0000${version}\u0000${identity.idx}\u0000${identity.contentHash}`,
      "utf-8"
    )
    .digest("hex");
  return `k_${digest.slice(0, 32)}`;
};

const scanLines = (content: string): Line[] => {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    lines.push({ end, start, text: content.slice(start, end) });
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
  return lines;
};

const ATX_HEADING = /^ {0,3}(?<hashes>#{1,6})[ \t]+(?<text>.*?)[ \t]*$/u;
const TRAILING_HASHES = /[ \t]+#+[ \t]*$/u;
const FENCE_LINE = /^ {0,3}(?<marker>`{3,}|~{3,})/u;
const FENCE_CLOSE = /^ {0,3}(?<marker>`{3,}|~{3,})[ \t]*$/u;

const headingOf = (line: string): { level: number; text: string } | null => {
  const match = ATX_HEADING.exec(line);
  if (match === null) {
    return null;
  }
  const text = (match.groups?.text ?? "").replace(TRAILING_HASHES, "").trim();
  if (text.length === 0) {
    return null;
  }
  return { level: (match.groups?.hashes ?? "").length, text };
};

const isBlank = (line: string): boolean => line.trim().length === 0;

/** An unclosed fence runs to EOF as one atomic segment. */
const segmentMarkdown = (content: string, lines: Line[]): Segment[] => {
  const segments: Segment[] = [];
  const headings: string[] = [];
  const headingPath = (): string =>
    headings.filter((heading) => heading !== "").join(" > ");
  let paragraph: Segment | null = null;
  let fence: { char: string; start: number } | null = null;
  const flush = (): void => {
    if (paragraph !== null) {
      segments.push(paragraph);
      paragraph = null;
    }
  };
  for (const line of lines) {
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line.text);
      if (close !== null && close.groups?.marker?.[0] === fence.char) {
        segments.push({
          end: line.end,
          headingPath: headingPath(),
          kind: "fence",
          start: fence.start,
        });
        fence = null;
      }
      continue;
    }
    const heading = headingOf(line.text);
    if (heading !== null) {
      flush();
      headings.length = heading.level - 1;
      headings[heading.level - 1] = heading.text;
      segments.push({
        end: line.end,
        headingPath: headingPath(),
        kind: "heading",
        start: line.start,
      });
      continue;
    }
    const open = FENCE_LINE.exec(line.text);
    if (open !== null) {
      flush();
      fence = { char: open.groups?.marker?.[0] ?? "`", start: line.start };
      continue;
    }
    if (isBlank(line.text)) {
      flush();
      continue;
    }
    if (paragraph === null) {
      paragraph = {
        end: line.end,
        headingPath: headingPath(),
        kind: "prose",
        start: line.start,
      };
    } else {
      paragraph.end = line.end;
    }
  }
  flush();
  if (fence !== null) {
    segments.push({
      end: content.length,
      headingPath: headingPath(),
      kind: "fence",
      start: fence.start,
    });
  }
  return segments;
};

const segmentText = (lines: Line[]): Segment[] => {
  const segments: Segment[] = [];
  let paragraph: Segment | null = null;
  const flush = (): void => {
    if (paragraph !== null) {
      segments.push(paragraph);
      paragraph = null;
    }
  };
  for (const line of lines) {
    if (isBlank(line.text)) {
      flush();
      continue;
    }
    if (paragraph === null) {
      paragraph = {
        end: line.end,
        headingPath: "",
        kind: "prose",
        start: line.start,
      };
    } else {
      paragraph.end = line.end;
    }
  }
  flush();
  return segments;
};

const sentenceBreakBefore = (
  content: string,
  start: number,
  end: number
): number => {
  for (let index = end - 1; index > start; index -= 1) {
    const char = content[index];
    const next = content[index + 1] ?? "";
    if ((char === "." || char === "!" || char === "?") && /\s/u.test(next)) {
      return index + 1;
    }
  }
  return -1;
};

/** Prefers line breaks, then sentence breaks (prose only), then a hard cut. */
const splitOversized = (
  content: string,
  segment: Segment,
  maxChars: number
): Segment[] => {
  const pieces: Segment[] = [];
  let { start } = segment;
  for (;;) {
    const windowEnd = Math.min(start + maxChars, segment.end);
    if (windowEnd >= segment.end) {
      pieces.push({ ...segment, start });
      break;
    }
    const newline = content.lastIndexOf("\n", windowEnd - 1);
    let cut = newline > start ? newline : -1;
    if (cut === -1 && segment.kind === "prose") {
      cut = sentenceBreakBefore(content, start, windowEnd);
    }
    if (cut <= start) {
      cut = windowEnd;
    }
    pieces.push({
      end: cut,
      headingPath: segment.headingPath,
      kind: segment.kind,
      start,
    });
    start = content[cut] === "\n" ? cut + 1 : cut;
  }
  return pieces;
};

/** A heading opens a new chunk and a fence always stands alone. */
const assembleChunks = (segments: Segment[], maxChars: number): Segment[] => {
  const chunks: Segment[] = [];
  let current: Segment | null = null;
  const flush = (): void => {
    if (current !== null) {
      chunks.push(current);
      current = null;
    }
  };
  for (const segment of segments) {
    const opensNewChunk =
      segment.kind === "heading" || segment.kind === "fence";
    if (opensNewChunk && current !== null) {
      flush();
    }
    if (current === null) {
      current = { ...segment };
    } else if (segment.end - current.start > maxChars) {
      flush();
      current = { ...segment };
    } else {
      current.end = segment.end;
    }
    if (segment.kind === "fence") {
      flush();
    }
  }
  flush();
  return chunks;
};

const isSpaceChar = (char: string | undefined): boolean =>
  char !== undefined && /[ \t\r\n]/u.test(char);

const lineAtOffset = (lineStarts: number[], offset: number): number => {
  let low = 0;
  let high = lineStarts.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if ((lineStarts[mid] ?? 0) <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found + 1;
};

const validatedFormat = (
  doc: NormalizedDocumentVersion,
  options: ChunkerOptions
): ChunkFormat => {
  const format = options.format ?? doc.format ?? "text";
  if (!CHUNK_FORMATS.has(format)) {
    throw new TypeError(`chunk: unknown format ${JSON.stringify(format)}`);
  }
  return format;
};

const validatedMaxChars = (maxChars: number | undefined): number => {
  const value = maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `chunk: maxChars must be an integer >= 1, got ${String(maxChars)}`
    );
  }
  return value;
};

export const chunkDocumentVersion = (
  doc: NormalizedDocumentVersion,
  options: ChunkerOptions = {}
): PreparedChunk[] => {
  if (typeof doc.documentId !== "string" || doc.documentId.length === 0) {
    throw new TypeError("chunk: documentId must be a non-empty string");
  }
  if (typeof doc.versionId !== "string" || doc.versionId.length === 0) {
    throw new TypeError("chunk: versionId must be a non-empty string");
  }
  if (
    typeof doc.namespace !== "string" ||
    !NAMESPACE_PATTERN.test(doc.namespace)
  ) {
    throw new TypeError(
      `chunk: invalid namespace ${JSON.stringify(doc.namespace)}`
    );
  }
  if (typeof doc.content !== "string") {
    throw new TypeError("chunk: content must be a string");
  }
  const format = validatedFormat(doc, options);
  const maxChars = validatedMaxChars(options.maxChars);
  const { content } = doc;
  const lines = scanLines(content);
  const lineStarts = lines.map((line) => line.start);

  let segments: Segment[];
  if (format === "code") {
    segments = lines.map((line) => ({
      end: line.end,
      headingPath: "",
      kind: "line" as const,
      start: line.start,
    }));
  } else {
    const raw =
      format === "markdown"
        ? segmentMarkdown(content, lines)
        : segmentText(lines);
    segments = raw.flatMap((segment) =>
      segment.end - segment.start > maxChars
        ? splitOversized(content, segment, maxChars)
        : [segment]
    );
  }

  return assembleChunks(segments, maxChars)
    .map((raw) => {
      let { end, start } = raw;
      while (start < end && isSpaceChar(content[start])) {
        start += 1;
      }
      while (end > start && isSpaceChar(content[end - 1])) {
        end -= 1;
      }
      const text = content.slice(start, end);
      const startLine = lineAtOffset(lineStarts, start);
      const endLine = lineAtOffset(lineStarts, Math.max(start, end - 1));
      const anchors: CitationAnchor[] = [];
      if (format === "code") {
        anchors.push({
          end: endLine,
          start: startLine,
          type: "offset",
          value: `L${startLine}-L${endLine}`,
        });
      } else {
        if (raw.headingPath !== "") {
          anchors.push({ type: "heading", value: raw.headingPath });
        }
        anchors.push({ end, start, type: "offset" });
      }
      return {
        anchors,
        contentHash: sha256Hex(text),
        endLine,
        endOffset: end,
        startLine,
        startOffset: start,
        text,
      };
    })
    .filter((chunk) => chunk.text.length > 0)
    .map((chunk, idx) => ({
      ...chunk,
      anchors: chunk.anchors,
      chunkId: deriveChunkId({
        contentHash: chunk.contentHash,
        documentId: doc.documentId,
        idx,
      }),
      chunkerVersion: CHUNKER_VERSION,
      documentId: doc.documentId,
      idx,
      namespace: doc.namespace,
      versionId: doc.versionId,
    }));
};
