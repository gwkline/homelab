import { useEffect, useState } from "react";

import { Card, CardHeader, Badge } from "./ui";

interface NodeInfo {
  name: string;
  status: string;
  version: string | null;
  os: string | null;
  arch: string | null;
  internalIP: string | null;
  roles: string[];
  pods: number;
  capacity: { cpu: string | null; memory: string | null };
  age: string | null;
}

interface PodInfo {
  name: string;
  ns: string;
  node: string | null;
  phase: string;
  restarts: number;
}

// Kubernetes node capacity is reported in Ki; keep missing data explicit.
const memGi = (memory: string | null): string | null => {
  if (memory === null) {
    return null;
  }
  const m = /^(?<kibi>\d+(?:\.\d+)?)Ki$/u.exec(memory);
  return m === null
    ? null
    : `${Math.trunc(Number(m.groups?.kibi) / 1024 / 1024)}Gi`;
};

const isCompleted = (pod: PodInfo): boolean =>
  pod.phase === "Succeeded" || pod.phase === "Completed";
const isOtherPhase = (pod: PodInfo): boolean =>
  pod.phase !== "Running" && !isCompleted(pod);
const podPhaseClass = (phase: string): string => {
  if (phase === "Running") {
    return "text-success";
  }
  if (phase === "Succeeded" || phase === "Completed") {
    return "text-muted-foreground";
  }
  return "text-warning";
};

export const ClusterCard = ({ refreshKey = 0 }: { refreshKey?: number }) => {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [nodesRes, podsRes] = await Promise.all([
          fetch("/api/cluster"),
          fetch("/api/cluster/pods"),
        ]);
        const nodesBody = await nodesRes.json();
        const podsBody = await podsRes.json();
        if (!active) {
          return;
        }
        // Never combine a new node snapshot with stale or missing pod data.
        if (!nodesRes.ok || !podsRes.ok) {
          setError(nodesBody.error ?? podsBody.error ?? "cluster unavailable");
        } else {
          setNodes(nodesBody.nodes ?? []);
          setPods(podsBody.pods ?? []);
          setError(null);
          setUpdated(
            new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          );
        }
      } catch (loadError) {
        if (active) {
          setError(String(loadError));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refreshKey]);

  if (error !== null) {
    return (
      <Card>
        <CardHeader
          title="Cluster"
          subtitle="Status unavailable · refresh to retry"
        />
        <p role="alert" className="text-destructive px-5 py-4 text-sm">
          {error}
        </p>
      </Card>
    );
  }

  const readyNodes = nodes.filter((node) => node.status === "Ready").length;
  const running = pods.filter((pod) => pod.phase === "Running").length;
  const completed = pods.filter(isCompleted).length;
  const attention = pods.filter(isOtherPhase).length;

  return (
    <Card>
      <CardHeader
        title="Cluster"
        subtitle="Node readiness & pod phases · select a node to inspect workloads"
        action={
          <span className="text-muted-foreground text-xs">
            {updated ? `Updated ${updated} · every 30s` : "Connecting…"}
          </span>
        }
      />
      {loading ? (
        <p className="text-muted-foreground px-5 py-4 text-sm" role="status">
          Loading cluster…
        </p>
      ) : (
        <div
          className="border-border grid grid-cols-2 gap-4 border-b px-5 py-4 sm:grid-cols-4"
          aria-label="Cluster summary"
        >
          {[
            {
              label: "Ready nodes",
              tone:
                readyNodes === nodes.length && nodes.length > 0
                  ? "text-success"
                  : "text-warning",
              value: `${readyNodes}/${nodes.length}`,
            },
            { label: "Running pods", tone: "text-foreground", value: running },
            {
              label: "Other pod phases",
              tone: attention > 0 ? "text-warning" : "text-foreground",
              value: attention,
            },
            {
              label: "Completed pods",
              tone: "text-muted-foreground",
              value: completed,
            },
          ].map((metric) => (
            <div key={metric.label}>
              <p className="text-muted-foreground text-xs">{metric.label}</p>
              <p
                className={`mt-1 text-2xl font-semibold tabular-nums ${metric.tone}`}
              >
                {metric.value}
              </p>
            </div>
          ))}
          <p className="text-muted-foreground col-span-2 text-xs sm:col-span-4">
            Pod phase is not container readiness. Pending, Failed &amp; Unknown
            phases are counted separately from completed jobs.
          </p>
        </div>
      )}
      {!loading && nodes.length === 0 && (
        <p className="text-muted-foreground px-5 py-4 text-sm">
          No nodes reported.
        </p>
      )}
      <div className="divide-border divide-y">
        {nodes.map((n) => {
          const expanded = expandedNode === n.name;
          const nodePods = pods.filter((p) => p.node === n.name);
          const otherPhases = nodePods.filter(isOtherPhase);
          return (
            <div key={n.name}>
              <button
                onClick={() => setExpandedNode(expanded ? null : n.name)}
                aria-expanded={expanded}
                aria-controls={expanded ? `pods-${n.name}` : undefined}
                className="hover:bg-muted/30 flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3 text-left"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${n.status === "Ready" ? "bg-success" : "bg-destructive"}`}
                    />
                    {n.name}
                    {n.roles.map((r) => (
                      <span
                        key={r}
                        className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs"
                      >
                        {r}
                      </span>
                    ))}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {n.pods} pods · {n.capacity.cpu ?? "?"} cpu ·{" "}
                    {memGi(n.capacity.memory) ?? "?"} mem · {n.version ?? ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {otherPhases.length > 0 && (
                    <span className="text-warning text-xs">
                      {otherPhases.length} other phases
                    </span>
                  )}
                  <span className="text-muted-foreground font-mono text-xs">
                    {n.internalIP}
                  </span>
                  <Badge status={n.status} />
                  <span
                    className="text-muted-foreground text-xs"
                    aria-hidden="true"
                  >
                    {expanded ? "▾" : "▸"}
                  </span>
                </div>
              </button>
              {expanded && (
                <div id={`pods-${n.name}`} className="bg-muted/20 px-5 py-3">
                  <p className="text-muted-foreground mb-2 text-xs">
                    {n.os} · {n.arch} · pods on node: {n.pods}
                  </p>
                  <div className="divide-border/50 border-border max-h-64 divide-y overflow-auto rounded border">
                    {nodePods
                      .toSorted(
                        (a, b) =>
                          Number(isOtherPhase(b)) - Number(isOtherPhase(a))
                      )
                      .map((p) => (
                        <div
                          key={`${p.ns}/${p.name}`}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                        >
                          <span
                            className="min-w-0 truncate font-mono"
                            title={`${p.ns}/${p.name}`}
                          >
                            <span className="text-muted-foreground mr-2">
                              {p.ns}
                            </span>
                            {p.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {p.restarts > 0 && (
                              <span
                                className="text-warning"
                                title="Container restarts"
                              >
                                ↻{p.restarts}
                              </span>
                            )}
                            <span className={podPhaseClass(p.phase)}>
                              {p.phase}
                            </span>
                          </span>
                        </div>
                      ))}
                    {nodePods.length === 0 && (
                      <p className="text-muted-foreground px-3 py-2">
                        No pods on this node.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};
