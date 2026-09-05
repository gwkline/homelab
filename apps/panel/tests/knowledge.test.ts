import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");

const iso = (msAgo: number): string =>
  new Date(Date.now() - msAgo).toISOString();

const TOKEN = "knowledge-test-token";
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const PORT = 3961;

// Source list per the panel-facing knowledge API contract (#58/#64 + #65).
const SOURCES = [
  {
    chunkCount: 340,
    currentJob: null,
    documentCount: 12,
    kind: "github",
    lastError: null,
    lastSyncAt: iso(2 * minute),
    namespace: "homelab-docs",
    path: null,
    ref: "main",
    repo: "gwkline/homelab",
    sourceId: "homelab-docs",
    url: "https://github.com/gwkline/homelab",
  },
  {
    chunkCount: 77,
    currentJob: {
      jobId: "sync-job-9",
      startedAt: iso(90_000),
      status: "running",
    },
    documentCount: 3,
    kind: "url",
    lastError: { at: iso(26 * hour), message: "fetch ECONNRESET" },
    lastSyncAt: iso(26 * hour),
    namespace: "ops",
    path: null,
    ref: null,
    repo: null,
    sourceId: "runbook-mirror",
    url: "https://docs.internal/runbook",
  },
];

const SEARCH_HITS = [
  {
    anchors: [
      { end: 84, start: 9, type: "offset" },
      { type: "heading", value: "Sync jobs" },
    ],
    chunkId: "chunk-1",
    documentId: "doc-1",
    namespace: "homelab-docs",
    provenance: {
      ingestedAt: iso(2 * minute),
      ingestionEventId: "evt-2",
    },
    scores: {
      bm25: { rank: 2, score: 3.14 },
      fused: { rank: 1, score: 0.032787 },
      vector: { rank: 1, score: 0.87 },
    },
    source: {
      kind: "github",
      path: "docs/knowledge.md",
      sourceId: "gwkline/homelab",
      url: "https://github.com/gwkline/homelab/blob/abc1234/docs/knowledge.md",
    },
    tags: ["docs"],
    text: "Sync jobs are claimed with FOR UPDATE SKIP LOCKED so two workers never take one ingest_job row.",
    title: "Knowledge architecture",
    version: {
      commit: "abc1234def",
      createdAt: iso(2 * minute),
      status: "current",
      versionId: "doc-1-v2",
    },
  },
  {
    anchors: [{ end: 40, start: 0, type: "offset" }],
    chunkId: "chunk-2",
    documentId: "doc-2",
    namespace: "homelab-docs",
    provenance: {
      ingestedAt: iso(3 * day),
      ingestionEventId: "evt-1",
    },
    scores: {
      bm25: { rank: 1, score: 4.2 },
      fused: { rank: 2, score: 0.032258 },
      vector: null,
    },
    source: {
      kind: "github",
      path: "docs/old.md",
      sourceId: "gwkline/homelab",
      url: "https://github.com/gwkline/homelab/blob/0ld123/docs/old.md",
    },
    tags: [],
    text: "Superseded design notes kept for citation history only.",
    title: "Old design",
    version: {
      commit: "0ld123",
      createdAt: iso(3 * day),
      status: "superseded",
      versionId: "doc-2-v1",
    },
  },
];

interface UpstreamCall {
  auth: string | undefined;
  body: unknown;
  method: string;
  url: string;
}

interface Panel {
  calls: UpstreamCall[];
  get: (route: string) => Promise<{ body: string; status: number }>;
  post: (
    route: string,
    payload: unknown
  ) => Promise<{ body: string; status: number }>;
}

