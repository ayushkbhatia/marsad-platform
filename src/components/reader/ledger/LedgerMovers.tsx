import Link from "next/link";
import type { MoverRow } from "@/lib/contracts/ledger";

/**
 * Ledger front page (1b) right-rail "Movers" section — two columns
 * (gainers / losers), ranked symbol + percent rows only. Sits under the
 * page's `SectionBar variant="rule"` "Movers" header.
 */
function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function Column({ title, rows }: { title: string; rows: MoverRow[] }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 font-ui text-[9px] font-bold tracking-[0.16em] text-ink-faint uppercase">
        {title}
      </div>
      <ul>
        {rows.map((m) => (
          <li key={m.symbol} className="border-b border-hairline-faint last:border-b-0">
            <Link href={m.href} className="flex items-baseline gap-[7px] py-[5px] hover:bg-paper-tint">
              <span className="min-w-0 truncate font-mono text-[9.5px] font-semibold text-ink">
                {m.symbol}
              </span>
              <span
                className={`ml-auto flex-none text-[11px] font-semibold tabular-nums ${
                  m.changePct < 0 ? "text-negative" : "text-positive"
                }`}
              >
                {fmtPct(m.changePct)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LedgerMovers({ gainers, losers }: { gainers: MoverRow[]; losers: MoverRow[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-5 pt-2">
      <Column title="Gainers" rows={gainers} />
      <Column title="Losers" rows={losers} />
    </div>
  );
}
