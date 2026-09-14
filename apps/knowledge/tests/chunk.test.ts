import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chunkDocumentVersion,
  CHUNKER_VERSION,
  DEFAULT_MAX_CHARS,
  deriveChunkId,
  sha256Hex,
} from "../src/chunk.ts";
import type { NormalizedDocumentVersion } from "../src/chunk.ts";
import { parseAnchors } from "../src/pgvector.ts";

const doc = (
  overrides: Partial<NormalizedDocumentVersion> = {}
): NormalizedDocumentVersion => ({
  content: "para one\n\npara two",
  documentId: "doc-1",
  namespace: "homelab-docs",
  versionId: "v1",
  ...overrides,
});

const MARKDOWN_DOC = `# Install

First paragraph with enough words to stand alone as a chunk.

## Prerequisites

- item one
- item two

\`\`\`bash
export FOO=1
## not a heading inside a fence
\`\`\`

Closing paragraph in the prerequisites section.

## Next steps

Run the installer and verify the cluster is healthy afterwards.`;

// --- determinism + identity (#57 acceptance: deterministic boundaries, idempotent ids) ---

test("chunking is deterministic: same content, same chunks, byte for byte", () => {
  const first = chunkDocumentVersion(
    doc({ content: MARKDOWN_DOC, format: "markdown" })
  );
  const second = chunkDocumentVersion(
    doc({ content: MARKDOWN_DOC, format: "markdown" })
  );
  assert.deepEqual(second, first);
  assert.ok(first.length > 1, "fixture must produce multiple chunks");
});

test("chunk ids mix document, chunker version, position, and content hash", () => {
  const base = {
    contentHash: sha256Hex("same text"),
    documentId: "doc-1",
    idx: 0,
  };
  const id = deriveChunkId(base);
  assert.match(id, /^k_[0-9a-f]{32}$/u);
  assert.equal(deriveChunkId({ ...base, chunkerVersion: CHUNKER_VERSION }), id);
  assert.notEqual(deriveChunkId({ ...base, documentId: "doc-2" }), id);
  assert.notEqual(deriveChunkId({ ...base, idx: 1 }), id);
  assert.notEqual(
    deriveChunkId({ ...base, contentHash: sha256Hex("other") }),
    id
  );
  assert.notEqual(deriveChunkId({ ...base, chunkerVersion: "chunk-v2" }), id);
});

test("reprocessing an unchanged version re-derives identical chunk ids", () => {
  const input = doc({ content: MARKDOWN_DOC, format: "markdown" });
  const first = chunkDocumentVersion(input);
  const second = chunkDocumentVersion(
    doc({ content: MARKDOWN_DOC, format: "markdown" })
  );
  assert.deepEqual(
    second.map((chunk) => chunk.chunkId),
    first.map((chunk) => chunk.chunkId)
  );
});

test("every chunk text is an exact content slice at its offsets", () => {
  for (const format of ["markdown", "text", "code"] as const) {
    const content =
      format === "code" ? "a b c\nlonger line two\n\nx" : MARKDOWN_DOC;
    const chunks = chunkDocumentVersion(doc({ content, format }), {
      maxChars: 40,
    });
    assert.ok(chunks.length > 0);
    for (const chunk of chunks) {
      assert.equal(
        chunk.text,
        content.slice(chunk.startOffset, chunk.endOffset)
      );
      assert.ok(chunk.startOffset < chunk.endOffset);
      assert.ok(chunk.text.trim().length > 0);
    }
  }
});

// --- citation anchors (#57 acceptance: headings, fences, code line ranges) ---

test("markdown chunks cite their heading chain and char offsets", () => {
  const chunks = chunkDocumentVersion(
    doc({ content: MARKDOWN_DOC, format: "markdown" })
  );
  const paths = chunks.map(
    (chunk) =>
      chunk.anchors.find((anchor) => anchor.type === "heading")?.value ?? null
  );
  assert.deepEqual(paths, [
    "Install",
    "Install > Prerequisites",
    "Install > Prerequisites",
    "Install > Prerequisites",
    "Install > Next steps",
  ]);
  for (const chunk of chunks) {
    const offset = chunk.anchors.find((anchor) => anchor.type === "offset");
    assert.ok(offset, "every markdown chunk carries an offset anchor");
    assert.equal(offset?.start, chunk.startOffset);
    assert.equal(offset?.end, chunk.endOffset);
  }
});

test("fenced code stays whole and its headings stay code", () => {
  const content =
    '# Section\n\nIntro sentence.\n\n```bash\nfor i in 1 2 3\ndo echo "$i"\ndone\n```\n\nAfter.\n';
  const chunks = chunkDocumentVersion(doc({ content, format: "markdown" }));
  const fenced = chunks.find((chunk) => chunk.text.includes("do echo"));
  assert.ok(fenced, "fence must be chunked");
  assert.ok(
    fenced.text.startsWith("```bash") && fenced.text.trimEnd().endsWith("```"),
    `fence must stay atomic: ${JSON.stringify(fenced.text)}`
  );
  // The `for` heading-like lines inside the fence never split it.
  assert.equal(
    fenced.anchors.find((anchor) => anchor.type === "heading")?.value,
    "Section"
  );
});

