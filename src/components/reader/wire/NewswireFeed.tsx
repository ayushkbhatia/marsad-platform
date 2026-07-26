import Link from "next/link";
import type { FeedConnection, WireFeedItem, WireTicker } from "@/lib/contracts/newswire";
import { EmptyState } from "@/components/ui";

/**
 * Newswire (1d) centre column — the header (serif "The Wire" + WIRE / FILINGS
 * REGISTER pill-tabs + live count), a date divider, the feed-connection
 * banner (shown only when degraded), the feed itself (plain + "DEVELOPING"
 * variants, with optional inline ticker chips), and the "Load earlier items"
 * control.
 *
 * LIVE as of P2.2 — `adapters/newswire.ts` feeds it real `public.filings` rows.
 * Three honesty rules the real data forced, all of them contract-optional so
 * the sample still renders unchanged:
 *
 * - **The status chip states what the feed actually is.** It used to be a
 *   hardcoded green "● LIVE". All six venues are `closed` right now, so
 *   claiming LIVE would be the exact fabrication Law #2 forbids: the chip reads
 *   `connection.state` and only goes positive-green when the feed really is live.
 * - **Day dividers.** A real wire spans days (Tadawul's backfill reaches 2016),
 *   so `item.dayLabel` inserts a divider mid-feed; a single top-level
 *   `dateLabel` would mis-date every row below the first day.
 * - **Stable keys.** Real filing titles repeat heavily ("Daily Net Asset Value
 *   / NAV" 8× in one live page), so the row keys on `item.id` when present.
 */
function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function TickerChip({ t }: { t: WireTicker }) {
  const body = (
    <>
      <span className="font-mono text-[9.5px] font-semibold text-ink">{t.symbol}</span>
      <span
        className={`text-[10px] font-semibold tabular-nums ${t.changePct < 0 ? "text-negative" : "text-positive"}`}
      >
        {fmtPct(t.changePct)}
      </span>
    </>
  );
  const cls = "flex items-baseline gap-1.5 border border-hairline px-2 py-[3px]";
  // A chip inside a row-level <Link> cannot itself be an <a> (nested anchors are
  // invalid HTML and React will warn), so it stays a <span>; the row link already
  // reaches the filing, and the stock page is one hop from there.
  return <span className={cls}>{body}</span>;
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="pt-3 pb-1 font-mono text-[9.5px] tracking-[0.14em] text-ink-faint uppercase">
      {label}
    </div>
  );
}

function FeedRow({ item }: { item: WireFeedItem }) {
  const dev = item.isDeveloping;
  return (
    <Link
      href={item.href}
      className={`grid grid-cols-[46px_1fr] gap-3.5 border-b border-hairline-soft px-3 pt-3.5 pb-[15px] ${
        dev ? "border-l-[3px] border-l-ink bg-paper-tint" : "hover:bg-paper-tint"
      }`}
    >
      <span
        className={`font-mono text-[10.5px] ${dev ? "font-semibold text-ink" : "text-ink-faint"}`}
      >
        {item.time}
      </span>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {dev ? (
            <span className="bg-ink px-1.5 py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint">
              DEVELOPING
            </span>
          ) : null}
          <span className="border border-hairline-strong px-[5px] py-0.5 font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted">
            {item.venue}
          </span>
          <span className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint">{item.category}</span>
        </div>
        <div
          className={`font-display leading-[1.25] text-ink ${
            dev ? "text-[18.5px] font-bold" : "text-[17.5px] font-semibold"
          }`}
        >
          {item.headline}
        </div>
        {/* Only ~9% of live filings carry an `ai_summary`. No summary → no line,
            never a placeholder sentence. */}
        {item.summary ? (
          <div className="text-[12.5px] leading-[1.5] text-ink-muted">{item.summary}</div>
        ) : null}
        {item.tickers && item.tickers.length > 0 ? (
          <div className="flex gap-2">
            {item.tickers.map((t) => (
              <TickerChip key={t.symbol} t={t} />
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export function NewswireFeed({
  todayCount,
  dateLabel,
  connection,
  feed,
  olderHref,
}: {
  todayCount: number;
  dateLabel: string;
  connection: FeedConnection;
  feed: WireFeedItem[];
  olderHref?: string | null;
}) {
  const isLive = connection.state === "live";
  const statusLabel = isLive ? "LIVE" : connection.state.toUpperCase();

  return (
    <div>
      {/* Header. */}
      <div className="flex items-baseline gap-3 border-b-2 border-ink pb-2">
        <span className="font-display text-[23px] font-bold text-ink">The Wire</span>
        <span className="flex border border-hairline-strong">
          <span className="bg-ink px-3 py-[5px] font-ui text-[10px] font-bold tracking-[0.06em] text-paper-tint">
            WIRE
          </span>
          <Link
            href="/filings"
            className="px-3 py-[5px] font-ui text-[10px] font-semibold tracking-[0.06em] text-ink-muted hover:text-ink"
          >
            FILINGS REGISTER →
          </Link>
        </span>
        <span
          className={`ml-auto font-mono text-[9.5px] tracking-[0.08em] ${
            isLive ? "text-positive" : "text-caution-text"
          }`}
        >
          ● {statusLabel} · {todayCount} TODAY
        </span>
      </div>

      {/* Date divider (first day group). */}
      <DayDivider label={dateLabel} />

      {/* Feed-connection banner (degraded states only). */}
      {connection.state !== "live" && connection.message ? (
        <div className="mt-1 mb-0.5 flex items-center gap-[9px] border border-hairline border-l-[3px] border-l-caution bg-paper-tint px-3 py-2">
          <span className="h-[7px] w-[7px] flex-none rounded-full bg-caution" aria-hidden />
          <span className="text-[11.5px] text-ink-mid">{connection.message}</span>
          <span className="ml-auto font-mono text-[8.5px] text-ink-faint">{connection.detail}</span>
        </div>
      ) : null}

      {/* Feed. */}
      {feed.length === 0 ? (
        <EmptyState
          variant="awaitingFeed"
          title="No filings match this view"
          body="Clear the venue or category filter, or check back after the next exchange sweep."
        />
      ) : (
        feed.map((item, i) => (
          <div key={item.id ?? `${item.time}-${item.headline}-${i}`}>
            {item.dayLabel ? <DayDivider label={item.dayLabel} /> : null}
            <FeedRow item={item} />
          </div>
        ))
      )}

      {/* Pagination — keyset-paged by `filed_at` (see `adapters/newswire.ts`). */}
      {feed.length > 0 ? (
        <div className="flex justify-center pt-4">
          {olderHref ? (
            <Link
              href={olderHref}
              className="border border-ink px-[22px] py-[9px] font-ui text-[11px] font-semibold tracking-[0.08em] uppercase hover:bg-ink hover:text-paper-tint"
            >
              Load earlier items
            </Link>
          ) : (
            <span className="border border-hairline px-[22px] py-[9px] font-ui text-[11px] font-semibold tracking-[0.08em] text-ink-faint uppercase">
              End of the wire
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}
