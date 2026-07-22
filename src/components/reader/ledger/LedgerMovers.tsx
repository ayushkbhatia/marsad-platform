import Link from "next/link";
import type { Mover } from "@/lib/data/markets";
import { fmtSignedPct } from "@/lib/reader/format";

/**
 * Ledger front page (1b) right-rail "Movers" section — ranked ticker + change
 * rows only (no name/price/venue), two columns side by side per 1b.
 *
 * This is a DELIBERATE separate component from `TopMovers` (the shared
 * gainers/decliners board used on `/markets`), not a restyle of it: `TopMovers`
 * is shared across routes, and its row (ticker chip + venue tag + name + price
 * + change, ~`min ~260px` before anything can shrink) is what overlaps once
 * squeezed into this page's ~360px rail column — `sm:grid-cols-2` forces two
 * columns at any viewport ≥640px regardless of the *container's* width, so on
 * the Ledger the two `TopMovers` columns collide well before that row content
 * can fit. Fixing `TopMovers` itself to fit a narrow rail would mean stripping
 * fields `/markets` still wants in its full-width column — out of scope for
 * this page. This component's rows carry only ticker + change, so they never
 * approach the column's width in the first place; `/markets` still renders
 * the untouched `TopMovers`.
 */

function Column({ title, rows, empty }: { title: string; rows: Mover[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-mono text-[9px] font-bold tracking-[0.16em] text-ink-faint uppercase">{title}</div>
      {rows.length === 0 ? (
        <p className="py-3 font-mono text-[9px] tracking-[0.06em] text-ink-faint uppercase">{empty}</p>
      ) : (
        <ul>
          {rows.map((m) => (
            <li key={`${m.venueCode}-${m.ticker}`} className="border-b border-hairline-faint last:border-b-0">
              <Link
                href={`/stocks/${m.venueCode}/${m.ticker}`}
                className="flex items-baseline gap-[7px] py-[5px] hover:bg-paper-tint"
              >
                <span className="min-w-0 truncate font-mono text-[9.5px] font-semibold text-ink">{m.ticker}</span>
                <span
                  className={`ml-auto flex-none font-mono text-[11px] font-semibold tabular-nums ${
                    (m.changePct ?? 0) < 0 ? "text-negative" : "text-positive"
                  }`}
                >
                  {fmtSignedPct(m.changePct)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LedgerMovers({ gainers, losers }: { gainers: Mover[]; losers: Mover[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 pt-2">
      <Column title="Gainers" rows={gainers} empty="No advancers" />
      <Column title="Losers" rows={losers} empty="No decliners" />
    </div>
  );
}
