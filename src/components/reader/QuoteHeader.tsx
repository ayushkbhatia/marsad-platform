"use client";

import Link from "next/link";
import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import { FreshnessBadge, type FreshnessState } from "@/components/ui";
import { toBadgeState, type FreshnessBlock } from "@/lib/market/freshness";
import {
  fmtPrice,
  fmtSignedNum,
  fmtSignedPct,
  fmtClock,
  fmtCompact,
  venueName,
  sectorLabel,
  currencyLabel,
} from "@/lib/reader/format";

/**
 * Quote header client island. Seeded with the last cached quote + venue
 * freshness from the (cached, server) `getStockHeader`, then polls
 * `/api/pulse/quote?venue=&ticker=` via `usePulse` while the venue is open.
 *
 * ANATOMY (StockHeader.dc.html / screens/1g stock page — Saudi Aramco):
 *   1. Breadcrumb: Today / venue / sector, right-aligned ISIN · SEDOL · last-
 *      updated clock (mono).
 *   2. Identity + price, on a 2px ink rule: company name (Newsreader 36px) +
 *      ticker/venue/currency/SCORE chips + website link, against price +
 *      signed change + the freshness badge + an unwired action-button row.
 *   3. Day-stats strip: OPEN · DAY RANGE · 52W RANGE · MKT CAP · P/E · EPS ·
 *      DIV YIELD · FREE FLOAT.
 *
 * DATA HONESTY — this component intentionally does not fetch anything new.
 * `getStockHeader` (src/lib/data/stocks.ts) only selects identity + the
 * latest quote + venue freshness, so:
 *   - OPEN / DAY RANGE / 52W RANGE are LIVE — they're already on `QuoteLite`
 *     and ride the same poll as price.
 *   - `isin` / `sedol` / `website` / `score` / `rating` / `marketCap` /
 *     `freeFloatPct` are optional props with NO current caller wiring them
 *     (the layout only passes what `getStockHeader` already reads). They
 *     render "—" until a follow-up data-layer change adds the columns —
 *     this is a deliberate scope boundary, not an oversight (see BUILD-STATUS
 *     §7 for the ledger entry).
 *   - P/E (TTM), EPS (TTM) and DIV YIELD are financials/ratio-derived and
 *     PREMIUM-gated by product decision (see PremiumLock.tsx, ScreenerGrid's
 *     PREMIUM_COLS) — they always render the locked treatment here, never a
 *     number, regardless of props. This component never fetches a premium
 *     table.
 *   - The design shows an Arabic company name; the product is EN-only
 *     (marsad architecture decision), so it is intentionally omitted.
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
  /** Sector slug (securities.sector — FK to sectors.key), for the breadcrumb. */
  sector?: string | null;
  currency: string | null;
  initialQuote: QuoteLite | null;
  initialFreshness: FreshnessBlock | null;
  /** No current caller wires these — see the file-header DATA HONESTY note. */
  isin?: string | null;
  sedol?: string | null;
  website?: string | null;
  score?: number | null;
  /** Uppercase headline rating (public.v_scores_public.rating), e.g. "BUY". */
  rating?: string | null;
  marketCap?: number | null;
  freeFloatPct?: number | null;
}

/** Map a feed block to a badge state that can never read "live". */
function delayedState(block: FreshnessBlock | null): FreshnessState {
  if (!block) return "delayed";
  const s = toBadgeState(block.state);
  return s === "live" ? "delayed" : s;
}

/** Marker position (0–100) along a low→high range bar, or null if not computable. */
function rangePct(
  last: number | null | undefined,
  lo: number | null | undefined,
  hi: number | null | undefined,
): number | null {
  if (last == null || lo == null || hi == null || hi <= lo) return null;
  return Math.min(100, Math.max(0, ((last - lo) / (hi - lo)) * 100));
}

/** Day/52W range bar — thin track + diamond marker, ported from the DC. */
function RangeBar({ pct }: { pct: number | null }) {
  return (
    <div className="relative mt-3 h-[3px] bg-hairline-soft">
      {pct != null ? (
        <span
          className="absolute h-2 w-2 -translate-y-1/2 rotate-45 bg-ink"
          style={{ left: `${pct}%`, top: "1.5px" }}
        />
      ) : null}
    </div>
  );
}

/** Day-stats cell for a financials/ratio-derived stat — always locked, never a number. */
function PremiumStat({ label }: { label: string }) {
  return (
    <div>
      <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
        {label}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <span className="text-[10px] opacity-60" aria-hidden>
          🔒
        </span>
        <span className="font-mono text-[9px] font-semibold tracking-[0.1em] text-ink-faint uppercase">
          Premium
        </span>
      </div>
    </div>
  );
}

const ACTION_BTN = "cursor-not-allowed px-[11px] py-[6px] font-ui text-[10.5px] font-semibold";

