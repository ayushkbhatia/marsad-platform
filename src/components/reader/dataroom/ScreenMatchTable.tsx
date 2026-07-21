import Link from "next/link";
import { DataTableRow } from "@/components/ui";
import { fmtPrice, fmtSignedPct } from "@/lib/reader/format";
import type { ScreenerRow } from "@/lib/data/screener";

/**
 * The `/screens/[screenId]` preview: `freeLimit` real rows (reused
 * `DataTableRow`, exactly the screener's row shape — no premium ratio ever
 * rendered), then a blurred taste of the next couple of matches under a CTA
 * to the full, unrestricted `/screener` run. The screener itself is NOT a paid
 * gate — everyone sees every row there — so the copy here says "see all N",
 * never "Premium"; only the ratio columns (P/E, P/B, ROE, yield) are premium,
 * and this table never has those columns to begin with.
 */
export function ScreenMatchTable({
  rows,
  total,
  screenerHref,
  freeLimit = 3,
}: {
  rows: ScreenerRow[];
  total: number;
  screenerHref: string;
  freeLimit?: number;
}) {
  const free = rows.slice(0, freeLimit);
  const teaser = rows.slice(freeLimit, freeLimit + 2);
  const remaining = total - free.length;

  const scoreText = (r: ScreenerRow) => (r.score != null ? `${r.score}${r.rating ? ` · ${r.rating}` : ""}` : "—");
  const dirOf = (r: ScreenerRow): "up" | "down" => ((r.changePct ?? 0) >= 0 ? "up" : "down");

  return (
    <div className="flex flex-col border border-dark-hairline bg-dark-panel">
      {free.map((r) => (
        <DataTableRow
          key={r.securityId}
          surface="dark"
          ticker={r.ticker}
          company={r.name}
          venue={r.venueCode}
          price={fmtPrice(r.last)}
          chg={fmtSignedPct(r.changePct)}
          dir={dirOf(r)}
          score={scoreText(r)}
        />
      ))}

      {remaining > 0 && (
        <div className="relative">
          <div className="pointer-events-none select-none opacity-70 blur-[3px]">
            {teaser.map((r) => (
              <DataTableRow
                key={r.securityId}
                surface="dark"
                ticker={r.ticker}
                company={r.name}
                venue={r.venueCode}
                price={fmtPrice(r.last)}
                chg={fmtSignedPct(r.changePct)}
                dir={dirOf(r)}
                score={scoreText(r)}
              />
            ))}
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-b from-dark-bg/10 to-dark-bg/95 px-4 text-center">
            <span className="font-mono text-[9px] font-semibold tracking-[0.12em] text-dark-text-mid uppercase">
              {remaining} more {remaining === 1 ? "match" : "matches"}
            </span>
            <Link
              href={screenerHref}
              className="bg-dark-text px-4 py-2 font-ui text-[11px] font-bold tracking-[0.06em] text-dark-bg uppercase no-underline"
            >
              See all {total.toLocaleString("en-US")} in Screener →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
