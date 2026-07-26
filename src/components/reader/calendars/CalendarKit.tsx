import Link from "next/link";
import type { ReactNode } from "react";
import type { Kpi, CalendarDay } from "@/lib/contracts/calendars";

/**
 * Shared calendar primitives (design 8a / 23a). `KpiStrip` is the bordered
 * 4-KPI band; `CalendarLedger` is the week-nav + per-day-bar + table pattern
 * both calendars render, parameterised by grid template + header cells +
 * `renderRow` (per the handoff's one-component note). Sample-driven.
 */
export function KpiStrip({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="mt-4 flex flex-wrap border border-hairline bg-paper-tint sm:flex-nowrap">
      {kpis.map((k, i) => (
        <div
          key={k.label}
          className={`flex-1 px-[18px] py-[13px] ${i < kpis.length - 1 ? "border-r border-hairline" : ""}`}
        >
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">{k.label}</div>
          <div
            className={`mt-1 font-display text-[26px] font-bold ${
              k.dir === "up" ? "text-positive" : k.dir === "down" ? "text-negative" : "text-ink"
            }`}
          >
            {k.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CalendarLedger<T>({
  weekLabel,
  footnote,
  gridCols,
  headers,
  days,
  renderRow,
  rowHref,
}: {
  weekLabel: string;
  footnote: string;
  gridCols: string;
  headers: ReactNode;
  days: CalendarDay<T>[];
  renderRow: (row: T) => ReactNode;
  rowHref?: (row: T) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">{weekLabel}</span>
        <span className="cursor-pointer border border-hairline-strong px-2 py-0.5 font-mono text-[9px] text-ink-muted">‹ PREV</span>
        <span className="cursor-pointer border border-hairline-strong px-2 py-0.5 font-mono text-[9px] text-ink-muted">NEXT ›</span>
        <span className="ml-auto font-mono text-[9px] text-ink-faint">{footnote}</span>
      </div>

      {days.map((d, di) => (
        <div key={d.label}>
          <div className={`flex flex-wrap items-baseline gap-3 bg-ink px-3 py-[7px] text-paper-tint ${di === 0 ? "mt-2.5" : "mt-3.5"}`}>
            <span className="font-mono text-[10px] font-semibold tracking-[0.1em]">{d.label}</span>
            <span className="font-mono text-[9px] text-[#a8a396]">{d.count}</span>
          </div>
          <div className={`grid ${gridCols} gap-2.5 border-b border-hairline px-3 pt-[7px] pb-[5px]`}>{headers}</div>
          {d.rows.map((r, ri) => {
            const cells = renderRow(r);
            const cls = `grid ${gridCols} items-center gap-2.5 border-b border-hairline-faint px-3 py-[9px] hover:bg-paper-tint`;
            return rowHref ? (
              <Link key={ri} href={rowHref(r)} className={cls}>
                {cells}
              </Link>
            ) : (
              <div key={ri} className={`${cls} cursor-pointer`}>
                {cells}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Mono column-header cell used by both calendars. */
export function ColHead({ label, align }: { label: string; align?: "right" | "center" }) {
  const a = align === "right" ? "text-right" : align === "center" ? "text-center" : "";
  const ink = label === "MARSAD";
  return (
    <span className={`font-mono text-[8px] tracking-[0.08em] uppercase ${ink ? "text-ink" : "text-ink-faint"} ${a}`}>
      {label}
    </span>
  );
}

/** Company cell with a small venue chip, shared across the calendars. */
export function CompanyCell({ company, venue }: { company: string; venue: string }) {
  return (
    <span className="flex items-baseline gap-[7px] overflow-hidden">
      <span className="truncate text-[12px] text-ink">{company}</span>
      <span className="flex-none border border-hairline-soft px-1 py-px font-mono text-[7.5px] text-ink-faint">{venue}</span>
    </span>
  );
}