export function QuoteHeader({
  venueCode,
  ticker,
  name,
  sector = null,
  currency,
  initialQuote,
  initialFreshness,
  isin = null,
  sedol = null,
  website = null,
  score = null,
  rating = null,
  marketCap = null,
  freeFloatPct = null,
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

  const dayPct = rangePct(quote?.last, quote?.low, quote?.high);
  const weekPct = rangePct(quote?.last, quote?.week52Low, quote?.week52High);
  const dayRangeLabel =
    quote?.low != null && quote?.high != null ? `${fmtPrice(quote.low)}–${fmtPrice(quote.high)}` : "—";
  const weekRangeLabel =
    quote?.week52Low != null && quote?.week52High != null
      ? `${fmtPrice(quote.week52Low)}–${fmtPrice(quote.week52High)}`
      : "—";

  return (
    <div className="flex flex-col">
      {/* Breadcrumb + ISIN/SEDOL/last-updated */}
      <div className="flex flex-wrap items-center gap-2 font-ui text-[11px] text-ink-muted">
        <Link href="/" className="underline underline-offset-[3px] hover:text-ink">
          Today
        </Link>
        <span className="text-[#a8a396]">/</span>
        <Link href="/markets" className="underline underline-offset-[3px] hover:text-ink">
          {venueName(venueCode)}
        </Link>
        <span className="text-[#a8a396]">/</span>
        <span>{sectorLabel(sector)}</span>
        <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-ink-faint uppercase">
          ISIN {isin ?? "—"} · SEDOL {sedol ?? "—"} · LAST UPDATED {clock ? `${clock} UTC` : "—"}
        </span>
      </div>

      {/* Identity + price, on the 2px ink rule */}
      <div className="mt-3 flex flex-col gap-4 border-b-2 border-ink pb-3.5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[36px] leading-none font-bold tracking-[-0.015em] text-ink">
            {name}
          </h1>
          <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
            <span className="border border-hairline-strong px-[7px] py-[2.5px] font-mono text-[9.5px] font-semibold text-ink">
              {ticker}
            </span>
            <span className="border border-hairline-strong px-[7px] py-[2.5px] font-mono text-[9.5px] text-ink-muted">
              {venueName(venueCode)}
              {cur ? ` · ${cur}` : ""}
            </span>
            <span className="bg-ink px-[7px] py-[2.5px] font-mono text-[9.5px] text-paper-tint">
              SCORE {score ?? "—"}
              {rating ? ` · ${rating.toUpperCase()}` : ""}
            </span>
            {website ? (
              <a
                href={website}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-[6px] text-[11px] text-ink-muted hover:text-ink"
              >
                {website.replace(/^https?:\/\//, "")} ↗
              </a>
            ) : (
              <span className="ml-[6px] text-[11px] text-ink-faint">—</span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex items-baseline gap-2.5">
            <span className="font-ui text-[36px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink">
              {fmtPrice(quote?.last)}
            </span>
            {cur ? <span className="font-ui text-[13px] text-ink-muted">{cur}</span> : null}
            <span className={`font-ui text-[14px] font-semibold tabular-nums ${chgColor}`}>
              {fmtSignedNum(chg)} ({fmtSignedPct(quote?.changePct)})
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FreshnessBadge
              state={state}
              surface="light"
              detail={clock ? `AS OF ${clock} UTC` : undefined}
            />
            {quote?.volume != null ? (
              <span className="font-mono text-[9.5px] text-ink-faint">
                · VOL {fmtCompact(quote.volume)}
              </span>
            ) : null}
            {!open ? (
              <span className="font-mono text-[9px] tracking-[0.1em] text-ink-faint uppercase">
                · Market closed
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-[7px]">
            <button type="button" disabled className={`${ACTION_BTN} border border-ink text-ink`}>
              + Watchlist
            </button>
            <button
              type="button"
              disabled
              className={`${ACTION_BTN} border border-hairline-strong text-ink-muted`}
            >
              Set alert
            </button>
            <button
              type="button"
              disabled
              className={`${ACTION_BTN} border border-hairline-strong text-ink-muted`}
            >
              Notebook
            </button>
            <button
              type="button"
              disabled
              className={`${ACTION_BTN} border border-hairline-strong text-ink-muted`}
            >
              Export XLSX
            </button>
            <button
              type="button"
              disabled
              className={`${ACTION_BTN} bg-ink font-bold tracking-[0.04em] text-paper-tint`}
            >
              + FOLLOW
            </button>
          </div>
        </div>
      </div>

      {/* Day-stats strip */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-hairline py-[13px] sm:grid-cols-4 lg:grid-cols-[1fr_1.5fr_1.5fr_1fr_1fr_1fr_1fr_1fr] lg:gap-[18px]">
        <div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">Open</div>
          <div className="mt-1 text-[13.5px] font-semibold tabular-nums text-ink">
            {fmtPrice(quote?.open)}
          </div>
        </div>
        <div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
            Day range {dayRangeLabel}
          </div>
          <RangeBar pct={dayPct} />
        </div>
        <div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
            52W {weekRangeLabel}
          </div>
          <RangeBar pct={weekPct} />
        </div>
        <div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">Mkt cap</div>
          <div className="mt-1 text-[13.5px] font-semibold tabular-nums text-ink">
            {marketCap != null ? `${cur ? `${cur} ` : ""}${fmtCompact(marketCap)}` : "—"}
          </div>
        </div>
        <PremiumStat label="P/E (TTM)" />
        <PremiumStat label="EPS (TTM)" />
        <PremiumStat label="Div yield" />
        <div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
            Free float
          </div>
          <div className="mt-1 text-[13.5px] font-semibold tabular-nums text-ink">
            {freeFloatPct != null ? `${freeFloatPct.toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
