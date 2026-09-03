// TLS behavior of the k8s client. In-cluster the k3s API server presents a
// certificate signed by the cluster CA — the same shape as the private test CA
// here — so these tests exercise the exact verification path the panel hits in
// production: the client must fail TLS verification without the mounted CA and
// succeed with it. The fixtures are throwaway, localhost-only certs generated
// for these tests (10-year expiry, private CA; nothing sensitive to rotate).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

const root = path.join(import.meta.dirname, "..");
const fixtures = path.join(root, "tests", "fixtures");
const ca = readFileSync(path.join(fixtures, "ca.crt"));
const serverKey = readFileSync(path.join(fixtures, "server.key"));
const serverCert = readFileSync(path.join(fixtures, "server.crt"));

interface K8sCfg {
  base: string;
  token: string;
  rejectUnauthorized: boolean;
  ca?: Buffer;
}
interface K8sModule {
  loadConfig: (env: Record<string, string>) => K8sCfg;
  api: (cfg: K8sCfg) => {
    listCronJobs: () => Promise<{
      items?: { metadata?: { name?: string } }[];
    }>;
  };
}
const k8sModule = async (): Promise<K8sModule> =>
  (await import(path.join(root, "dist", "k8s.js"))) as K8sModule;

// Minimal HTTPS stand-in for the Kubernetes API server, certed by the private
// test CA. Records whether any HTTP request made it past the TLS handshake.
const startMockApi = async (): Promise<{
  base: string;
  authHeader: () => string | undefined;
  close: () => void;
}> => {
  let auth: string | undefined;
  const server = createServer(
    { cert: serverCert, key: serverKey },
    (req, res) => {
      auth = req.headers.authorization;
      if (auth !== "Bearer test-token") {
        res.writeHead(401).end('{"message":"unauthorized"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          items: [
            {
              metadata: { name: "loop-tls" },
              spec: { schedule: "0 9 * * *" },
            },
          ],
        })
      );
    }
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { authHeader: () => auth, base, close: () => server.close() };
};

test("k8s client verifies the API certificate against the CA", async () => {
  const { api } = await k8sModule();
  const mock = await startMockApi();
  try {
    // In-cluster shape: CA from the service-account mount, verification on.
    const cfg: K8sCfg = {
      base: mock.base,
      ca,
      rejectUnauthorized: true,
      token: "test-token",
    };
    const cronjobs = await api(cfg).listCronJobs();
    assert.equal(cronjobs.items?.[0]?.metadata?.name, "loop-tls");
    assert.equal(
      mock.authHeader(),
      "Bearer test-token",
      "request must reach the HTTP layer with the bearer token"
    );
  } finally {
    mock.close();
  }
});

test("the same request fails TLS verification without the CA", async () => {
  const { api } = await k8sModule();
  const mock = await startMockApi();
  try {
    const cfg: K8sCfg = {
      base: mock.base,
      rejectUnauthorized: true,
      token: "test-token",
    };
    await assert.rejects(
      () => api(cfg).listCronJobs(),
      /certificate|self-signed|unable to verify/iu
    );
    assert.equal(
      mock.authHeader(),
      undefined,
      "verification must fail the TLS handshake before any HTTP traffic"
    );
  } finally {
    mock.close();
  }
});

test("PANEL_K8S_BASE dev override disables verification (documented)", async () => {
  const { api, loadConfig } = await k8sModule();
  const mock = await startMockApi();
  try {
    const cfg = loadConfig({
      PANEL_K8S_BASE: `${mock.base}/`,
      PANEL_K8S_TOKEN: "test-token",
    });
    assert.equal(cfg.base, mock.base);
    assert.equal(cfg.rejectUnauthorized, false);
    assert.equal(cfg.ca, undefined);
    // Dev targets present private certs that are not the service-account CA,
    // so this config must connect without one.
    const cronjobs = await api(cfg).listCronJobs();
    assert.equal(cronjobs.items?.[0]?.metadata?.name, "loop-tls");
  } finally {
    mock.close();
  }
});