test("anchors survive the retrieval-side #56 round trip", () => {
  const chunks = chunkDocumentVersion(
    doc({ content: MARKDOWN_DOC, format: "markdown" })
  );
  for (const chunk of chunks) {
    assert.deepEqual(parseAnchors(chunk.anchors, "test"), chunk.anchors);
  }
  const codeChunks = chunkDocumentVersion(
    doc({ content: "a\nb\nc\nd\n", format: "code" })
  );
  for (const chunk of codeChunks) {
    assert.deepEqual(parseAnchors(chunk.anchors, "test"), chunk.anchors);
  }
});

test("code chunks cite 1-based line ranges and never split a line", () => {
  const lines = Array.from(
    { length: 9 },
    (_, i) => `line ${i + 1} content`
  ).join("\n");
  const chunks = chunkDocumentVersion(doc({ content: lines, format: "code" }), {
    maxChars: 30,
  });
  let expectedLine = 1;
  for (const chunk of chunks) {
    const [anchor] = chunk.anchors;
    assert.equal(anchor?.type, "offset");
    assert.equal(anchor?.start, expectedLine, "line ranges must be contiguous");
    assert.equal(anchor?.value, `L${anchor?.start}-L${anchor?.end}`);
    const textLines = chunk.text.split("\n");
    assert.equal(anchor?.end, expectedLine + textLines.length - 1);
    assert.equal(chunk.startLine, expectedLine);
    assert.equal(chunk.endLine, anchor?.end);
    expectedLine = (anchor?.end ?? 0) + 1;
  }
  assert.equal(
    expectedLine,
    10,
    "line ranges must cover the file exactly once"
  );
});

test("oversized prose splits at line or sentence boundaries, deterministically", () => {
  const sentences = Array.from(
    { length: 12 },
    (_, i) => `Sentence number ${i + 1} ends here.`
  ).join(" ");
  const pieces = chunkDocumentVersion(doc({ content: sentences }), {
    maxChars: 60,
  });
  assert.ok(pieces.length > 2);
  for (const piece of pieces) {
    assert.ok(
      piece.text.length <= 60 || piece.text.length === sentences.length,
      "only an unbreakable remainder may exceed maxChars"
    );
  }
  const again = chunkDocumentVersion(doc({ content: sentences }), {
    maxChars: 60,
  });
  assert.deepEqual(again, pieces);
  // No content lost: rejoining the pieces reproduces the sentence stream.
  const rejoined = pieces.map((piece) => piece.text).join(" ");
  assert.equal(rejoined.split(/\s+/u).join(" "), sentences);
});

// --- format handling + validation ---

test("text format chunks paragraphs without heading anchors", () => {
  const chunks = chunkDocumentVersion(
    doc({ content: "alpha\n\nbeta", format: "text" })
  );
  // Small paragraphs merge up to maxChars; no heading structure exists.
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.text, "alpha\n\nbeta");
  assert.deepEqual(
    chunks.flatMap((chunk) =>
      chunk.anchors.filter((anchor) => anchor.type === "heading")
    ),
    []
  );
});

test("empty and whitespace-only content produce no chunks", () => {
  assert.deepEqual(chunkDocumentVersion(doc({ content: "" })), []);
  assert.deepEqual(chunkDocumentVersion(doc({ content: "  \n\t\n " })), []);
});

test("invalid documents and options fail loudly before chunking", () => {
  assert.throws(
    () => chunkDocumentVersion(doc({ documentId: "" })),
    /documentId/u
  );
  assert.throws(
    () => chunkDocumentVersion(doc({ versionId: "" })),
    /versionId/u
  );
  assert.throws(
    () => chunkDocumentVersion(doc({ namespace: "bad namespace!" })),
    /namespace/u
  );
  assert.throws(
    () =>
      chunkDocumentVersion(doc({ content: undefined as unknown as string })),
    /content/u
  );
  assert.throws(
    () => chunkDocumentVersion(doc(), { format: "yaml" as never }),
    /format/u
  );
  assert.throws(
    () => chunkDocumentVersion(doc(), { maxChars: 0 }),
    /maxChars/u
  );
  assert.throws(
    () => chunkDocumentVersion(doc(), { maxChars: 1.5 }),
    /maxChars/u
  );
});

test("default chunker settings: text format, 1200-char cap", () => {
  const content = `${"x".repeat(DEFAULT_MAX_CHARS + 1)}`;
  const chunks = chunkDocumentVersion(doc({ content }));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.text.length, DEFAULT_MAX_CHARS);
  for (const chunk of chunks) {
    assert.equal(chunk.chunkerVersion, CHUNKER_VERSION);
  }
});
