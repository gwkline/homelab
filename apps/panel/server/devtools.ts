// Dev Tools catalog. Adding a tool is one DEV_TOOLS entry; tests/devtools.test.ts
// validates every entry.
//
// - URLs use a {tailnet} placeholder resolved at runtime; personal domains are
//   never hard-coded.
// - Readiness comes from the Kubernetes API. A health probe that fails at the
//   network layer (e.g. default-deny ingress) is not treated as an outage.
// - The panel links out; it never iframes tools or proxies credentials.
import type { K8sObject } from "./k8s.js";

interface ToolHealth {
  service: string;
  namespace: string;
  port: number;
  path: string;
}

export interface ToolDef {
  name: string;
  description: string;
  // lucide-react component name, mapped in web/src/components/dev-tools-card.tsx
  icon: string;
  category: string;
  // https://<hostname>.{tailnet} — {tailnet} substituted at runtime
  url: string;
  // null only where no check makes sense yet
  health: ToolHealth | null;
  // what must exist for the tool to be usable
  dependsOn: string;
  // false = intentionally disabled, shown as such, never probed
  enabled: boolean;
  // true = forbids framing; the panel links out, never embeds
  noEmbed: boolean;
}

export const DEV_TOOLS: ToolDef[] = [
  {
    category: "observability",
    dependsOn: "deploy/grafana/base",
    description: "Cluster metrics, logs, and alerting dashboards.",
    enabled: true,
    health: {
      namespace: "agents",
      path: "/api/health",
      port: 80,
      service: "grafana",
    },
    icon: "Gauge",
    name: "Grafana",
    noEmbed: true,
    url: "https://grafana.{tailnet}",
  },
  {
    category: "kubernetes",
    dependsOn: "deploy/headlamp/base",
    description: "Generic Kubernetes management — workloads, logs, edits.",
    enabled: true,
    health: { namespace: "agents", path: "/", port: 80, service: "headlamp" },
    icon: "Boxes",
    name: "Headlamp",
    noEmbed: true,
    url: "https://headlamp.{tailnet}",
  },
  {
    category: "data",
    dependsOn: "deploy/cloudbeaver/base",
    description: "Web database client for cluster data stores.",
    enabled: true,
    health: {
      namespace: "agents",
      path: "/",
      port: 80,
      service: "cloudbeaver",
    },
    icon: "Database",
    name: "CloudBeaver",
    noEmbed: true,
    url: "https://cloudbeaver.{tailnet}",
  },
  {
    category: "agents",
    dependsOn: "deploy/executor/base",
    description: "Agentic task executor — generic runs stay upstream.",
    enabled: true,
    health: { namespace: "agents", path: "/", port: 8080, service: "executor" },
    icon: "Bot",
    name: "Executor",
    noEmbed: true,
    url: "https://executor.{tailnet}",
  },
  {
    category: "dashboard",
    dependsOn: "deploy/homepage/base",
    description: "Tailnet-wide dashboard for every service.",
    enabled: true,
    // 443 is the only port declared on the tailscale LoadBalancer Service;
    // it forwards to the container's plain HTTP port.
    health: { namespace: "agents", path: "/", port: 443, service: "homepage" },
    icon: "LayoutDashboard",
    name: "Homepage",
    noEmbed: true,
    url: "https://homepage.{tailnet}",
  },
  {
    category: "agents",
    dependsOn: "deploy/t3code/base",
    description: "Interactive agent servers — one per replica.",
    enabled: true,
    health: {
      namespace: "agents",
      path: "/",
      port: 3773,
      service: "t3code-0",
    },
    icon: "SquareTerminal",
    name: "T3 Code",
    noEmbed: true,
    url: "https://t3code-0.{tailnet}",
  },
  {
    category: "knowledge",
    dependsOn: "deploy/knowledge/base",
    description:
      "Knowledge base — cited hybrid search over the homelab corpus.",
    enabled: true,
    health: {
      namespace: "agents",
      path: "/healthz",
      port: 3000,
      service: "knowledge-retrieval-http",
    },
    icon: "BookOpen",
    name: "Knowledge",
    noEmbed: true,
    url: "https://knowledge.{tailnet}",
  },
];

