import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../../server/ingest/app.ts";
import { baseConfig } from "../../server/ingest/config.ts";
import { createMemoryManifestStore } from "../../server/ingest/git-sync.ts";
import { createMemoryIngestStore } from "../../server/ingest/memory-store.ts";
import {
  createMemoryPipelineSink,
  createPipelineHandler,
} from "../../server/ingest/pipeline-worker.ts";
import {
  DEFAULT_SOURCE_URL_PREFIXES,
  isAllowedSourceUrl,
  sourceUrlPrefixesFromEnv,
} from "../../server/ingest/source-url.ts";
import { runWorkerCycle } from "../../server/ingest/worker.ts";
import {
  bearer,
  createHarness,
  getJson,
  makeIngestBody,
  makeIngestInput,
  makeWorkerConfig,
  noopLogger,
  TEST_TOKEN,
} from "./helpers.ts";

const REFUSED = [
  "file:///etc/passwd",
  "http://github.com/gwkline/homelab",
  "https://attacker.example/gwkline/homelab",
  "https://github.com.attacker.example/gwkline/homelab",
  "https://token@github.com/gwkline/homelab",
  "ssh://git@github.com/gwkline/homelab",
];

test("only https URLs under an allowed prefix pass", () => {
  assert.ok(
    isAllowedSourceUrl(
      "https://github.com/gwkline/homelab",
      DEFAULT_SOURCE_URL_PREFIXES
    )
  );
  assert.ok(
    isAllowedSourceUrl(
      "https://GitHub.com/gwkline/../gwkline/homelab",
      DEFAULT_SOURCE_URL_PREFIXES
    ),
    "compared after URL normalization"
  );
  for (const url of [...REFUSED, "/etc/passwd", "not a url"]) {
    assert.equal(
      isAllowedSourceUrl(url, DEFAULT_SOURCE_URL_PREFIXES),
      false,
      url
    );
  }
});

test("the prefix allowlist is explicit and must end in a slash", () => {
  assert.deepEqual(sourceUrlPrefixesFromEnv({}), ["https://github.com/"]);
  assert.deepEqual(
    sourceUrlPrefixesFromEnv({
      KNOWLEDGE_INGEST_SOURCE_URL_PREFIXES:
        "https://github.com/, https://docs.example.org/handbook/",
    }),
    ["https://github.com/", "https://docs.example.org/handbook/"]
  );
  for (const bad of [
    "https://github.com",
    "http://github.com/",
    "file:///",
    "nope",
  ]) {
    assert.throws(
      () =>
        sourceUrlPrefixesFromEnv({ KNOWLEDGE_INGEST_SOURCE_URL_PREFIXES: bad }),
      /normalized https URLs/u,
      bad
    );
  }
});

test("the ingest API refuses source URLs off the allowlist", async () => {
  const { app } = createHarness();
  for (const url of REFUSED) {
    const res = await app.request("/v1/ingest", {
      body: JSON.stringify(
        makeIngestBody({
          source: { kind: "github", sourceId: "homelab-docs", url },
        })
      ),
      headers: bearer(),
      method: "POST",
    });
    assert.equal(res.status, 422, url);
    const body = await getJson(res);
    assert.equal(
      (body["error"] as Record<string, unknown>)["code"],
      "invalid_request"
    );
  }
  const repo = await app.request("/v1/ingest", {
    body: JSON.stringify(
      makeIngestBody({
        source: { kind: "github", repo: "../../etc", sourceId: "homelab-docs" },
      })
    ),
    headers: bearer(),
    method: "POST",
  });
  assert.equal(repo.status, 422, "repo must be owner/name");
  const ok = await app.request("/v1/ingest", {
    body: JSON.stringify(makeIngestBody()),
    headers: bearer(),
    method: "POST",
  });
  assert.equal(ok.status, 202);
});

test("an explicit allowlist admits other https sources", async () => {
  const store = createMemoryIngestStore();
  const app = createApp({
    config: baseConfig(TEST_TOKEN, {
      sourceUrlPrefixes: ["https://github.com/", "https://docs.example.org/"],
    }),
    logger: noopLogger,
    store,
  });
  const res = await app.request("/v1/ingest", {
    body: JSON.stringify(
      makeIngestBody({
        source: {
          kind: "url",
          sourceId: "handbook",
          url: "https://docs.example.org/ops.md",
        },
      })
    ),
    headers: bearer(),
    method: "POST",
  });
  assert.equal(res.status, 202);
});

test("a stored source off the allowlist fails its job before git or fetch run", async () => {
  const store = createMemoryIngestStore({ maxAttempts: 1 });
  let fetched = 0;
  let synced = 0;
  const handler = createPipelineHandler({
    fetchImpl: () => {
      fetched += 1;
      return Promise.resolve(new Response("x"));
    },
    gitSync: () => {
      synced += 1;
      return Promise.reject(new Error("must not run"));
    },
    logger: noopLogger,
    manifests: createMemoryManifestStore(),
    sink: createMemoryPipelineSink(),
    store,
  });
  // Written straight to the store, as rows from before the API check were.
  await store.enqueueIngest(
    makeIngestInput({
      source: {
        kind: "url",
        path: null,
        ref: null,
        repo: null,
        sourceId: "legacy-url",
        url: "http://attacker.example/x",
      },
    })
  );
  const legacy = await store.enqueueIngest(
    makeIngestInput({
      contentHash: "b".repeat(64),
      source: {
        kind: "github",
        path: "README.md",
        ref: "main",
        repo: null,
        sourceId: "legacy-git",
        url: "file:///etc",
      },
    })
  );
  await store.enqueueSourceSync(legacy.job.sourceId);
  const cycle = await runWorkerCycle({
    config: makeWorkerConfig({ maxAttempts: 1 }),
    handler,
    logger: noopLogger,
    store,
  });
  assert.equal(cycle.failed, 3);
  assert.equal(fetched, 0);
  assert.equal(synced, 0);
  const job = await store.getJob(legacy.job.jobId);
  assert.match(job?.error ?? "", /not under an allowed https prefix/u);
});
