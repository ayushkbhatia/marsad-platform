import Link from "next/link";
import type { ArticleTickerRailItem } from "@/lib/data/editorial";
import { fmtSignedPct } from "@/lib/reader/format";

/**
 * "In this piece" ticker rail (server component) — the article aside's list
 * of every security tagged via `content_tickers`, primary ticker first, with
 * the latest delayed change% from `quotes_latest`.
 */
export function TickerRail({ tickers }: { tickers: ArticleTickerRailItem[] }) {
  if (tickers.length === 0) return null;

  return (
    <div className="border border-hairline-strong px-4 py-3.5">
      <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
        In this piece
      </span>
      <ul className="mt-1">
        {tickers.map((t) => {
          const up = t.changePct != null && t.changePct > 0;
          const down = t.changePct != null && t.changePct < 0;
          return (
            <li
              key={t.securityId}
              className="flex items-baseline gap-2.5 border-b border-hairline-faint py-2 last:border-b-0"
            >
              <Link
                href={`/stocks/${t.venueCode}/${t.ticker}`}
                className="w-[54px] flex-none font-mono text-[10.5px] font-semibold text-ink hover:underline underline-offset-2"
              >
                {t.ticker}
              </Link>
              <span className="min-w-0 flex-1 truncate font-ui text-[11.5px] text-ink-mid">{t.name}</span>
              <span
                className={`flex-none font-mono text-[11px] font-semibold tabular-nums ${
                  up ? "text-positive" : down ? "text-negative" : "text-ink-faint"
                }`}
              >
                {fmtSignedPct(t.changePct)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