type ToolStatus = "healthy" | "unhealthy" | "unconfigured" | "disabled";

export interface ToolState {
  name: string;
  description: string;
  icon: string;
  category: string;
  dependsOn: string;
  enabled: boolean;
  noEmbed: boolean;
  status: ToolStatus;
  url: string | null;
  detail: string | null;
}

// Structural subset of the panel's k8s api the evaluator needs.
export interface DevToolsK8s {
  getIngress: (name: string, namespace: string) => Promise<K8sObject>;
  getService: (name: string, namespace: string) => Promise<K8sObject>;
  listPodsAll: () => Promise<{ items?: K8sObject[] }>;
}

// Tailnet DNS suffix: PANEL_TAILNET_NAME, else derived from the panel's own
// Tailscale Ingress hostname (panel.<tailnet>.ts.net).
export const discoverTailnet = async (
  env: NodeJS.ProcessEnv,
  k8s: DevToolsK8s
): Promise<string | null> => {
  const configured = (env.PANEL_TAILNET_NAME ?? "").trim();
  if (configured && configured !== "<tailnet>") {
    return configured;
  }
  try {
    const ing = await k8s.getIngress("panel", "agents");
    const hostname = ing?.status?.loadBalancer?.ingress?.[0]?.hostname;
    const suffix = hostname ? hostname.split(".").slice(1).join(".") : "";
    if (suffix && suffix !== "<tailnet>") {
      return suffix;
    }
  } catch {
    // hostname not assigned yet
  }
  return null;
};

const probeUrlFor = (health: ToolHealth): string =>
  `http://${health.service}.${health.namespace}.svc:${health.port}${health.path}`;

// Substitute the {tailnet} placeholder; null when the tailnet isn't known yet.
const resolveToolUrl = (url: string, tailnet: string | null): string | null => {
  if (!url.includes("{tailnet}")) {
    return url;
  }
  if (tailnet === null) {
    return null;
  }
  return url.replace("{tailnet}", tailnet);
};

type ProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "http-error"; status: number }
  | { kind: "network"; reason: string };

