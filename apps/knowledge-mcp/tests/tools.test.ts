import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { KnowledgeClient } from "../client.ts";
import {
  GetSourceToolInputSchema,
  QUERY_MAX_LENGTH,
  SearchResponseSchema,
  SearchToolInputSchema,
  SOURCE_ID_PATTERN,
  TOP_K_MAX,
} from "../contract.ts";

// A representative upstream search payload — the retrieval service's
// contract shape. Passthrough fields the adapter does not model must
// survive validation.
const searchPayload = {
  results: [
    {
      chunk_id: "chunk-1",
      citation: {
        citation_anchor: "Install > Prerequisites",
        document_id: "doc-1",
        namespace: "default",
        path: "docs/runbook.md",
        source_id: "homelab-docs",
        title: "Runbook",
        url: "https://github.com/gwkline/homelab/blob/abc/docs/runbook.md",
        version: { commit: "abc123", created_at: "2026-10-01T00:00:00Z" },
      },
      score: { bm25_rank: 1, fused: 0.032, vector_rank: 1 },
      text: "Restart the postgres primary.",
      upstream_extra: { kept: true },
    },
  ],
};

const sourceDetail = {
  citation_anchor: "Install > Prerequisites",
  document_id: "doc-1",
  namespace: "default",
  source_id: "homelab-docs",
  title: "Runbook",
  url: "https://github.com/gwkline/homelab/blob/abc/docs/runbook.md",
  version: { commit: "abc123", created_at: "2026-10-01T00:00:00Z" },
};

test("tool input schemas pin the documented limits", () => {
  assert.ok(
    SearchToolInputSchema.safeParse({ query: "restart postgres" }).success
  );
  assert.ok(!SearchToolInputSchema.safeParse({ query: "" }).success);
  assert.ok(
    !SearchToolInputSchema.safeParse({
      query: "x".repeat(QUERY_MAX_LENGTH + 1),
    }).success
  );
  assert.ok(
    !SearchToolInputSchema.safeParse({ query: "x", top_k: TOP_K_MAX + 1 })
      .success
  );
  assert.ok(SearchToolInputSchema.safeParse({ query: "x", top_k: 1 }).success);
  assert.ok(
    !SearchToolInputSchema.safeParse({ mode: "graph", query: "x" }).success
  );
  assert.ok(
    GetSourceToolInputSchema.safeParse({ source_id: "homelab-docs" }).success
  );
  assert.ok(
    !GetSourceToolInputSchema.safeParse({ source_id: "bad source id" }).success
  );
  assert.match("homelab-docs", SOURCE_ID_PATTERN);
});

test("response contracts pass through unknown provenance fields", () => {
  const parsed = SearchResponseSchema.safeParse(searchPayload);
  assert.ok(parsed.success);
  const hit = (parsed.data?.results ?? [])[0] as
    | (typeof parsed.data.results)[number]
    | undefined;
  assert.equal(hit?.citation.source_id, "homelab-docs");
  assert.equal(hit?.score.fused, 0.032);
  assert.deepEqual(
    (hit as unknown as { upstream_extra?: unknown }).upstream_extra,
    { kept: true },
    "passthrough keeps fields the adapter does not model"
  );
});

test("both tools register and round-trip against a stubbed API", async () => {
  const calls: { body: unknown; path: string }[] = [];
  const fetchImpl: typeof fetch = (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ body: init?.body, path });
    if (path === "/v1/search") {
      return Promise.resolve(Response.json(searchPayload, { status: 200 }));
    }
    if (path === "/v1/sources/homelab-docs") {
      return Promise.resolve(Response.json(sourceDetail, { status: 200 }));
    }
    return Promise.resolve(Response.json({ error: "nope" }, { status: 404 }));
  };
  const { createKnowledgeMcpServer } = await import("../server.ts");
  const client = new KnowledgeClient({
    baseUrl: "http://knowledge.test",
    fetchImpl,
    timeoutMs: 2000,
    token: "mcp-test-token",
  });
  const server = createKnowledgeMcpServer(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    const tools = await mcpClient.listTools();
    assert.deepEqual((tools.tools ?? []).map((t) => t.name).toSorted(), [
      "get_source",
      "search_knowledge",
    ]);

    const search = (await mcpClient.callTool({
      arguments: { query: "restart postgres", top_k: 3 },
      name: "search_knowledge",
    })) as { content: { text: string; type: string }[] };
    const payload = JSON.parse(search.content?.[0]?.text ?? "{}");
    assert.equal(payload.results[0].citation.source_id, "homelab-docs");
    const sentBody = JSON.parse(String(calls[0]?.body ?? "{}"));
    assert.equal(sentBody.query, "restart postgres");
    assert.equal(sentBody.top_k, 3, "top_k is forwarded, not defaulted");

    const source = (await mcpClient.callTool({
      arguments: { source_id: "homelab-docs" },
      name: "get_source",
    })) as { content: { text: string; type: string }[] };
    const detail = JSON.parse(source.content?.[0]?.text ?? "{}");
    assert.equal(detail.source_id, "homelab-docs");
    assert.equal(calls[1]?.path, "/v1/sources/homelab-docs");
  } finally {
    await mcpClient.close();
    await server.close();
  }
});

const fetchUnavailable: typeof fetch = () =>
  Promise.resolve(Response.json({ error: "nope" }, { status: 503 }));

test("tool errors return isError payloads, never thrown exceptions", async () => {
  const { createKnowledgeMcpServer } = await import("../server.ts");
  const client = new KnowledgeClient({
    baseUrl: "http://knowledge.test",
    fetchImpl: fetchUnavailable,
    timeoutMs: 2000,
    token: "mcp-test-token",
  });
  const server = createKnowledgeMcpServer(client);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    const result = (await mcpClient.callTool({
      arguments: { query: "restart postgres" },
      name: "search_knowledge",
    })) as { content: { text: string }[]; isError?: boolean };
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? "", /knowledge API/u);
  } finally {
    await mcpClient.close();
    await server.close();
  }
});
