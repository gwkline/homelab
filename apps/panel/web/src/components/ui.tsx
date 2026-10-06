import { Button as BaseButton } from "@base-ui/react/button";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Input as BaseInput } from "@base-ui/react/input";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";

// Base UI (base-ui.com, from the Radix/MUI team) is the headless base for the
// interactive controls — Button, Input, Select, and Checkbox here wrap its
// parts so behavior (focus management, keyboard nav, a11y) comes from one
// upstream implementation. Card/CardHeader/Badge have no Base UI equivalents;
// they stay layout primitives.

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
  <BaseButton
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
  <BaseInput
    className={cn(
      "border-border bg-background placeholder:text-muted-foreground focus:border-primary w-full rounded-lg border px-3 py-1.5 text-sm outline-none",
      className
    )}
    {...props}
  />
);

export interface SelectOption {
  label: string;
  value: string;
}

// Base UI Select behind a native-select-shaped API: controlled value,
// options, change callback. Renders a portal popup with keyboard nav,
// highlight, and item indicators.
export const Select = ({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel?: string;
  className?: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  value: string;
}) => (
  <BaseSelect.Root
    items={options}
    onValueChange={(next) => {
      onChange(String(next));
    }}
    value={value}
  >
    <BaseSelect.Trigger
      aria-label={ariaLabel}
      className={cn(
        "border-border bg-background focus:border-primary inline-flex items-center justify-between gap-1.5 rounded-lg border px-2 py-1.5 text-sm outline-none",
        className
      )}
    >
      <BaseSelect.Value />
      <BaseSelect.Icon>
        <ChevronDown size={14} className="text-muted-foreground" />
      </BaseSelect.Icon>
    </BaseSelect.Trigger>
    <BaseSelect.Portal>
      <BaseSelect.Positioner alignItemWithTrigger={false} sideOffset={4}>
        <BaseSelect.Popup className="bg-background border-border text-foreground z-50 rounded-lg border p-1 shadow-lg">
          {options.map((o) => (
            <BaseSelect.Item
              key={o.value}
              value={o.value}
              className="text-muted-foreground data-[highlighted]:bg-muted data-[highlighted]:text-foreground flex cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-sm"
            >
              <BaseSelect.ItemIndicator>
                <Check size={12} />
              </BaseSelect.ItemIndicator>
              <BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
            </BaseSelect.Item>
          ))}
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>
);

// Base UI Checkbox with the native control's shape: controlled checked +
// change callback. The visible label text is the caller's; point ariaLabel at
// what the control toggles.
export const Checkbox = ({
  ariaLabel,
  checked,
  onCheckedChange,
}: {
  ariaLabel: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <BaseCheckbox.Root
    aria-label={ariaLabel}
    checked={checked}
    className={cn(
      "border-border data-[checked]:border-primary data-[checked]:bg-primary text-primary-foreground flex h-4 w-4 shrink-0 items-center justify-center rounded border"
    )}
    onCheckedChange={(next) => {
      onCheckedChange(next === true);
    }}
  >
    <BaseCheckbox.Indicator className="text-[10px] leading-none font-bold">
      ✓
    </BaseCheckbox.Indicator>
  </BaseCheckbox.Root>
);