// Network-level failures are reported separately so callers can defer to
// API-derived readiness.
const probeHealth = async (
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<ProbeResult> => {
  try {
    const res = await fetchFn(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status < 400) {
      return { kind: "ok", status: res.status };
    }
    return { kind: "http-error", status: res.status };
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      name === "TimeoutError" || name === "AbortError"
        ? "timeout"
        : message.slice(0, 80);
    return { kind: "network", reason };
  }
};

export interface EvaluateOpts {
  probeTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

const withBase = (
  tool: ToolDef,
  rest: Omit<
    ToolState,
    | "name"
    | "description"
    | "icon"
    | "category"
    | "dependsOn"
    | "enabled"
    | "noEmbed"
  >
): ToolState => ({
  category: tool.category,
  dependsOn: tool.dependsOn,
  description: tool.description,
  enabled: tool.enabled,
  icon: tool.icon,
  name: tool.name,
  noEmbed: tool.noEmbed,
  ...rest,
});

// Returns the failure detail, or null when the tool's pods are ready.
const readinessError = async (
  health: ToolHealth,
  svc: K8sObject | undefined,
  k8s: DevToolsK8s,
  shared: <T>(key: string, fn: () => Promise<T>) => Promise<T>
): Promise<string | null> => {
  const selector = Object.entries(svc?.spec?.selector ?? {});
  if (selector.length === 0) {
    return null;
  }
  const all = await shared("pods", () => k8s.listPodsAll());
  const pods = (all.items ?? []).filter(
    (p: K8sObject) =>
      p.metadata?.namespace === health.namespace &&
      selector.every(([k, v]) => p.metadata?.labels?.[k] === v)
  );
  if (pods.length === 0) {
    return `no pods match service ${health.service} selector`;
  }
  const ready = pods.filter((p: K8sObject) =>
    (p.status?.conditions ?? []).some(
      (c) => c.type === "Ready" && c.status === "True"
    )
  ).length;
  if (ready === 0) {
    return `0/${pods.length} pods ready`;
  }
  return null;
};

const evaluateOne = async (
  tool: ToolDef,
  ctx: {
    k8s: DevToolsK8s;
    url: string | null;
    tailnet: string | null;
    fetchFn: typeof fetch;
    probeTimeoutMs: number;
    shared: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  }
): Promise<ToolState> => {
  const { k8s, url, fetchFn, probeTimeoutMs, shared } = ctx;
  if (!tool.enabled) {
    return withBase(tool, {
      detail: `intentionally disabled — needs ${tool.dependsOn}`,
      status: "disabled",
      url,
    });
  }
  if (url === null) {
    return withBase(tool, {
      detail:
        "tailnet hostname not discovered yet (set PANEL_TAILNET_NAME to override)",
      status: "unconfigured",
      url: null,
    });
  }
  if (!tool.health) {
    return withBase(tool, {
      detail: `no health check configured — needs ${tool.dependsOn}`,
      status: "unconfigured",
      url,
    });
  }
  const { service, namespace, port, path } = tool.health;

  let svc: K8sObject | undefined;
  try {
    svc = (await shared(`svc:${namespace}/${service}`, () =>
      k8s.getService(service, namespace)
    )) as K8sObject;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return withBase(tool, {
      detail: `dependency not deployed: service ${service}/${namespace} (${reason})`,
      status: "unconfigured",
      url,
    });
  }

  // Never probe or advertise a port the Service doesn't declare.
  const declaredPorts = svc?.spec?.ports ?? [];
  if (!declaredPorts.some((p) => p.port === port)) {
    const declared = declaredPorts.map((p) => p.port).join(", ") || "none";
    return withBase(tool, {
      detail: `catalog port ${port} is not declared on service ${service} (declared: ${declared})`,
      status: "unconfigured",
      url,
    });
  }

  const readiness = await readinessError(tool.health, svc, k8s, shared);
  if (readiness !== null) {
    return withBase(tool, { detail: readiness, status: "unhealthy", url });
  }

  // A network-level failure (typically default-deny ingress) is not an
  // outage: keep the API verdict and say we didn't probe.
  const probe = await probeHealth(
    probeUrlFor(tool.health),
    fetchFn,
    probeTimeoutMs
  );
  if (probe.kind === "ok") {
    return withBase(tool, {
      detail: `health ${path} → ${probe.status}`,
      status: "healthy",
      url,
    });
  }
  if (probe.kind === "http-error") {
    return withBase(tool, {
      detail: `health ${path} → ${probe.status}`,
      status: "unhealthy",
      url,
    });
  }
  return withBase(tool, {
    detail: `pods ready · ${path} not probed (${probe.reason})`,
    status: "healthy",
    url,
  });
};

// Resolve every catalog entry to one of the four card states.
export const evaluateTools = (
  defs: ToolDef[],
  k8s: DevToolsK8s,
  tailnet: string | null,
  opts: EvaluateOpts = {}
): Promise<ToolState[]> => {
  const fetchFn = opts.fetchFn ?? fetch;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
  // Share the Service lookups and the pod list across tools within one pass.
  const once = new Map<string, Promise<unknown>>();
  const shared = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!once.has(key)) {
      once.set(key, fn());
    }
    return once.get(key) as Promise<T>;
  };
  return Promise.all(
    defs.map((tool) => {
      const url = resolveToolUrl(tool.url, tailnet);
      return evaluateOne(tool, {
        fetchFn,
        k8s,
        probeTimeoutMs,
        shared,
        tailnet,
        url,
      });
    })
  );
};
