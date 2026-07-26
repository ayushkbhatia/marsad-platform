"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { StockHeader as HeaderData } from "@/lib/contracts/stock";

/**
 * Stock workspace shared header (design 3a–3d) — breadcrumb + IDs, the
 * name / ticker / Score chips + price block + action buttons, and the workspace
 * tab bar with a Standalone/Consolidated toggle. Rendered once by the stock
 * segment layout; the active tab is derived from the path.
 *
 * REAL DATA as of bridge P1: the layout resolves the security and feeds this a
 * `StockHeader` contract built by `lib/data/adapters/stock-header.ts`.
 * Fields with no column behind them degrade honestly rather than rendering an
 * empty chip — `nameAr` (no `name_ar` column) and the Score (only 538 of 762
 * securities are scored) are omitted entirely when absent.
 *
 * The action row (+ Watchlist / Set alert / Notebook / Export / + FOLLOW) stays
 * inert: those are MEMBER features with no per-user store until bridge P6.
 */
/**
 * `chart`, `earnings` and `dividends` are REAL-data routes that already existed
 * and were simply missing from this bar — they were unreachable from the UI
 * despite being in the sitemap. (The orphaned `components/reader/StockTabs.tsx`
 * carried the correct set and has been deleted in favour of this one.)
 */
const TABS = [
  { key: "overview", label: "Overview", seg: "" },
  { key: "financials", label: "Financials", seg: "financials" },
  { key: "chart", label: "Chart", seg: "chart" },
  { key: "filings", label: "Filings & Concalls", seg: "filings" },
  { key: "earnings", label: "Earnings", seg: "earnings" },
  { key: "dividends", label: "Dividends", seg: "dividends" },
  { key: "ownership", label: "Ownership & People", seg: "ownership" },
  { key: "thesis", label: "AI Thesis", seg: "thesis" },
] as const;

export function StockHeader({ header, base }: { header: HeaderData; base: string }) {
  const pathname = usePathname();
  const activeSeg = pathname === base ? "" : pathname.slice(base.length + 1).split("/")[0];

  return (
    <div className="bg-paper px-7 pt-4">
      {/* Breadcrumb + IDs. */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        {header.breadcrumb.map((c, i) => (
          <span key={c} className="flex items-center gap-2">
            {i < header.breadcrumb.length - 1 ? (
              <span className="cursor-pointer underline underline-offset-[3px]">{c}</span>
            ) : (
              <span>{c}</span>
            )}
            {i < header.breadcrumb.length - 1 ? <span className="text-[#a8a396]">/</span> : null}
          </span>
        ))}
        <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-ink-faint">{header.ids}</span>
      </div>

      {/* Identity + price. */}
      <div className="grid grid-cols-1 gap-8 border-b-2 border-ink py-3 lg:grid-cols-[1fr_auto]">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-display text-[36px] font-bold leading-none tracking-[-0.015em] text-ink">
              {header.name}
            </span>
            {header.nameAr ? (
              <span className="font-arabic text-[19px] text-ink-muted">{header.nameAr}</span>
            ) : null}
          </div>
          <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
            <span className="border border-hairline-strong px-[7px] py-[2.5px] font-mono text-[9.5px] font-semibold text-ink">
              {header.ticker}
            </span>
            <span className="border border-hairline-strong px-[7px] py-[2.5px] font-mono text-[9.5px] text-ink-muted">
              {header.venueLabel}
            </span>
            {header.score.label ? (
              <span className="bg-ink px-[7px] py-[2.5px] font-mono text-[9.5px] text-paper-tint">
                SCORE {header.score.value} · {header.score.label}
              </span>
            ) : null}
            {header.links.map((l) => (
              <span key={l} className="ml-1 text-[11px] text-ink-muted">
                {l}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <div className="flex items-baseline gap-2.5">
            <span className="text-[36px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink">
              {header.price}
            </span>
            <span className="text-[13px] text-ink-muted">{header.currency}</span>
            <span
              className={`text-[14px] font-semibold tabular-nums ${header.change.up ? "text-positive" : "text-negative"}`}
            >
              {header.change.value}
            </span>
          </div>
          <div className="flex flex-wrap gap-[7px]">
            <span className="cursor-pointer border border-ink px-[11px] py-1.5 text-[10.5px] font-semibold text-ink">
              + Watchlist
            </span>
            {["Set alert", "Notebook", "Export XLSX"].map((a) => (
              <span
                key={a}
                className="cursor-pointer border border-hairline-strong px-[11px] py-1.5 text-[10.5px] font-semibold text-ink-muted"
              >
                {a}
              </span>
            ))}
            <span className="cursor-pointer bg-ink px-3 py-1.5 text-[10.5px] font-bold tracking-[0.04em] text-paper-tint">
              + FOLLOW
            </span>
          </div>
        </div>
      </div>

      {/* Workspace tab bar. */}
      <div className="flex items-stretch gap-6 overflow-x-auto border-b border-hairline-strong">
        {TABS.map((t) => {
          const active = activeSeg === t.seg;
          const cls = `flex h-[42px] flex-none items-center text-[11px] font-${active ? "bold" : "semibold"} tracking-[0.12em] uppercase ${
            active ? "text-ink shadow-[inset_0_-3px_0_var(--color-ink)]" : "text-ink-faint hover:text-ink"
          }`;
          return (
            <Link key={t.key} href={t.seg ? `${base}/${t.seg}` : base} className={cls}>
              {t.label}
            </Link>
          );
        })}
        <div className="ml-auto flex flex-none items-center gap-1.5 self-center">
          <span className="cursor-pointer border border-hairline-strong px-2 py-[3px] text-[9px] font-bold tracking-[0.1em] text-ink-muted">
            STANDALONE
          </span>
          <span className="cursor-pointer bg-ink px-2 py-[3px] text-[9px] font-bold tracking-[0.1em] text-paper-tint">
            CONSOLIDATED
          </span>
        </div>
      </div>
    </div>
  );
}
