// Dev Tools catalog — the panel as the front door for self-hosted developer
// tools. Adding a tool is one entry in DEV_TOOLS below plus the schema test
// in tests/devtools.test.mjs, which validates every entry automatically.
//
// Policy, encoded here rather than hoped for:
// - URLs use the {tailnet} placeholder, resolved at runtime from the panel
//   Service's LoadBalancer hostname (or PANEL_TAILNET_NAME). Personal
//   domains are never hard-coded; scripts/verify.sh rejects them anyway.
// - Health checks respect NetworkPolicies and valid Service ports: readiness
//   is derived from the Kubernetes API (Service exists, configured port is
//   actually declared on it, backing pods Ready), and the declared health
//   endpoint is probed over HTTP only through that Service port. A probe
//   that dies at the network layer (default-deny ingress drop, DNS, refusal)
//   is never mistaken for an outage — pods Ready stays the verdict and the
//   card says the endpoint was not probed.
// - The panel links out. It never iframes a tool (noEmbed records that most
//   forbid framing) and never proxies credentials — the API only ships
//   statuses and links.
// - Generic operations stay in the upstream tools; bespoke factory and
//   knowledge workflows stay in the panel's own pages.
export interface ToolHealth {
  service: string;
  namespace: string;
  port: number;
  path: string;
}

export interface ToolDef {
  name: string;
  description: string;
  icon: string; // lucide-react component name, mapped in web/src/components/DevToolsCard.tsx
  category: string;
  url: string; // https://<hostname>.{tailnet} — {tailnet} substituted at runtime
  health: ToolHealth | null; // null only where no check makes sense yet
  dependsOn: string; // what must exist for the tool to be usable
  enabled: boolean; // false = intentionally disabled, shown as such, never probed
  noEmbed: boolean; // true = forbids framing; the panel links out, never embeds
}

export const DEV_TOOLS: ToolDef[] = [
  {
    name: "Grafana",
    description: "Cluster metrics, logs, and alerting dashboards.",
    icon: "Gauge",
    category: "observability",
    url: "https://grafana.{tailnet}",
    health: { service: "grafana", namespace: "agents", port: 80, path: "/api/health" },
    dependsOn: "deploy/grafana/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "Headlamp",
    description: "Generic Kubernetes management — workloads, logs, edits.",
    icon: "Boxes",
    category: "kubernetes",
    url: "https://headlamp.{tailnet}",
    health: { service: "headlamp", namespace: "agents", port: 80, path: "/" },
    dependsOn: "deploy/headlamp/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "CloudBeaver",
    description: "Web database client for cluster data stores.",
    icon: "Database",
    category: "data",
    url: "https://cloudbeaver.{tailnet}",
    health: { service: "cloudbeaver", namespace: "agents", port: 80, path: "/" },
    dependsOn: "deploy/cloudbeaver/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "Executor",
    description: "Agentic task executor — generic runs stay upstream.",
    icon: "Bot",
    category: "agents",
    url: "https://executor.{tailnet}",
    health: { service: "executor", namespace: "agents", port: 8080, path: "/" },
    dependsOn: "deploy/executor/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "Homepage",
    description: "Tailnet-wide dashboard for every service.",
    icon: "LayoutDashboard",
    category: "dashboard",
    url: "https://homepage.{tailnet}",
    // 443 is the only port declared on the tailscale LoadBalancer Service;
    // it forwards to the container's plain HTTP port.
    health: { service: "homepage", namespace: "agents", port: 443, path: "/" },
    dependsOn: "deploy/homepage/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "T3 Code",
    description: "Interactive agent servers — one per replica.",
    icon: "SquareTerminal",
    category: "agents",
    url: "https://t3code-0.{tailnet}",
    health: { service: "t3code-0", namespace: "agents", port: 443, path: "/" },
    dependsOn: "deploy/t3code/base",
    enabled: true,
    noEmbed: true,
  },
  {
    name: "Knowledge",
    description: "Knowledge interface — enabled when its deploy lands.",
    icon: "BookOpen",
    category: "knowledge",
    url: "https://knowledge.{tailnet}",
    health: null,
    dependsOn: "knowledge interface deployment (tracked separately)",
    enabled: false, // flip on together with its Service; schema test requires health then
    noEmbed: true,
  },
];

export type ToolStatus = "healthy" | "unhealthy" | "unconfigured" | "disabled";

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
  getService(name: string, namespace: string): Promise<any>;
  listPodsAll(): Promise<{ items?: any[] }>;
}

// Tailnet DNS suffix, configured or discovered:
// 1. PANEL_TAILNET_NAME env (mirrors the homepage single-source-of-truth
//    ConfigMap value; "<tailnet>" placeholders don't count).
// 2. Discovered from the panel's own tailscale LoadBalancer Service — its
//    ingress hostname is panel.<tailnet>.ts.net, so the suffix falls out.
export async function discoverTailnet(env: NodeJS.ProcessEnv, k8s: DevToolsK8s): Promise<string | null> {
  const configured = (env.PANEL_TAILNET_NAME ?? "").trim();
  if (configured && configured !== "<tailnet>") return configured;
  try {
    const svc: any = await k8s.getService("panel", "agents");
    const hostname: string | undefined = svc?.status?.loadBalancer?.ingress?.[0]?.hostname;
    const suffix = hostname ? hostname.split(".").slice(1).join(".") : "";
    if (suffix && suffix !== "<tailnet>") return suffix;
  } catch {
    // not assigned yet (operator slow, env override missing) — unconfigured
  }
  return null;
}

