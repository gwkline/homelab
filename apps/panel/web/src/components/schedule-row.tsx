import { useEffect, useState } from "react";

import { Button } from "./ui";

interface CronJob {
  name: string;
  schedule: string;
  suspended: boolean;
  lastScheduled: string | null;
  active: number;
}

export const ScheduleRow = ({
  cj,
  onSaved,
}: {
  cj: CronJob;
  onSaved: () => void;
}) => {
  const [editing, setEditing] = useState(false);
  const [schedule, setSchedule] = useState(cj.schedule);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => setSchedule(cj.schedule), [cj.schedule]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/cronjobs/${encodeURIComponent(cj.name)}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const j = await res.json();
      if (res.ok) {
        onSaved();
      } else {
        setErr(j.error ?? "failed");
      }
    } catch (error) {
      setErr(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
      <div className="min-w-0">
        <p className="font-mono text-sm">
          {cj.name}
          {cj.active > 0 && (
            <span className="text-warning ml-2 text-xs">
              {cj.active} active
            </span>
          )}
        </p>
        <p className="text-muted-foreground text-xs">
          {cj.suspended
            ? "suspended"
            : `last ${cj.lastScheduled === null ? "never" : new Date(cj.lastScheduled).toLocaleString()}`}
        </p>
        {err !== null && <p className="text-destructive text-xs">{err}</p>}
      </div>
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && schedule !== cj.schedule) {
                  patch({ schedule });
                }
                if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              className="border-border bg-background w-32 rounded border px-2 py-1 font-mono text-xs"
              autoFocus
            />
            <Button
              onClick={() => schedule !== cj.schedule && patch({ schedule })}
              disabled={busy || schedule === cj.schedule}
              className="h-7 px-2 py-1 text-xs"
            >
              save
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setSchedule(cj.schedule);
              }}
              disabled={busy}
              className="bg-muted text-foreground h-7 px-2 py-1 text-xs"
            >
              cancel
            </Button>
          </>
        ) : (
          <>
            <code className="bg-muted rounded px-2 py-1 text-xs">
              {cj.schedule}
            </code>
            <button
              onClick={() => setEditing(true)}
              className="text-muted-foreground hover:bg-muted hover:text-foreground rounded px-1.5 py-0.5 text-xs"
              title="edit schedule"
            >
              edit
            </button>
          </>
        )}
        <Button
          onClick={() => patch({ suspended: !cj.suspended })}
          disabled={busy}
          className={`h-7 px-2 py-1 text-xs ${cj.suspended ? "bg-success/15 text-success border-success/30 hover:bg-success/25 border" : "bg-warning/15 text-warning border-warning/30 hover:bg-warning/25 border"}`}
        >
          {cj.suspended ? "resume" : "pause"}
        </Button>
      </div>
    </div>
  );
};