// Test backend standing in for the knowledge API: pinned auth, the four
// endpoints the panel proxies, and request capture for assertions.
const knowledgeMock = () => {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end('{"error":{"code":"unauthorized"}}');
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body: unknown = raw === "" ? null : JSON.parse(raw);
      calls.push({ auth, body, method: req.method ?? "", url });

      if (req.method === "GET" && url === "/v1/sources") {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ sources: SOURCES }));
        return;
      }
      if (req.method === "POST" && url === "/v1/sources/homelab-docs/sync") {
        res
          .writeHead(202, { "content-type": "application/json" })
          .end(JSON.stringify({ jobId: "sync-job-1", status: "queued" }));
        return;
      }
      if (req.method === "POST" && url.endsWith("/sync")) {
        res.writeHead(404).end(
          JSON.stringify({
            error: {
              code: "not_found",
              message: "unknown source",
              runId: null,
            },
          })
        );
        return;
      }
      if (req.method === "GET" && url === "/v1/sync-jobs/sync-job-1") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            attempts: 1,
            chunksIngested: 41,
            documentsIngested: 3,
            error: null,
            finishedAt: iso(1000),
            jobId: "sync-job-1",
            sourceId: "homelab-docs",
            startedAt: iso(4000),
            status: "succeeded",
          })
        );
        return;
      }
      if (req.method === "POST" && url === "/v1/search") {
        const q = body as { filters?: { includeSuperseded?: boolean } };
        const results =
          q.filters?.includeSuperseded === true
            ? SEARCH_HITS
            : SEARCH_HITS.filter((h) => h.version.status === "current");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            mode: "hybrid",
            namespace: "homelab-docs",
            results,
            runId: "run_test",
            topK: 5,
            totalCandidates: results.length,
          })
        );
        return;
      }
      res.writeHead(404).end('{"error":{"code":"not_found"}}');
    });
  });
  return {
    calls,
    server,
    url: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    },
  };
};

const stageFor = (label: string): string => {
  const stage = mkdtempSync(path.join(tmpdir(), `panel-${label}-`));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  copyFileSync(
    path.join(root, "dist", "index.js"),
    path.join(stage, "index.js")
  );
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );
  return stage;
};

const startPanel = async (
  stage: string,
  port: number,
  extraEnv: Record<string, string>
) => {
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      PANEL_K8S_BASE: "http://127.0.0.1:1",
      PANEL_ROOT: stage,
      PORT: String(port),
      ...extraEnv,
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 5000);
    child.stdout.on(
      "data",
      (d) => d.toString().includes("listening") && (clearTimeout(t), resolve())
    );
  });
  return child;
};

