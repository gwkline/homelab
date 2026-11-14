import { ExternalLink, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as icons from "lucide-react";
import { useEffect, useState } from "react";

import type { ToolState } from "../../../server/devtools";
import { Card, CardHeader, Badge, Button } from "./ui";

interface DevToolsState {
  tailnet: { configured: boolean; name: string | null };
  tools: ToolState[];
}

const ToolIcon = ({ name }: { name: string }) => {
  const Icon =
    (icons as unknown as Record<string, LucideIcon | undefined>)[name] ??
    icons.Wrench;
  return <Icon size={20} className="text-primary shrink-0" />;
};

const ToolTile = ({ tool }: { tool: ToolState }) => {
  // Use only server-resolved launch URLs; never embed tools or proxy credentials.
  const linkable = tool.url !== null && tool.status !== "disabled";
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="bg-muted rounded-lg p-2">
          <ToolIcon name={tool.icon} />
        </span>
        <Badge status={tool.status} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{tool.name}</h3>
        {linkable && (
          <ExternalLink
            size={13}
            className="text-muted-foreground shrink-0"
            aria-hidden="true"
          />
        )}
      </div>
      <p className="text-muted-foreground text-sm">{tool.description}</p>
      <div className="border-border mt-auto space-y-2 border-t pt-3">
        <p className="text-muted-foreground text-xs leading-relaxed break-words">
          {tool.detail ?? "No health detail reported."}
        </p>
        <p className="text-muted-foreground text-xs">
          {tool.category}
          {linkable ? " · opens in a new tab" : " · no launch link"}
        </p>
      </div>
    </>
  );
  const cls =
    "flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-background/40 p-4 text-left transition-colors";
  if (linkable && tool.url !== null) {
    return (
      <a
        href={tool.url}
        target="_blank"
        rel="noreferrer"
        className={`${cls} hover:border-primary/50 hover:bg-muted/40`}
      >
        {body}
      </a>
    );
  }
  return <div className={cls}>{body}</div>;
};

export const DevToolsCard = ({ refreshKey = 0 }: { refreshKey?: number }) => {
  const [data, setData] = useState<DevToolsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await fetch("/api/devtools");
        const body = await res.json();
        if (!active) {
          return;
        }
        if (res.ok) {
          setData(body);
          setError(null);
        } else {
          setError(body.error ?? "failed to load services");
        }
      } catch (loadError) {
        if (active) {
          setError(String(loadError));
        }
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [refreshKey, reloadKey]);

  return (
    <Card>
      <CardHeader
        title="Services"
        subtitle="Launch your tools · status from cluster readiness and available health probes"
        action={
          <Button
            onClick={() => setReloadKey((key) => key + 1)}
            className="bg-muted text-foreground text-xs"
          >
            <RefreshCw size={12} /> Reload services
          </Button>
        }
      />
      <div className="space-y-4 p-5">
        {error !== null && (
          <p role="alert" className="text-destructive text-sm">
            Service catalog unavailable: {error}
          </p>
        )}
        {error === null && data === null && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading services…
          </p>
        )}
        {error === null && data !== null && (
          <>
            <p className="text-muted-foreground text-xs" role="status">
              {data.tools.filter((tool) => tool.status === "healthy").length}/
              {data.tools.length} healthy ·{" "}
              {data.tools.filter((tool) => tool.status === "unhealthy").length}{" "}
              unhealthy ·{" "}
              {
                data.tools.filter((tool) => tool.status === "unconfigured")
                  .length
              }{" "}
              unconfigured ·{" "}
              {data.tools.filter((tool) => tool.status === "disabled").length}{" "}
              disabled
            </p>
            {!data.tailnet.configured && (
              <p className="text-warning text-xs">
                Tailnet hostname not discovered yet. Launch links appear when it
                resolves.
              </p>
            )}
            {data.tools.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No services in the catalog.
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.tools.map((tool) => (
                <ToolTile key={tool.name} tool={tool} />
              ))}
            </div>
          </>
        )}
      </div>
    </Card>
  );
};
