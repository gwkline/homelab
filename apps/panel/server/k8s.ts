// Minimal Kubernetes API client using the pod's own ServiceAccount identity.
// No kubectl, no client library: the API is just HTTPS + JSON.
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

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

function k8sFetch<T>(cfg: K8sConfig, method: string, path: string, body?: unknown, contentType?: string): Promise<T> {
  const url = new URL(`${cfg.base}${path}`);
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const opts: Record<string, unknown> = {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": contentType ?? "application/json",
      accept: "application/json",
    },
  };
  if (isHttps && cfg.ca) (opts as any).ca = cfg.ca;
  if (isHttps) (opts as any).rejectUnauthorized = cfg.rejectUnauthorized;

  return new Promise<T>((resolve, reject) => {
    const req = reqFn(url, opts as any, (res: any) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString("utf8")));
      res.on("end", () => {
        let json: unknown = undefined;
        try {
          json = data ? JSON.parse(data) : undefined;
        } catch {
          // non-JSON
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const message =
            (json as { message?: string } | undefined)?.message ??
            `${status} ${res.statusMessage ?? ""}`.trim();
          reject(Object.assign(new Error(message || `k8s ${status}`), { status }));
          return;
        }
        resolve(json as T);
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export const api = (cfg: K8sConfig) => ({
  listJobs: (): Promise<{ items?: any[] }> =>
    k8sFetch(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/jobs`),
  listCronJobs: (): Promise<{ items?: any[] }> =>
    k8sFetch(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/cronjobs`),
  getCronJob: (name: string): Promise<unknown> =>
    k8sFetch(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/cronjobs/${encodeURIComponent(name)}`),
  createJob: (manifest: unknown) =>
    k8sFetch(cfg, "POST", `/apis/batch/v1/namespaces/${NS}/jobs`, manifest),
  patchCronJob: (name: string, patch: unknown) =>
    k8sFetch(cfg, "PATCH", `/apis/batch/v1/namespaces/${NS}/cronjobs/${encodeURIComponent(name)}`, patch, "application/merge-patch+json"),
  listNodes: (): Promise<{ items?: any[] }> =>
    k8sFetch(cfg, "GET", `/api/v1/nodes`),
  getService: (name: string, namespace: string): Promise<any> =>
    k8sFetch(cfg, "GET", `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`),
  listNamespaces: (): Promise<{ items?: any[] }> =>
    k8sFetch(cfg, "GET", `/api/v1/namespaces`),
  listPodsAll: (): Promise<{ items?: any[] }> =>
    k8sFetch(cfg, "GET", `/api/v1/pods`),
  deleteJob: (name: string): Promise<unknown> =>
    k8sFetch(cfg, "DELETE", `/apis/batch/v1/namespaces/${NS}/jobs/${encodeURIComponent(name)}`),
});

export type K8sApi = ReturnType<typeof api>;
