// MCP stdio adapter over the knowledge retrieval HTTP API (#64). Exposes two
// read-only tools — search_knowledge and get_source — so T3 Code, Hermes, and
// coding Jobs can consume the same cited knowledge service. This adapter has
// no ranking logic of its own: it forwards validated inputs and passes the
// upstream response through unchanged. Write tools (remember) are
// deliberately out of scope until write semantics, trust, and dedup are
// designed (#67).
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { KnowledgeApiError, KnowledgeClient } from "./client.js";
import {
  QUERY_MAX_LENGTH,
  SearchToolInput,
  GetSourceToolInput,
  TOP_K_DEFAULT,
  TOP_K_MAX,
} from "./contract.js";

const TIMEOUT_DEFAULT_MS = 10_000;
const TIMEOUT_MAX_MS = 120_000;

const log = (message: string): void => {
  console.error(`[knowledge-mcp] ${message}`);
};

const fail = (message: string): never => {
  log(message);
  process.exit(1);
};

// Credentials are injected at runtime: env first, then the secret file mount
// used across this repo (cf. apps/panel). They are only attached to the
// outbound Authorization header — never logged and never returned in tool
// results.
const readToken = (): string => {
  const direct = process.env.KNOWLEDGE_API_TOKEN ?? "";
  if (direct.trim()) {
    return direct.trim();
  }
  for (const path of ["/secrets/token", "/secrets/knowledge-token"]) {
    try {
      const value = readFileSync(path, "utf-8").trim();
      if (value) {
        return value;
      }
    } catch {
      // path not mounted — try the next one
    }
  }
  return fail(
    "no knowledge API token: set KNOWLEDGE_API_TOKEN or mount a secret at /secrets/token"
  );
};

const readBaseUrl = (): string => {
  const trimmed = (process.env.KNOWLEDGE_API_BASE ?? "").trim();
  const base = trimmed.replace(/\/+$/u, "");
  if (!base) {
    return fail(
      "KNOWLEDGE_API_BASE is required (e.g. https://knowledge.{tailnet})"
    );
  }
  if (!/^https?:\/\//u.test(base)) {
    return fail("KNOWLEDGE_API_BASE must start with http:// or https://");
  }
  return base;
};

const readTimeoutMs = (): number => {
  const raw = process.env.KNOWLEDGE_API_TIMEOUT_MS;
  if (!raw) {
    return TIMEOUT_DEFAULT_MS;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    return fail(
      `KNOWLEDGE_API_TIMEOUT_MS must be a positive integer, got "${raw}"`
    );
  }
  if (value > TIMEOUT_MAX_MS) {
    log(`clamping KNOWLEDGE_API_TIMEOUT_MS ${value} to ${TIMEOUT_MAX_MS}`);
    return TIMEOUT_MAX_MS;
  }
  return value;
};

const toolError = (err: unknown): {
  isError: true;
  content: { type: "text"; text: string }[];
} => {
  const text =
    err instanceof KnowledgeApiError
      ? err.message
      : `knowledge tool failed: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text", text }] };
};

const run = async (): Promise<void> => {
  const client = new KnowledgeClient({
    baseUrl: readBaseUrl(),
    token: readToken(),
    timeoutMs: readTimeoutMs(),
  });

  const server = new McpServer({ name: "knowledge-mcp", version: "0.1.0" });

  server.registerTool(
    "search_knowledge",
    {
      title: "Search cited knowledge",
      description: [
        "Search the homelab knowledge base. Returns ranked chunks, each with full",
        `provenance: source_id, document_id, namespace, title, url, path, citation_anchor,`,
        "version (commit, created_at) and a score breakdown. Ranking is computed",
        "upstream; results are passed through unchanged in ranked order.",
        "Ground rules: state only facts that the returned chunk text directly",
        "supports; accompany every claim with its source_id and citation_anchor;",
        `queries are at most ${QUERY_MAX_LENGTH} characters and top_k is capped at ${TOP_K_MAX}.`,
        "If there are no results, or the chunks do not support the claim, say the",
        "knowledge base has no support instead of filling gaps from memory; never",
        "invent, alter, or paraphrase citations into unsupported claims.",
      ].join(" "),
      inputSchema: SearchToolInput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const payload = await client.search(input);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "get_source",
    {
      title: "Inspect a knowledge source",
      description: [
        "Fetch full provenance for one knowledge source by source_id: identity,",
        "namespace, title, url/path, immutable version (commit, created_at), and",
        "when available its chunk list with citation anchors. Pass the source_id",
        "exactly as it appeared in a search_knowledge citation. Use this to inspect",
        "a citation before relying on it. Do not cite a source you have not",
        "inspected, and do not claim facts the retrieved text does not support.",
      ].join(" "),
      inputSchema: GetSourceToolInput.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        const payload = await client.getSource(input.source_id);
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return toolError(err);
      }
    }
  );

  await server.connect(new StdioServerTransport());
  log(
    `listening on stdio; tools: search_knowledge (top_k default ${TOP_K_DEFAULT}), get_source`
  );
};

run().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
