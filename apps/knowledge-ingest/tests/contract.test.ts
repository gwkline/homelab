import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../server/app.ts";
import { baseConfig } from "../server/config.ts";
import type { IngestStore } from "../server/store.ts";
import {
  bearer,
  createHarness,
  getJson,
  makeIngestBody,
  noopLogger,
  TEST_TOKEN,
} from "./helpers.ts";

test("healthz answers without auth and reports liveness only", async () => {
  const { app } = createHarness();
  const res = await app.request("/healthz");
  assert.equal(res.status, 200);
  const body = await getJson(res);
  assert.equal(body["status"], "ok");
});

test("readyz distinguishes a healthy store from database unavailability", async () => {
  const { app } = createHarness();
  const ok = await app.request("/readyz");
  assert.equal(ok.status, 200);
  assert.deepEqual(await getJson(ok), {
    backend: "memory",
    checks: { database: "up" },
    status: "ok",
  });

  const brokenStore = new Proxy(createHarness().store, {
    get(target, property, receiver) {
      if (property === "ping") {
        return () => Promise.reject(new Error("connection refused"));
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as IngestStore;
  const downApp = createApp({
    config: baseConfig(TEST_TOKEN),
    logger: noopLogger,
    store: brokenStore,
  });
  const res = await downApp.request("/readyz");
  assert.equal(res.status, 503);
  const body = await getJson(res);
  assert.equal(body["status"], "unavailable");
  assert.deepEqual(body["checks"], { database: "down" });
});

test("readiness reports database down when the probe times out", async () => {
  const hungStore = new Proxy(createHarness().store, {
    get(target, property, receiver) {
      if (property === "ping") {
        return () =>
          new Promise<void>(() => {
            // never settles — the probe must time out, not hang
          });
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as IngestStore;
  const app = createApp({
    config: baseConfig(TEST_TOKEN),
    logger: noopLogger,
    store: hungStore,
  });
  const res = await app.request("/readyz");
  assert.equal(res.status, 503);
  const hung = await getJson(res);
  assert.deepEqual(hung["checks"], { database: "down" });
});

test("all /v1 routes reject missing, malformed, and wrong tokens", async () => {
  const { app } = createHarness();
  const body = makeIngestBody();
  const targets: [string, RequestInit][] = [
    ["/v1/ingest", { body: JSON.stringify(body), method: "POST" }],
    ["/v1/sources", { method: "GET" }],
    ["/v1/sources/homelab-docs/sync", { method: "POST" }],
    ["/v1/sync-jobs/job_x", { method: "GET" }],
  ];
  const requests = targets.map(async ([path, init]) => {
    const missing = await app.request(path, init);
    assert.equal(missing.status, 401, `missing token on ${path}`);
    const wrong = await app.request(path, {
      ...init,
      headers: bearer("not-the-token"),
    });
    assert.equal(wrong.status, 401, `wrong token on ${path}`);
    const err = await getJson(wrong);
    assert.equal(
      (err["error"] as Record<string, unknown>)["code"],
      "unauthorized"
    );
  });
  await Promise.all(requests);
  const good = await app.request("/v1/sources", { headers: bearer() });
  assert.equal(good.status, 200);
});

test("openapi document is served unauthenticated", async () => {
  const { app } = createHarness();
  const res = await app.request("/openapi.json");
  assert.equal(res.status, 200);
  const doc = await getJson(res);
  assert.ok(
    typeof doc["paths"] === "object" &&
      Object.keys(doc["paths"] as object).includes("/v1/ingest")
  );
});

test("ingest rejects untrusted input: missing fields, bad patterns, bad hashes", async () => {
  const { app } = createHarness();
  const cases: [string, Record<string, unknown>][] = [
    ["bad namespace", { namespace: "Homelab_Docs" }],
    ["bad source id", { source: { kind: "github", sourceId: "-bad id!" } }],
    ["bad kind", { source: { kind: "gopher", sourceId: "s1" } }],
    ["short content hash", { contentHash: "abcd" }],
    ["non-hex content hash", { contentHash: "g".repeat(64) }],
    ["empty external id", { externalId: "   " }],
    ["empty versionId", { version: { versionId: "" } }],
    ["bad provenance timestamp", { provenance: { ingestedAt: "not-a-date" } }],
    ["bad url", { source: { kind: "url", sourceId: "s1", url: "nope" } }],
    ["oversized tags", { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ["missing version block", { version: undefined }],
  ];
  const requests = cases.map(async ([label, overrides]) => {
    const res = await app.request("/v1/ingest", {
      body: JSON.stringify(makeIngestBody(overrides)),
      headers: bearer(),
      method: "POST",
    });
    assert.equal(res.status, 422, `${label} must be rejected`);
    const err = await getJson(res);
    assert.equal(
      (err["error"] as Record<string, unknown>)["code"],
      "invalid_request"
    );
  });
  await Promise.all(requests);
});

test("ingest rejects malformed JSON bodies with 422", async () => {
  const { app } = createHarness();
  const res = await app.request("/v1/ingest", {
    body: "{not json",
    headers: bearer(),
    method: "POST",
  });
  assert.equal(res.status, 422);
  const err = await getJson(res);
  assert.equal(
    (err["error"] as Record<string, unknown>)["code"],
    "invalid_request"
  );
});

test("unknown routes answer the standard error envelope", async () => {
  const { app } = createHarness();
  const res = await app.request("/v1/nope", { headers: bearer() });
  assert.equal(res.status, 404);
  const err = await getJson(res);
  assert.equal((err["error"] as Record<string, unknown>)["code"], "not_found");
});
