"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Stock-page tab bar (client island — needs `usePathname` to mark the active
 * tab). Overview / Chart / Dividends / Earnings / Ownership / Filings /
 * Financials. `base` is the security's route root, e.g. `/stocks/ADX/FAB`.
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
    <nav className="-mb-px flex gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const href = t.seg ? `${base}/${t.seg}` : base;
        const active = current === href.replace(/\/$/, "");
        return (
          <Link
            key={t.seg || "overview"}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap border-b-2 px-3.5 py-2.5 font-ui text-[12.5px] transition-colors ${
              active
                ? "border-ink font-semibold text-ink"
                : "border-transparent text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
