import Link from "next/link";
import type { Mover } from "@/lib/data/markets";
import { fmtPrice, fmtSignedPct, venueName } from "@/lib/reader/format";

/**
 * Top-movers board (server component) — biggest gainers/losers across the public
 * universe, from `getTopMovers`. Pure presentation over already-fetched public
 * rows (no premium data). Each row links to the canonical stock page.
 */

function MoverRow({ m }: { m: Mover }) {
  const dir = (m.changePct ?? 0) > 0 ? 1 : (m.changePct ?? 0) < 0 ? -1 : 0;
  const chgColor = dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : "text-ink-muted";
  return (
    <li>
      <Link
        href={`/stocks/${m.venueCode}/${m.ticker}`}
        className="flex items-center gap-3 py-2 hover:bg-paper-tint"
      >
        <span className="flex w-[92px] flex-none items-center gap-1.5">
          <span className="font-mono text-[11px] font-semibold text-ink">{m.ticker}</span>
          <span className="font-mono text-[8px] tracking-[0.06em] text-ink-faint uppercase">
            {venueName(m.venueCode).split(" · ")[0]}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate font-ui text-[12px] text-ink-muted">{m.name}</span>
        <span className="flex-none font-mono text-[12px] tabular-nums text-ink">{fmtPrice(m.last)}</span>
        <span className={`w-[74px] flex-none text-right font-mono text-[12px] font-semibold tabular-nums ${chgColor}`}>
          {dir > 0 ? "▲" : dir < 0 ? "▼" : "·"} {fmtSignedPct(m.changePct)}
        </span>
      </Link>
    </li>
  );
}

function Column({ title, rows, empty }: { title: string; rows: Mover[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between border-b border-hairline pb-1.5">
        <h3 className="font-mono text-[10px] font-semibold tracking-[0.16em] text-ink-muted uppercase">
          {title}
        </h3>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center font-mono text-[10px] tracking-[0.06em] text-ink-faint uppercase">
          {empty}
        </p>
      ) : (
        <ul className="divide-y divide-hairline-faint">
          {rows.map((m) => (
            <MoverRow key={`${m.venueCode}-${m.ticker}`} m={m} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function TopMovers({
  gainers,
  losers,
}: {
  gainers: Mover[];
  losers: Mover[];
}) {
  return (
    <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
      <Column title="Top gainers" rows={gainers} empty="No advancers" />
      <Column title="Top decliners" rows={losers} empty="No decliners" />
    </div>
  );
}
