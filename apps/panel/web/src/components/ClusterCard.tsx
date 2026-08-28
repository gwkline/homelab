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

export function ClusterCard() {
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
        if (nodesRes.ok) setNodes(nodesBody.nodes ?? []);
        else setError(nodesBody.error ?? "cluster unreachable");
        if (podsRes.ok) setPods(podsBody.pods ?? []);
      } catch (e) {
        setError(String(e));
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader title="cluster" subtitle="nodes + pods" />
        <p className="px-5 py-4 text-sm text-destructive">{error}</p>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="cluster"
        subtitle={`${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${pods.length} pods`}
      />
      <div className="divide-y divide-border">
        {nodes.map((n) => {
          const nodePods = expandedNode === n.name ? pods.filter((p) => p.node === n.name) : [];
          const unhealthy = nodePods.filter((p) => p.phase !== "Running" && p.phase !== "Succeeded" && p.phase !== "Completed");
          return (
            <div key={n.name}>
              <button
                onClick={() => setExpandedNode(expandedNode === n.name ? null : n.name)}
                className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-muted/30"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${n.status === "Ready" ? "bg-success" : "bg-destructive"}`}
                    />
                    {n.name}
                    {n.roles.map((r) => (
                      <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{r}</span>
                    ))}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {n.pods} pods · {n.capacity.cpu ?? "?"} cpu · {n.capacity.memory ? `${Math.round(parseInt(n.capacity.memory) / 1024 / 1024)}Gi` : "?"} mem · {n.version ?? ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{n.internalIP}</span>
                  <Badge status={n.status === "Ready" ? "complete" : "failed"} />
                  <span className="text-xs text-muted-foreground">{expandedNode === n.name ? "▾" : "▸"}</span>
                </div>
              </button>
              {expandedNode === n.name && (
                <div className="bg-muted/20 px-5 py-2">
                  <p className="mb-1 text-xs text-muted-foreground">
                    {n.os} · {n.arch} · pods on node: {n.pods}
                  </p>
                  <div className="max-h-48 divide-y divide-border/50 overflow-auto rounded border border-border">
                    {nodePods.map((p) => (
                      <div key={`${p.ns}/${p.name}`} className="flex items-center justify-between px-3 py-1.5 text-xs">
                        <span className="min-w-0 truncate font-mono">
                          <span className="mr-2 text-muted-foreground">{p.ns}</span>
                          {p.name}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {p.restarts > 0 && <span className="text-warning">↻{p.restarts}</span>}
                          <span className={p.phase === "Running" ? "text-success" : p.phase === "Succeeded" ? "text-muted-foreground" : "text-destructive"}>
                            {p.phase}
                          </span>
                        </span>
                      </div>
                    ))}
                    {nodePods.length === 0 && <p className="px-3 py-2 text-muted-foreground">no pods</p>}
                  </div>
                  {unhealthy.length > 0 && (
                    <p className="mt-1 text-xs text-warning">{unhealthy.length} pod(s) not Running</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
