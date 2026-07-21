"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Stock-page tab bar (client island — needs `usePathname` to mark the active
 * tab). Overview / Chart / Dividends / Earnings / Ownership / Filings /
 * Financials. `base` is the security's route root, e.g. `/stocks/ADX/FAB`.
 *
 * Styling ported from StockHeader.dc.html's tab row: uppercase 11px mono-
 * weight labels (700 active / 600 inactive) at 0.12em tracking, on a shared
 * 1px hairline-strong rail; the active tab gets a 3px ink underline drawn as
 * an INSET box-shadow (the DC's `box-shadow: inset 0 -3px 0 #14120e`) so it
 * sits flush on the rail instead of adding to the tab's box height.
 *
 * NOTE (fidelity audit flag): the design's component library shows 5 tabs
 * (Overview / Financials / Filings & Concalls / Ownership & People / Quote &
 * Coverage) — this build ships 7 real features (Chart, Dividends and
 * Earnings are additional, and Filings/Ownership are split rather than
 * merged). Kept all 7 per the fix brief; the 5-vs-7 tab IA needs a lead call
 * on whether to consolidate labels or accept the wider set.
 */

const TABS = [
  { seg: "", label: "Overview" },
  { seg: "chart", label: "Chart" },
  { seg: "dividends", label: "Dividends" },
  { seg: "earnings", label: "Earnings" },
  { seg: "ownership", label: "Ownership" },
  { seg: "filings", label: "Filings" },
  { seg: "financials", label: "Financials" },
] as const;

export function StockTabs({ base }: { base: string }) {
  const pathname = usePathname() ?? base;
  // Strip trailing slash for a clean compare.
  const current = pathname.replace(/\/$/, "");

  return (
    <nav className="flex h-[42px] items-stretch gap-6 overflow-x-auto border-b border-hairline-strong">
      {TABS.map((t) => {
        const href = t.seg ? `${base}/${t.seg}` : base;
        const active = current === href.replace(/\/$/, "");
        return (
          <Link
            key={t.seg || "overview"}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex flex-none items-center font-ui text-[11px] tracking-[0.12em] uppercase transition-colors ${
              active
                ? "font-bold text-ink shadow-[inset_0_-3px_0_var(--color-ink)]"
                : "font-semibold text-ink-faint hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
