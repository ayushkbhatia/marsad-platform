import Link from "next/link";
import type { FeedConnection, WireFeedItem, WireTicker } from "@/lib/contracts/newswire";

/**
 * Newswire (1d) centre column — the header (serif "The Wire" + WIRE / FILINGS
 * REGISTER pill-tabs + live count), a date divider, the feed-connection
 * banner (shown only when degraded), the feed itself (plain + "DEVELOPING"
 * variants, with optional inline ticker chips), and the "Load earlier items"
 * control.
 *
 * Sample-driven for the fidelity pass; the live-poll + keyset-paged real feed
 * (`WireStream`/`feed.ts`) re-wires onto `WireFeedItem[]` later
 * (DEF-NEWSWIRE-LIVE-DATA).
 */
function fmtPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function TickerChip({ t }: { t: WireTicker }) {
  return (
    <span className="flex items-baseline gap-1.5 border border-hairline px-2 py-[3px]">
      <span className="font-mono text-[9.5px] font-semibold text-ink">{t.symbol}</span>
      <span
        className={`text-[10px] font-semibold tabular-nums ${t.changePct < 0 ? "text-negative" : "text-positive"}`}
      >
        {fmtPct(t.changePct)}
      </span>
    </span>
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
        <div className="text-[12.5px] leading-[1.5] text-ink-muted">{item.summary}</div>
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
}: {
  todayCount: number;
  dateLabel: string;
  connection: FeedConnection;
  feed: WireFeedItem[];
}) {
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
        <span className="ml-auto font-mono text-[9.5px] tracking-[0.08em] text-positive">
          ● LIVE · {todayCount} TODAY
        </span>
      </div>

      {/* Date divider. */}
      <div className="pt-3 pb-1 font-mono text-[9.5px] tracking-[0.14em] text-ink-faint uppercase">
        {dateLabel}
      </div>

      {/* Feed-connection banner (degraded states only). */}
      {connection.state !== "live" && connection.message ? (
        <div className="mt-1 mb-0.5 flex items-center gap-[9px] border border-hairline border-l-[3px] border-l-caution bg-paper-tint px-3 py-2">
          <span className="h-[7px] w-[7px] flex-none rounded-full bg-caution" aria-hidden />
          <span className="text-[11.5px] text-ink-mid">{connection.message}</span>
          <span className="ml-auto font-mono text-[8.5px] text-ink-faint">{connection.detail}</span>
        </div>
      ) : null}

      {/* Feed. */}
      {feed.map((item) => (
        <FeedRow key={`${item.time}-${item.headline}`} item={item} />
      ))}

      {/* Pagination. */}
      <div className="flex justify-center pt-4">
        <span className="cursor-pointer border border-ink px-[22px] py-[9px] font-ui text-[11px] font-semibold tracking-[0.08em] uppercase hover:bg-ink hover:text-paper-tint">
          Load earlier items
        </span>
      </div>
    </div>
  );
}
