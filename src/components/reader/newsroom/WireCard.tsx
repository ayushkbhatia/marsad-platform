import Link from "next/link";
import { TickerChip } from "@/components/ui";
import type { NewsroomItemDetail } from "@/lib/data/newsroom";
import { newsroomItemHref } from "@/lib/data/newsroom";
import { fmtDateTime, fmtPrice } from "@/lib/reader/format";
import { WireCitedBody } from "./WireCitedBody";

/**
 * One published newsroom WIRE, card form — the Ledger's "From the newsroom"
 * lead section and `/wire`'s newsroom rail share this. Full body (WIRE is
 * never premium/gated — RLS already guarantees anon sees every block for a
 * live WIRE) with citation markers resolved via `WireCitedBody`.
 */
export function WireCard({ item }: { item: NewsroomItemDetail }) {
  const primary = item.tickers.find((t) => t.isPrimary) ?? item.tickers[0] ?? null;
  const href = newsroomItemHref(item);
  const retracted = item.status === "retracted";

  return (
    <article className="border border-hairline-faint bg-paper px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-ink px-1.5 py-px font-mono text-[8.5px] font-semibold tracking-[0.12em] text-paper-tint uppercase">
          Newsroom wire
        </span>
        {retracted ? (
          <span className="border border-negative px-1.5 py-px font-mono text-[8.5px] font-semibold tracking-[0.1em] text-negative uppercase">
            Retracted
          </span>
        ) : null}
        <span className="font-mono text-[9px] text-ink-faint">{fmtDateTime(item.publishedAt)}</span>
      </div>

      <Link
        href={href}
        className="mt-1.5 block text-balance font-display text-[17px] font-semibold leading-[1.3] text-ink hover:underline underline-offset-2"
      >
        {item.headline}
      </Link>

      {item.dek ? <p className="mt-1 font-ui text-[12.5px] leading-[1.5] text-ink-muted">{item.dek}</p> : null}

      {retracted && item.retractionNotice ? (
        <p className="mt-2 border-l-2 border-negative bg-paper-tint px-3 py-2 font-ui text-[11.5px] leading-[1.5] text-ink-mid">
          {item.retractionNotice}
        </p>
      ) : (
        <div className="mt-2.5">
          <WireCitedBody blocks={item.blocks} citations={item.citations} />
        </div>
      )}

      {primary ? (
        <div className="mt-3 flex items-center gap-2.5 border-t border-hairline-faint pt-2.5">
          <Link href={`/stocks/${primary.venueCode}/${primary.ticker}`} className="hover:underline underline-offset-2">
            <TickerChip
              code={primary.ticker}
              level={fmtPrice(primary.last)}
              chg={primary.changePct != null ? `${Math.abs(primary.changePct).toFixed(2)}%` : "—"}
              dir={primary.changePct != null && primary.changePct < 0 ? "down" : "up"}
              sparkline={false}
            />
          </Link>
          <span className="min-w-0 truncate font-ui text-[11px] text-ink-faint">{primary.name}</span>
        </div>
      ) : null}
    </article>
  );
}
