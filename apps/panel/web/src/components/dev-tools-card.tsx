import { ExternalLink } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as icons from "lucide-react";
import { useEffect, useState } from "react";

import { Card, CardHeader, Badge } from "./ui";

interface Tool {
  name: string;
  description: string;
  icon: string;
  category: string;
  dependsOn: string;
  enabled: boolean;
  noEmbed: boolean;
  status: "healthy" | "unhealthy" | "unconfigured" | "disabled";
  url: string | null;
  detail: string | null;
}

interface DevToolsState {
  tailnet: { configured: boolean; name: string | null };
  tools: Tool[];
}

const ToolIcon = ({ name }: { name: string }) => {
  const Icon =
    (icons as unknown as Record<string, LucideIcon | undefined>)[name] ??
    icons.Wrench;
  return <Icon size={15} className="text-muted-foreground shrink-0" />;
};

const ToolTile = ({ tool }: { tool: Tool }) => {
  // Links open in a new tab — tools are never iframed (they forbid framing;
  // noEmbed records it) and the panel never proxies them or their creds.
  const linkable = tool.url !== null && tool.status !== "disabled";
  const body = (
    <>
      <div className="flex items-center gap-2">
        <ToolIcon name={tool.icon} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {tool.name}
        </span>
        {linkable && (
          <ExternalLink size={12} className="text-muted-foreground shrink-0" />
        )}
        <Badge status={tool.status} />
      </div>
      <p className="text-muted-foreground line-clamp-2 text-xs">
        {tool.description}
      </p>
      <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1">
        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]">
          {tool.category}
        </span>
        {tool.detail !== null && (
          <span
            className="text-muted-foreground min-w-0 truncate text-[10px]"
            title={tool.detail}
          >
            {tool.detail}
          </span>
        )}
      </div>
    </>
  );
  const cls =
    "flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-background/40 p-3 text-left transition-colors";
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
  return <div className={`${cls} opacity-70`}>{body}</div>;
};

const subtitleFor = (
  error: string | null,
  data: DevToolsState | null
): string => {
  if (error !== null) {
    return "catalog unavailable";
  }
  if (data !== null && data.tailnet.configured) {
    return `self-hosted tools at *.${data.tailnet.name} — health from the cluster, links open in a new tab`;
  }
  return "tailnet hostname not discovered yet — cards will link once it resolves";
};

export const DevToolsCard = () => {
  const [data, setData] = useState<DevToolsState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/devtools");
        const body = await res.json();
        if (res.ok) {
          setData(body);
        } else {
          setError(body.error ?? "failed to load dev tools");
        }
      } catch (loadError) {
        setError(String(loadError));
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <Card>
      <CardHeader title="dev tools" subtitle={subtitleFor(error, data)} />
      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
        {error !== null && (
          <p className="text-destructive text-sm sm:col-span-2 lg:col-span-3">
            {error}
          </p>
        )}
        {error === null && data === null && (
          <p className="text-muted-foreground text-sm sm:col-span-2 lg:col-span-3">
            loading catalog…
          </p>
        )}
        {error === null &&
          data?.tools.map((tool) => <ToolTile key={tool.name} tool={tool} />)}
      </div>
    </Card>
  );
};
