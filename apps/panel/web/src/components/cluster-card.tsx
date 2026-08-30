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

// Ki memory string (e.g. "16374884Ki") → whole GiB (e.g. "15Gi"), or null
// when the value is missing/unparseable.
const memGi = (memory: string | null): string | null => {
  if (memory === null) {
    return null;
  }
  const m = /^(?<kibi>\d+(?:\.\d+)?)Ki$/u.exec(memory);
  return m === null
    ? null
    : `${Math.trunc(Number(m.groups?.kibi) / 1024 / 1024)}Gi`;
};

const podPhaseClass = (phase: string): string => {
  if (phase === "Running") {
    return "text-success";
  }
  if (phase === "Succeeded") {
    return "text-muted-foreground";
  }
  return "text-destructive";
};

export const ClusterCard = () => {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [pods, setPods] = useState<PodInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [nodesRes, podsRes] = await Promise.all([
          fetch("/api/cluster"),
          fetch("/api/cluster/pods"),
        ]);
        const nodesBody = await nodesRes.json();
        const podsBody = await podsRes.json();
        if (nodesRes.ok) {
          setNodes(nodesBody.nodes ?? []);
        } else {
          setError(nodesBody.error ?? "cluster unreachable");
        }
        if (podsRes.ok) {
          setPods(podsBody.pods ?? []);
        }
      } catch (loadError) {
        setError(String(loadError));
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (error !== null) {
    return (
      <Card>
        <CardHeader title="cluster" subtitle="nodes + pods" />
        <p className="text-destructive px-5 py-4 text-sm">{error}</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="cluster"
        subtitle={`${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${pods.length} pods`}
      />
      <div className="divide-border divide-y">
        {nodes.map((n) => {
          const expanded = expandedNode === n.name;
          const nodePods = expanded
            ? pods.filter((p) => p.node === n.name)
            : [];
          const unhealthy = nodePods.filter(
            (p) =>
              p.phase !== "Running" &&
              p.phase !== "Succeeded" &&
              p.phase !== "Completed"
          );
          return (
            <div key={n.name}>
              <button
                onClick={() => setExpandedNode(expanded ? null : n.name)}
                className="hover:bg-muted/30 flex w-full items-center justify-between gap-3 px-5 py-3 text-left"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
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
                  <p className="text-muted-foreground text-xs">
                    {n.pods} pods · {n.capacity.cpu ?? "?"} cpu ·{" "}
                    {n.capacity.memory === null
                      ? "?"
                      : (memGi(n.capacity.memory) ?? "?")}{" "}
                    mem · {n.version ?? ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-muted-foreground font-mono text-xs">
                    {n.internalIP}
                  </span>
                  <Badge
                    status={n.status === "Ready" ? "complete" : "failed"}
                  />
                  <span className="text-muted-foreground text-xs">
                    {expanded ? "▾" : "▸"}
                  </span>{" "}
                </div>
              </button>
              {expanded && (
                <div className="bg-muted/20 px-5 py-2">
                  <p className="text-muted-foreground mb-1 text-xs">
                    {n.os} · {n.arch} · pods on node: {n.pods}
                  </p>
                  <div className="divide-border/50 border-border max-h-48 divide-y overflow-auto rounded border">
                    {nodePods.map((p) => (
                      <div
                        key={`${p.ns}/${p.name}`}
                        className="flex items-center justify-between px-3 py-1.5 text-xs"
                      >
                        <span className="min-w-0 truncate font-mono">
                          <span className="text-muted-foreground mr-2">
                            {p.ns}
                          </span>
                          {p.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {p.restarts > 0 && (
                            <span className="text-warning">↻{p.restarts}</span>
                          )}
                          <span className={podPhaseClass(p.phase)}>
                            {p.phase}
                          </span>
                        </span>
                      </div>
                    ))}
                    {nodePods.length === 0 && (
                      <p className="text-muted-foreground px-3 py-2">no pods</p>
                    )}
                  </div>
                  {unhealthy.length > 0 && (
                    <p className="text-warning mt-1 text-xs">
                      {unhealthy.length} pod(s) not Running
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};
