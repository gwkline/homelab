// Minimal Kubernetes API client using the pod's own ServiceAccount identity.
// No kubectl, no client library: the API is just HTTPS + JSON.
import { readFileSync } from "node:fs";

const NS = "sandbox";

export interface K8sConfig {
  base: string;
  token: string;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

export function loadConfig(env = process.env): K8sConfig {
  const override = env.PANEL_K8S_BASE;
  if (override) {
    return {
      base: override.replace(/\/$/, ""),
      token: env.PANEL_K8S_TOKEN ?? "",
      ca: undefined,
      rejectUnauthorized: false,
    };
  }
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error("not running in-cluster and PANEL_K8S_BASE unset");
  return {
    base: `https://${host}:${port}`,
    token: readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "utf8",
    ).trim(),
    ca: readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    rejectUnauthorized: true,
  };
}

async function request<T = unknown>(cfg: K8sConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON error bodies still carry a message
  }
  if (!res.ok) {
    const message =
      (json as { message?: string } | undefined)?.message ??
      `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return json as T;
}

export const api = (cfg: K8sConfig) => ({
  listJobs: (): Promise<{ items?: any[] }> =>
    request(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/jobs`),
  listCronJobs: (): Promise<{ items?: any[] }> =>
    request(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/cronjobs`),
  getCronJob: (name: string): Promise<unknown> =>
    request(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/cronjobs/${encodeURIComponent(name)}`),
  createJob: (manifest: unknown) =>
    request(cfg, "POST", `/apis/batch/v1/namespaces/${NS}/jobs`, manifest),
});

export type K8sApi = ReturnType<typeof api>;
