import type { Surface } from "@/components/ui/types";

export interface DataGapNoticeProps {
  /** Exact schema-qualified table/view names this section still needs. */
  tables: string[];
  note?: string;
  surface?: Surface;
  className?: string;
}

/**
 * Flags a section that cannot be data-backed yet because the tables it needs
 * live in a schema PostgREST does not route (`db-schemas` is locked to
 * `public, graphql_public` — 02-data-lake.md §1, confirmed via read-only SQL
 * 2026-07-21). The fix is a `public` wrapper view/RPC granted to
 * `service_role`, the pattern already shipped for `v_desk_approvals`,
 * `desk_approval_detail`, and `v_lake_landing_*` — a migration this pass is
 * scoped read-only and cannot add. Deliberately reuses `EmptyState`'s visual
 * vocabulary (border + mono kicker) rather than a new ui primitive.
 */
export function DataGapNotice({ tables, note, surface = "light", className = "" }: DataGapNoticeProps) {
  const dark = surface === "dark";
  return (
    <div
      className={`border-l-[3px] ${dark ? "border-dark-text bg-dark-panel" : "border-ink bg-paper-tint"} px-[13px] py-[11px] ${className}`}
    >
      <div
        className={`font-mono text-[8px] tracking-[0.14em] ${dark ? "text-dark-text-faint" : "text-ink-faint"}`}
      >
        NEEDS A MIGRATION — NOT POSTGREST-EXPOSED
      </div>
      <p className={`mt-1.5 font-ui text-[11px] leading-relaxed ${dark ? "text-dark-text-mid" : "text-ink-mid"}`}>
        {note ?? "This section reads tables outside the public schema."} A public wrapper view/RPC
        (service_role-granted — the pattern already shipped for v_desk_approvals / v_lake_landing_*)
        is needed for{" "}
        <span className={`font-mono ${dark ? "text-dark-text" : "text-ink"}`}>{tables.join(", ")}</span>.
      </p>
    </div>
  );
}
