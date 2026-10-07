// Minimal Kubernetes API client using the pod's own ServiceAccount identity.
// No kubectl, no client library: the API is just HTTPS + JSON.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

import { UPSTREAM_TIMEOUT_MS, upstreamError } from "./upstream.js";

const NS = "sandbox";

// Pod env entry; valueFrom entries (secret refs) pass through clones intact.
export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

// Only the fields the panel reads, all optional so every access is checked.
export interface K8sObject {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    nodeName?: string;
    schedule?: string;
    suspend?: boolean;
    selector?: Record<string, string>;
    ports?: { port?: number }[];
    jobTemplate?: { spec?: JobTemplateSpec };
    // Batch Job payloads carry their pod template here (listJobs/viewJob).
    template?: {
      spec?: {
        containers?: { env?: EnvVar[] }[];
      };
    };
  };
  status?: {
    active?: number;
    phase?: string;
    lastScheduleTime?: string;
    loadBalancer?: { ingress?: { hostname?: string }[] };
    addresses?: { type?: string; address?: string }[];
    conditions?: { type?: string; status?: string }[];
    capacity?: { memory?: string; cpu?: string };
    nodeInfo?: {
      architecture?: string;
      osImage?: string;
      kubeletVersion?: string;
    };
    containerStatuses?: { restartCount?: number }[];
  };
}

// Spec of a k8s Job (the payload of a CronJob's jobTemplate and of createJob).
export interface JobTemplateSpec {
  ttlSecondsAfterFinished?: number;
  template?: {
    spec?: {
      containers?: { env?: EnvVar[] }[];
    };
  };
}

export interface K8sConfig {
  base: string;
  token: string;
  ca?: Buffer;
  rejectUnauthorized: boolean;
}

export const loadConfig = (env = process.env): K8sConfig => {
  const override = env.PANEL_K8S_BASE;
  if (override) {
    return {
      base: override.replace(/\/$/u, ""),
      rejectUnauthorized: false,
      token: env.PANEL_K8S_TOKEN ?? "",
    };
  }
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    throw new Error("not running in-cluster and PANEL_K8S_BASE unset");
  }
  return {
    base: `https://${host}:${port}`,
    ca: readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    rejectUnauthorized: true,
    token: readFileSync(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
      "utf-8"
    ).trim(),
  };
};

type HttpsOptions = Parameters<typeof httpsRequest>[1] & {
  ca?: Buffer;
  rejectUnauthorized?: boolean;
};

const k8sFetch = <T>(
  cfg: K8sConfig,
  method: string,
  path: string,
  body?: unknown,
  contentType?: string
): Promise<T> => {
  const url = new URL(`${cfg.base}${path}`);
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const opts: HttpsOptions = {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${cfg.token}`,
      "content-type": contentType ?? "application/json",
    },
    method,
    // Covers the whole exchange: connect, headers, and body.
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  };
  if (isHttps && cfg.ca) {
    opts.ca = cfg.ca;
  }
  if (isHttps) {
    opts.rejectUnauthorized = cfg.rejectUnauthorized;
  }

  const call = { method, path: url.pathname };
  return new Promise<T>((resolve, reject) => {
    const fail = (error: unknown): void =>
      reject(upstreamError("kubernetes", call, error));
    const req = reqFn(url, opts, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => (data += c.toString("utf-8")));
      res.on("error", fail);
      res.on("end", () => {
        let json;
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
          reject(
            upstreamError(
              "kubernetes",
              call,
              new Error(message || `k8s ${status}`),
              status
            )
          );
          return;
        }
        resolve(json as T);
      });
    });
    req.on("error", fail);
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
};

export const api = (cfg: K8sConfig) => ({
  createJob: (manifest: unknown) =>
    k8sFetch<unknown>(
      cfg,
      "POST",
      `/apis/batch/v1/namespaces/${NS}/jobs`,
      manifest
    ),
  // batch/v1 orphans a deleted Job's pods unless told otherwise; a cancelled
  // run must stop running.
  deleteJob: (name: string): Promise<unknown> =>
    k8sFetch<unknown>(
      cfg,
      "DELETE",
      `/apis/batch/v1/namespaces/${NS}/jobs/${encodeURIComponent(name)}?propagationPolicy=Background`
    ),
  getCronJob: (name: string): Promise<K8sObject> =>
    k8sFetch<K8sObject>(
      cfg,
      "GET",
      `/apis/batch/v1/namespaces/${NS}/cronjobs/${encodeURIComponent(name)}`
    ),
  getIngress: (name: string, namespace: string): Promise<K8sObject> =>
    k8sFetch<K8sObject>(
      cfg,
      "GET",
      `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/ingresses/${encodeURIComponent(name)}`
    ),
  getService: (name: string, namespace: string): Promise<K8sObject> =>
    k8sFetch<K8sObject>(
      cfg,
      "GET",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`
    ),
  listCronJobs: (): Promise<{ items?: K8sObject[] }> =>
    k8sFetch(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/cronjobs`),
  listJobs: (): Promise<{ items?: K8sObject[] }> =>
    k8sFetch(cfg, "GET", `/apis/batch/v1/namespaces/${NS}/jobs`),
  listNodes: (): Promise<{ items?: K8sObject[] }> =>
    k8sFetch(cfg, "GET", `/api/v1/nodes`),
  listPodsAll: (): Promise<{ items?: K8sObject[] }> =>
    k8sFetch(cfg, "GET", `/api/v1/pods`),
  patchCronJob: (name: string, patch: unknown) =>
    k8sFetch<unknown>(
      cfg,
      "PATCH",
      `/apis/batch/v1/namespaces/${NS}/cronjobs/${encodeURIComponent(name)}`,
      patch,
      "application/merge-patch+json"
    ),
});

export type K8sApi = ReturnType<typeof api>;
