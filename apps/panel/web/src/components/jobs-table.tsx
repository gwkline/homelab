import {
  createColumnHelper,
  createCoreRowModel,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  useTable,
} from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/table-core";
import {
  coreFeatures,
  columnVisibilityFeature,
  stockFeatures,
  tableFeatures,
} from "@tanstack/table-core";
import { useMemo, useState } from "react";

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

// The feature set this table registers (v9 requires explicit registration —
// see the comment on JobsTable).
const features = tableFeatures({
  columnFilteringFeature: stockFeatures.columnFilteringFeature,
  columnVisibilityFeature,
  coreRowModel: createCoreRowModel(),
  filteredRowModel: createFilteredRowModel(),
  globalFilteringFeature: stockFeatures.globalFilteringFeature,
  rowSortingFeature: stockFeatures.rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  ...coreFeatures,
});

type PanelTableFeatures = typeof features;

const col = createColumnHelper<PanelTableFeatures, JobRow>();

const sortIndicator = (
  sorting: { desc: boolean; id: string }[],
  columnId: string
): string => {
  const [cur] = sorting;
  if (cur?.id !== columnId) {
    return "";
  }
  return cur.desc ? " ▼" : " ▲";
};

// TanStack Table v9.2.4's header columnDef lacks getToggleSortingHandler (the
// v9 API gap); sorting is toggled manually below. See issue #115 migration notes.
export const JobsTable = ({
  jobs,
  onDelete,
}: {
  jobs: JobRow[];
  onDelete: (name: string) => void;
}) => {
  const [sorting, setSorting] = useState([{ desc: true, id: "created" }]);
  const [filter, setFilter] = useState("");

  const columns = useMemo(
    () => [
      col.accessor("created", {
        cell: (info) => (
          <span className="text-muted-foreground text-xs">
            {info.row.original.age}
          </span>
        ),
        header: "started",
        id: "created",
      }),
      col.accessor("kind", {
        cell: (info) => (
          <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
            {info.getValue()}
          </span>
        ),
        header: "kind",
      }),
      col.accessor("repo", {
        cell: (info) => (
          <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>
        ),
        header: "repo",
      }),
      col.accessor("issue", {
        cell: (info) =>
          info.getValue() === null ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <span className="font-mono text-xs">#{info.getValue()}</span>
          ),
        header: "issue",
      }),
      col.accessor("status", {
        cell: (info) => <Badge status={info.getValue()} />,
        header: "status",
      }),
      col.accessor("name", {
        cell: (info) => (
          <span className="text-muted-foreground font-mono text-xs">
            {info.getValue()}
          </span>
        ),
        header: "job",
      }),
      col.display({
        cell: (info) => {
          const s = info.row.original.status;
          if (s === "running") {
            return null;
          }
          return (
            <button
              onClick={() => onDelete(info.row.original.name)}
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded px-1.5 py-0.5 text-xs"
              title="delete completed job"
            >
              ✕
            </button>
          );
        },
        header: "",
        id: "actions",
      }),
    ],
    [onDelete]
  );

  const table = useTable<PanelTableFeatures, JobRow>({
    // The accessor helpers infer per-column TValue (string|null vs string…);
    // v9's ColumnDef union doesn't accept that mixed-TValue array under
    // exactOptionalPropertyTypes (optional `footer`/`meta` props), so the
    // array is erased to the cell-unknown variant at this one boundary.
    columns: columns as unknown as ColumnDef<
      PanelTableFeatures,
      JobRow,
      unknown
    >[],
    data: jobs,
    features,
    onGlobalFilterChange: setFilter,
    onSortingChange: setSorting,
    state: { globalFilter: filter, sorting },
  });

  return (
    <div className="space-y-2">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter by kind, repo, issue, status…"
        className="border-border bg-background placeholder:text-muted-foreground focus:border-primary w-full rounded-lg border px-3 py-1.5 text-sm outline-none"
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr
                key={hg.id}
                className="border-border text-muted-foreground border-b text-xs"
              >
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={() => {
                      const { id } = h.column;
                      setSorting((prev) => {
                        const [cur] = prev;
                        if (cur?.id !== id) {
                          return [{ desc: true, id }];
                        }
                        if (cur.desc !== false) {
                          return [{ desc: false, id }];
                        }
                        return [{ desc: true, id }];
                      });
                    }}
                    className="cursor-pointer px-2 py-2 font-medium select-none"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {sortIndicator(sorting, h.column.id)}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-border/50 hover:bg-muted/30 border-b"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-2 py-1.5">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="text-muted-foreground px-2 py-4 text-center text-sm"
                >
                  no matching jobs
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
