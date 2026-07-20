"use client";

import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import { FreshnessBadge, type FreshnessState } from "@/components/ui";
import { toBadgeState, type FreshnessBlock } from "@/lib/market/freshness";
import {
  fmtPrice,
  fmtSignedNum,
  fmtSignedPct,
  fmtClock,
  venueName,
  currencyLabel,
} from "@/lib/reader/format";

/**
 * Quote header client island. Seeded with the last cached quote + venue
 * freshness from the (cached, server) `getStockHeader`, then polls
 * `/api/pulse/quote?venue=&ticker=` via `usePulse` while the venue is open.
 *
 * Honesty rules (S1 color law / scrape-only delayed data):
 *  - Polling is gated on `useMarketOpen([venue])` — when the venue is closed we
 *    stop polling and keep showing the last cached quote.
 *  - The freshness badge NEVER reads "live": a `live` feed state is floored to
 *    `delayed` here, because the product is 15-minute delayed by decision. A
 *    `halted` feed still surfaces as HALTED.
 */

interface QuoteLite {
  last: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  vwap: number | null;
  week52High: number | null;
  week52Low: number | null;
  asOf: string | null;
  delayMinutes: number | null;
  tickDir: number | null;
}

interface PulsePayload {
  quote: QuoteLite | null;
  freshness: FreshnessBlock | null;
}

export interface QuoteHeaderProps {
  venueCode: string;
  ticker: string;
  name: string;
  currency: string | null;
  initialQuote: QuoteLite | null;
  initialFreshness: FreshnessBlock | null;
}

/** Map a feed block to a badge state that can never read "live". */
function delayedState(block: FreshnessBlock | null): FreshnessState {
  if (!block) return "delayed";
  const s = toBadgeState(block.state);
  return s === "live" ? "delayed" : s;
}

export function QuoteHeader({
  venueCode,
  ticker,
  name,
  currency,
  initialQuote,
  initialFreshness,
}: QuoteHeaderProps) {
  const open = useMarketOpen([venueCode]);
  const { data } = usePulse<PulsePayload>(
    "quote",
    { venue: venueCode, ticker },
    { enabled: open },
  );

  const quote = data?.quote ?? initialQuote;
  const freshness = data?.freshness ?? initialFreshness;
  const cur = currencyLabel(currency);

  const chg = quote?.change ?? null;
  const dir = chg == null ? 0 : chg > 0 ? 1 : chg < 0 ? -1 : 0;
  const chgColor = dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : "text-ink-muted";
  const state = delayedState(freshness);
  const clock = fmtClock(quote?.asOf);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      {/* Identity */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[12px] font-semibold tracking-[0.04em] text-ink">
            {ticker}
          </span>
          <span className="border border-hairline-soft px-[5px] py-px font-mono text-[8.5px] tracking-[0.08em] text-ink-faint">
            {venueName(venueCode)}
          </span>
        </div>
        <h1 className="mt-1 truncate font-display text-heading font-bold text-ink">
          {name}
        </h1>
      </div>

      {/* Price + delayed freshness */}
      <div className="flex flex-col items-start gap-1.5 sm:items-end">
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[30px] font-semibold leading-none tabular-nums text-ink">
            {fmtPrice(quote?.last)}
          </span>
          {cur ? (
            <span className="font-mono text-[11px] text-ink-faint">{cur}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-[13px] font-semibold tabular-nums ${chgColor}`}>
            {dir > 0 ? "▲" : dir < 0 ? "▼" : "·"} {fmtSignedNum(chg)} ({fmtSignedPct(quote?.changePct)})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <FreshnessBadge
            state={state}
            surface="light"
            detail={clock ? `AS OF ${clock} UTC` : undefined}
          />
          {!open ? (
            <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
              · Market closed
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
