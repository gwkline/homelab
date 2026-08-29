import type { ReactNode } from "react";

import { cn } from "../lib/utils";

export const Card = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <div
    className={cn(
      "border-border bg-card text-card-foreground rounded-xl border shadow-sm",
      className
    )}
  >
    {children}
  </div>
);

export const CardHeader = ({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) => (
  <div className="border-border flex items-center justify-between border-b px-5 py-4">
    <div>
      <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
      {subtitle && (
        <p className="text-muted-foreground mt-0.5 text-xs">{subtitle}</p>
      )}
    </div>
    {action}
  </div>
);

interface BadgeTone {
  className: string;
  matches: string[];
}

const TONES: BadgeTone[] = [
  {
    className: "bg-success/15 text-success border-success/30",
    matches: ["complete", "healthy"],
  },
  {
    className: "bg-destructive/15 text-destructive border-destructive/30",
    matches: ["failed", "unhealthy"],
  },
  {
    className: "bg-warning/15 text-warning border-warning/30",
    matches: ["running"],
  },
];

const toneFor = (status: string): string => {
  const tone = TONES.find((t) => t.matches.includes(status));
  return tone?.className ?? "bg-muted text-muted-foreground border-border";
};

export const Badge = ({ status }: { status: string }) => (
  <span
    className={cn(
      "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
      toneFor(status)
    )}
  >
    {status}
  </span>
);

export const Button = ({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    className={cn(
      "bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  />
);

export const Input = ({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    className={cn(
      "border-border bg-background placeholder:text-muted-foreground focus:border-primary w-full rounded-lg border px-3 py-1.5 text-sm outline-none",
      className
    )}
    {...props}
  />
);
