import { useMemo, useState } from "react";
import {
  createColumnHelper,
  createCoreRowModel,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  useTable,
} from "@tanstack/react-table";
import { Badge } from "./ui";

export interface JobRow {
  name: string;
  status: string;
  issue: string | null;
  age: string;
  repo: string | null;
  kind: string;
  created: string | null;
}

const col = createColumnHelper<JobRow>();

export function JobsTable({ jobs, onDelete }: { jobs: JobRow[]; onDelete: (name: string) => void }) {
  const [sorting, setSorting] = useState([{ id: "created", desc: true }]);
  const [filter, setFilter] = useState("");

  const columns = useMemo(
    () => [
      col.accessor("created", {
        id: "created",
        header: "started",
        cell: (info: any) => <span className="text-xs text-muted-foreground">{info.row.original.age}</span>,
      }),
      col.accessor("kind", {
        header: "kind",
        cell: (info: any) => (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{info.getValue()}</span>
        ),
      }),
      col.accessor("repo", {
        header: "repo",
        cell: (info: any) => <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>,
      }),
      col.accessor("issue", {
        header: "issue",
        cell: (info: any) =>
          info.getValue() ? (
            <span className="font-mono text-xs">#{info.getValue()}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      }),
      col.accessor("status", {
        header: "status",
        cell: (info: any) => <Badge status={info.getValue()} />,
      }),
      col.accessor("name", {
        header: "job",
        cell: (info: any) => <span className="font-mono text-xs text-muted-foreground">{info.getValue()}</span>,
      }),
      col.display({
        id: "actions",
        header: "",
        cell: (info: any) => {
          const s = info.row.original.status;
          if (s === "running") return null;
          return (
            <button
              onClick={() => onDelete(info.row.original.name)}
              className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="delete completed job"
            >
              ✕
            </button>
          );
        },
      }),
    ],
    [onDelete],
  );

  const table = useTable({
    data: jobs,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting as any,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: createCoreRowModel(),
    getSortedRowModel: createSortedRowModel(),
    getFilteredRowModel: createFilteredRowModel(),
  } as any);

  return (
    <div className="space-y-2">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter by kind, repo, issue, status…"
        className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg: any) => (
              <tr key={hg.id} className="border-b border-border text-xs text-muted-foreground">
                {hg.headers.map((h: any) => (
                  <th
                    onClick={() => {
                      const id = h.column.id;
                      setSorting((prev) => {
                        const cur = prev[0];
                        if (cur?.id !== id) return [{ id, desc: true }];
                        if (!cur.desc && cur.desc !== undefined) return [{ id, desc: true }];
                        return [{ id, desc: false }];
                      });
                    }}
                    className="cursor-pointer select-none px-2 py-2 font-medium"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sorting[0]?.id === h.column.id ? (sorting[0].desc ? " ▼" : " ▲") : ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row: any) => (
              <tr key={row.id} className="border-b border-border/50 hover:bg-muted/30">
                {row.getVisibleCells().map((cell: any) => (
                  <td key={cell.id} className="px-2 py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-2 py-4 text-center text-sm text-muted-foreground">
                  no matching jobs
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