// Boots the mock knowledge API + a panel server wired to it, runs `fn` with
// JSON helpers, then tears down. Afterwards it proves the credential rule:
// every panel response is token-free and every upstream call carried the
// server-side bearer token.
const withPanel = async (
  fn: (panel: Panel) => Promise<void>
): Promise<void> => {
  const mock = knowledgeMock();
  await new Promise<void>((r) => mock.server.listen(0, "127.0.0.1", r));
  const stage = stageFor("knowledge");
  const child = await startPanel(stage, PORT, {
    KNOWLEDGE_API_BASE: mock.url(),
    KNOWLEDGE_API_TOKEN: TOKEN,
  });
  const base = `http://127.0.0.1:${PORT}`;
  const bodies: string[] = [];
  const record = async (res: Response) => {
    const body = await res.text();
    bodies.push(body);
    return { body, status: res.status };
  };
  try {
    await fn({
      calls: mock.calls,
      get: async (route) => await record(await fetch(`${base}${route}`)),
      post: async (route, payload) =>
        await record(
          await fetch(`${base}${route}`, {
            body: JSON.stringify(payload),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        ),
    });
    for (const body of bodies) {
      assert.ok(
        !body.includes(TOKEN),
        "panel response leaked the knowledge API bearer token"
      );
    }
    assert.ok(
      mock.calls.every((c) => c.auth === `Bearer ${TOKEN}`),
      "panel attached the bearer token server-side on every upstream call"
    );
  } finally {
    child.kill();
    mock.server.close();
  }
};

test("sources view exposes repository/ref, namespace, sync health, job, counts, last error", async () => {
  await withPanel(async (panel) => {
    const src = await panel.get("/api/knowledge/sources");
    assert.equal(src.status, 200);
    const srcJson = JSON.parse(src.body) as {
      configured: boolean;
      sources: {
        chunkCount: number;
        currentJob: { jobId: string; status: string } | null;
        documentCount: number;
        lastError: { at: string; message: string } | null;
        lastSyncAt: string | null;
        namespace: string;
        ref: string | null;
        repo: string | null;
        sourceId: string;
      }[];
    };
    assert.equal(srcJson.configured, true);
    assert.equal(srcJson.sources.length, 2);
    const [a, b] = srcJson.sources;
    assert.equal(a?.sourceId, "homelab-docs");
    assert.equal(a?.repo, "gwkline/homelab");
    assert.equal(a?.ref, "main");
    assert.equal(a?.namespace, "homelab-docs");
    assert.equal(a?.documentCount, 12);
    assert.equal(a?.chunkCount, 340);
    assert.ok(a?.lastSyncAt !== null, "last successful sync is exposed");
    assert.equal(a?.currentJob, null);
    assert.equal(a?.lastError, null);
    assert.equal(b?.currentJob?.status, "running", "current job is exposed");
    assert.equal(b?.lastError?.message, "fetch ECONNRESET");
  });
});

test("operators trigger a sync and observe durable job progress", async () => {
  await withPanel(async (panel) => {
    // validation guards (never reach the upstream)
    assert.equal(
      (await panel.post("/api/knowledge/sync", { sourceId: "../etc/passwd" }))
        .status,
      400
    );
    assert.equal(
      (await panel.post("/api/knowledge/sync", { sourceId: "nope" })).status,
      404,
      "upstream 404 for an unknown source passes through"
    );

    const sync = await panel.post("/api/knowledge/sync", {
      sourceId: "homelab-docs",
    });
    assert.equal(sync.status, 202);
    const syncJson = JSON.parse(sync.body) as {
      jobId: string;
      sourceId: string;
    };
    assert.equal(syncJson.sourceId, "homelab-docs");
    assert.ok(syncJson.jobId.length > 0);
    assert.equal(
      panel.calls.some(
        (c) => c.method === "POST" && c.url === "/v1/sources/homelab-docs/sync"
      ),
      true,
      "panel forwarded the sync trigger"
    );

    const progress = await panel.get(
      `/api/knowledge/sync/${encodeURIComponent(syncJson.jobId)}`
    );
    assert.equal(progress.status, 200);
    const progressJson = JSON.parse(progress.body) as {
      chunksIngested: number | null;
      documentsIngested: number | null;
      status: string;
    };
    assert.equal(progressJson.status, "succeeded");
    assert.equal(progressJson.documentsIngested, 3);
    assert.equal(progressJson.chunksIngested, 41);
  });
});

test("cited search: request validation, score breakdown, and provenance", async () => {
  await withPanel(async (panel) => {
    // request validation mirrors the retrieval contract
    assert.equal(
      (await panel.post("/api/knowledge/search", { query: "  " })).status,
      400
    );
    assert.equal(
      (await panel.post("/api/knowledge/search", { query: "x", topK: 9999 }))
        .status,
      400
    );
    assert.equal(
      (
        await panel.post("/api/knowledge/search", {
          mode: "keyword",
          query: "x",
        })
      ).status,
      400
    );
    assert.equal(
      (
        await panel.post("/api/knowledge/search", {
          namespace: "Bad_Ns",
          query: "x",
        })
      ).status,
      400
    );

    const search = await panel.post("/api/knowledge/search", {
      mode: "hybrid",
      namespace: "homelab-docs",
      query: "sync jobs",
      topK: 5,
    });
    assert.equal(search.status, 200);
    const searchJson = JSON.parse(search.body) as {
      results: {
        chunkId: string;
        scores: {
          bm25: { rank: number } | null;
          fused: { rank: number; score: number };
          vector: { rank: number } | null;
        };
        source: { path: string | null; url: string | null };
        text: string;
        title: string;
        version: { commit: string | null; status: string };
      }[];
      totalCandidates: number;
    };
    assert.equal(searchJson.results.length, 1, "superseded hidden by default");
    const [hit] = searchJson.results;
    assert.ok(hit !== undefined, "expected one hit");
    assert.equal(hit.chunkId, "chunk-1");
    assert.equal(hit.title, "Knowledge architecture");
    assert.equal(hit.source.path, "docs/knowledge.md");
    assert.equal(hit.version.commit, "abc1234def");
    assert.equal(hit.version.status, "current");
    assert.ok(hit.text.includes("SKIP LOCKED"), "excerpt text is exposed");
    assert.equal(hit.scores.fused.rank, 1);
    assert.ok(hit.scores.fused.score > 0);
    assert.equal(hit.scores.bm25?.rank, 2);
    assert.equal(hit.scores.vector?.rank, 1);
    assert.equal(
      hit.source.url,
      "https://github.com/gwkline/homelab/blob/abc1234/docs/knowledge.md",
      "citation URL provenance survives the proxy"
    );
    const searchCall = panel.calls.find(
      (c) => c.method === "POST" && c.url === "/v1/search"
    );
    const searchBody = (searchCall?.body ?? {}) as {
      filters?: unknown;
      mode?: string;
      namespace?: string;
      topK?: number;
    };
    assert.equal(searchBody.topK, 5);
    assert.equal(searchBody.mode, "hybrid");
    assert.equal(searchBody.namespace, "homelab-docs");
    assert.equal(
      searchBody.filters,
      undefined,
      "no superseded filter unless asked"
    );
  });
});

test("superseded content is only exposed when explicitly requested", async () => {
  await withPanel(async (panel) => {
    const searchAll = await panel.post("/api/knowledge/search", {
      includeSuperseded: true,
      mode: "hybrid",
      namespace: "homelab-docs",
      query: "sync jobs",
      topK: 5,
    });
    assert.equal(searchAll.status, 200);
    const searchAllJson = JSON.parse(searchAll.body) as {
      results: { chunkId: string; version: { status: string } }[];
    };
    assert.equal(searchAllJson.results.length, 2);
    const [, superseded] = searchAllJson.results;
    assert.ok(superseded !== undefined, "expected the superseded hit");
    assert.equal(superseded.chunkId, "chunk-2");
    assert.equal(
      superseded.version.status,
      "superseded",
      "superseded content is distinguishable in the payload"
    );
    const lastCall = panel.calls.findLast(
      (c) => c.method === "POST" && c.url === "/v1/search"
    );
    const lastBody = (lastCall?.body ?? {}) as {
      filters?: { includeSuperseded?: boolean };
    };
    assert.deepEqual(lastBody.filters, { includeSuperseded: true });
  });
});

test("knowledge card degrades explicitly when the knowledge API is not configured", async () => {
  const stage = stageFor("knowledge-off");
  const port = 3962;
  const child = await startPanel(stage, port, {});
  try {
    const base = `http://127.0.0.1:${port}`;
    const src = await fetch(`${base}/api/knowledge/sources`);
    assert.equal(src.status, 200);
    const srcJson = (await src.json()) as {
      configured: boolean;
      sources: unknown[];
    };
    assert.equal(srcJson.configured, false);
    assert.deepEqual(srcJson.sources, []);

    const search = await fetch(`${base}/api/knowledge/search`, {
      body: JSON.stringify({ query: "x" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(search.status, 503);

    const sync = await fetch(`${base}/api/knowledge/sync`, {
      body: JSON.stringify({ sourceId: "homelab-docs" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    assert.equal(sync.status, 503);
  } finally {
    child.kill();
  }
});
