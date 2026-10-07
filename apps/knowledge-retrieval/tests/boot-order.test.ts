import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Boots the real ingest and retrieval entrypoints against a fresh, empty
 * database in each order. Needs DATABASE_URL with rights to create databases
 * and the vector and pg_textsearch extensions.
 */

const hasLiveDb = Boolean(process.env["DATABASE_URL"]);
const TOKEN = "boot-order-test-token-0123456789";
const RETRIEVAL_ENTRY = path.resolve(import.meta.dirname, "../server/index.ts");
const INGEST_ENTRY = path.resolve(
  import.meta.dirname,
  "../../knowledge-ingest/server/index.ts"
);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  });

interface Service {
  base: string;
  output: () => string;
  process: ChildProcess;
}

const startService = async (
  entry: string,
  env: Record<string, string>
): Promise<Service> => {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", entry],
    {
      env: { ...process.env, ...env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    process: child,
  };
};

const waitFor = async (
  service: Service,
  route: string,
  expected: number
): Promise<void> => {
  const deadline = Date.now() + 30_000;
  let last = "no response";
  while (Date.now() < deadline) {
    if (service.process.exitCode !== null) {
      throw new Error(
        `service exited ${service.process.exitCode}:\n${service.output()}`
      );
    }
    try {
      const response = await fetch(`${service.base}${route}`);
      if (response.status === expected) {
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(200);
  }
  throw new Error(
    `${route} never returned ${expected} (${last}):\n${service.output()}`
  );
};

const search = (retrieval: Service): Promise<Response> =>
  fetch(`${retrieval.base}/v1/search`, {
    body: JSON.stringify({ query: "restart the postgres primary" }),
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    method: "POST",
  });

const stop = async (service: Service): Promise<void> => {
  if (service.process.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => {
    service.process.once("exit", resolve);
  });
  service.process.kill("SIGTERM");
  await exited;
};

const withFreshDatabase = async (
  fn: (url: string) => Promise<void>
): Promise<void> => {
  const { default: pg } = await import("pg");
  const admin = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const name = `knowledge_boot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    const url = new URL(process.env["DATABASE_URL"] ?? "");
    url.pathname = `/${name}`;
    await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
};

const retrievalEnv = (url: string): Record<string, string> => ({
  KNOWLEDGE_RETRIEVAL_DATABASE_URL: url,
  KNOWLEDGE_RETRIEVAL_TOKEN: TOKEN,
});

const ingestEnv = (url: string): Record<string, string> => ({
  KNOWLEDGE_INGEST_DATABASE_URL: url,
  KNOWLEDGE_INGEST_TOKEN: TOKEN,
});

test(
  "retrieval first: it waits on an empty database until ingest migrates",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set", timeout: 120_000 },
  async () => {
    await withFreshDatabase(async (url) => {
      const retrieval = await startService(RETRIEVAL_ENTRY, retrievalEnv(url));
      let ingest: Service | null = null;
      try {
        await waitFor(retrieval, "/healthz", 200);
        assert.equal((await search(retrieval)).status, 503);

        const { default: pg } = await import("pg");
        const probe = new pg.Pool({ connectionString: url });
        const tables = await probe.query(
          "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"
        );
        await probe.end();
        assert.equal(tables.rows[0]?.["n"], 0, "retrieval created nothing");

        ingest = await startService(INGEST_ENTRY, ingestEnv(url));
        await waitFor(ingest, "/readyz", 200);
        const served = await search(retrieval);
        assert.equal(served.status, 200);
        const body = (await served.json()) as { mode?: string };
        assert.equal(body.mode, "bm25", "no embedding provider is configured");
      } finally {
        await stop(retrieval);
        if (ingest !== null) {
          await stop(ingest);
        }
      }
    });
  }
);

test(
  "ingest first, two replicas racing the migration: retrieval serves at once",
  { skip: hasLiveDb ? false : "DATABASE_URL is not set", timeout: 120_000 },
  async () => {
    await withFreshDatabase(async (url) => {
      const replicas = await Promise.all([
        startService(INGEST_ENTRY, ingestEnv(url)),
        startService(INGEST_ENTRY, ingestEnv(url)),
      ]);
      let retrieval: Service | null = null;
      try {
        await Promise.all(
          replicas.map((replica) => waitFor(replica, "/readyz", 200))
        );
        retrieval = await startService(RETRIEVAL_ENTRY, retrievalEnv(url));
        await waitFor(retrieval, "/healthz", 200);
        assert.equal((await search(retrieval)).status, 200);
      } finally {
        await Promise.all(replicas.map(stop));
        if (retrieval !== null) {
          await stop(retrieval);
        }
      }
    });
  }
);