function probeUrlFor(health: ToolHealth): string {
  return `http://${health.service}.${health.namespace}.svc:${health.port}${health.path}`;
}

type ProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "http-error"; status: number }
  | { kind: "network"; reason: string };

// Probe the tool's declared health endpoint through its Service port.
// 2xx/3xx → ok; 4xx/5xx → the app answered and is unhappy; network-level
// failures are reported as such so callers can defer to API-derived health.
async function probeHealth(url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<ProbeResult> {
  try {
    const res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (res.status < 400) return { kind: "ok", status: res.status };
    return { kind: "http-error", status: res.status };
  } catch (err: any) {
    const reason =
      err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : String(err?.message ?? err).slice(0, 80);
    return { kind: "network", reason };
  }
}

export interface EvaluateOpts {
  probeTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

// Resolve every catalog entry to one of the four card states.
export async function evaluateTools(
  defs: ToolDef[],
  k8s: DevToolsK8s,
  tailnet: string | null,
  opts: EvaluateOpts = {},
): Promise<ToolState[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
  // Share the Service lookups and the pod list across tools within one pass.
  const once = new Map<string, Promise<unknown>>();
  const shared = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!once.has(key)) once.set(key, fn());
    return once.get(key) as Promise<T>;
  };

  return Promise.all(
    defs.map(async (tool): Promise<ToolState> => {
      const base = {
        name: tool.name,
        description: tool.description,
        icon: tool.icon,
        category: tool.category,
        dependsOn: tool.dependsOn,
        enabled: tool.enabled,
        noEmbed: tool.noEmbed,
      };
      const url = tool.url.includes("{tailnet}")
        ? tailnet
          ? tool.url.replace("{tailnet}", tailnet)
          : null
        : tool.url;

      if (!tool.enabled) {
        return { ...base, status: "disabled", url, detail: `intentionally disabled — needs ${tool.dependsOn}` };
      }
      if (!url) {
        return {
          ...base,
          status: "unconfigured",
          url: null,
          detail: "tailnet hostname not discovered yet (set PANEL_TAILNET_NAME to override)",
        };
      }
      if (!tool.health) {
        return { ...base, status: "unconfigured", url, detail: `no health check configured — needs ${tool.dependsOn}` };
      }
      const { service, namespace, port, path } = tool.health;

      // 1. Dependency deployed?
      let svc: any;
      try {
        svc = await shared(`svc:${namespace}/${service}`, () => k8s.getService(service, namespace));
      } catch (err: any) {
        return {
          ...base,
          status: "unconfigured",
          url,
          detail: `dependency not deployed: service ${service}/${namespace} (${err.message})`,
        };
      }

      // 2. The configured port must actually be declared on the Service —
      //    never probe or advertise an invented port.
      const declaredPorts: any[] = svc?.spec?.ports ?? [];
      if (!declaredPorts.some((p) => p.port === port)) {
        const declared = declaredPorts.map((p) => p.port).join(", ") || "none";
        return {
          ...base,
          status: "unconfigured",
          url,
          detail: `catalog port ${port} is not declared on service ${service} (declared: ${declared})`,
        };
      }

      // 3. API-derived readiness — unaffected by NetworkPolicies.
      const selector = Object.entries(svc?.spec?.selector ?? {});
      let pods: any[] = [];
      if (selector.length) {
        const all = await shared("pods", () => k8s.listPodsAll());
        pods = (all.items ?? []).filter(
          (p: any) =>
            p.metadata?.namespace === namespace &&
            selector.every(([k, v]) => p.metadata?.labels?.[k] === v),
        );
      }
      if (selector.length && pods.length === 0) {
        return { ...base, status: "unhealthy", url, detail: `no pods match service ${service} selector` };
      }
      const ready = pods.filter((p: any) =>
        (p.status?.conditions ?? []).some((c: any) => c.type === "Ready" && c.status === "True"),
      ).length;
      if (selector.length && ready === 0) {
        return { ...base, status: "unhealthy", url, detail: `0/${pods.length} pods ready` };
      }

      // 4. Endpoint probe through the declared Service port. A network-level
      //    failure (typically the tool's default-deny ingress dropping the
      //    panel) is not an outage: keep the API verdict, say we didn't probe.
      const probe = await probeHealth(probeUrlFor(tool.health), fetchFn, probeTimeoutMs);
      if (probe.kind === "ok") {
        return { ...base, status: "healthy", url, detail: `health ${path} → ${probe.status}` };
      }
      if (probe.kind === "http-error") {
        return { ...base, status: "unhealthy", url, detail: `health ${path} → ${probe.status}` };
      }
      return {
        ...base,
        status: "healthy",
        url,
        detail: `pods ready · ${path} not probed (${probe.reason})`,
      };
    }),
  );
}
