import Link from "next/link";
import { TickerChip } from "@/components/ui";
import { fmtClock, fmtPrice } from "@/lib/reader/format";
import type { WireFeedGroup, WireFeedItem } from "./feed";

/**
 * The /wire (1d) center feed: mono date dividers grouping a day's items,
 * each rendered as a plain filing row or (for newsroom-authored wires) the
 * bordered/badged "DEVELOPING" row. Pure presentation over an already-shaped
 * `WireFeedGroup[]` — `WireStream` owns the live-polling + merge/sort/group.
 */

function VenueBadge({ code }: { code: string | null }) {
  if (!code) return null;
  return (
    <span className="flex-none border border-hairline-strong px-[5px] py-[2px] font-mono text-[8.5px] font-semibold tracking-[0.08em] text-ink-muted uppercase">
      {code}
    </span>
  );
}

function WireItemRow({ item }: { item: WireFeedItem }) {
  const developing = item.variant === "developing";
  return (
    <div
      className={`grid grid-cols-[46px_1fr] gap-x-[14px] border-b border-hairline-soft pt-[14px] pr-3 pb-[15px] pl-3 ${
        developing ? "border-l-[3px] border-l-ink bg-paper-tint" : ""
      }`}
    >
      <span
        className={`font-mono text-[10.5px] ${developing ? "font-semibold text-ink" : "text-ink-faint"}`}
      >
        {fmtClock(item.filedAt)}
      </span>

      <div className="flex min-w-0 flex-col gap-[6px]">
        <div className="flex flex-wrap items-center gap-2">
          {developing ? (
            <span className="flex-none bg-ink px-[6px] py-[2.5px] font-mono text-[8.5px] font-semibold tracking-[0.1em] text-paper-tint uppercase">
              Developing
            </span>
          ) : null}
          <VenueBadge code={item.venueCode} />
          <span className="font-mono text-[8.5px] tracking-[0.08em] text-ink-faint uppercase">
            {item.category}
          </span>
        </div>

        <Link
          href={item.href}
          className={`block text-balance font-display leading-[1.25] text-ink hover:underline underline-offset-2 ${
            developing ? "text-[18.5px] font-bold" : "text-[17.5px] font-semibold"
          }`}
        >
          {item.headline}
        </Link>

        {item.summary ? (
          <p className="font-ui text-[12.5px] leading-[1.5] text-ink-muted">{item.summary}</p>
        ) : null}

        {item.ticker ? (
          <div className="flex flex-wrap gap-2">
            <TickerChip
              code={item.ticker.code}
              level={fmtPrice(item.ticker.last)}
              chg={item.ticker.changePct != null ? `${Math.abs(item.ticker.changePct).toFixed(2)}%` : "—"}
              dir={item.ticker.changePct != null && item.ticker.changePct < 0 ? "down" : "up"}
              sparkline={false}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WireFeedList({
  groups,
  emptyLabel = "No items on the wire yet.",
}: {
  groups: WireFeedGroup[];
  emptyLabel?: string;
}) {
  if (groups.length === 0) {
    return (
      <div className="border border-dashed border-hairline px-4 py-10 text-center font-ui text-[13px] text-ink-faint">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div>
      {groups.map((g) => (
        <div key={g.key}>
          <div className="pt-3 pb-1 font-mono text-[9.5px] tracking-[0.14em] text-ink-faint uppercase">
            {g.label}
          </div>
          {g.items.map((item) => (
            <WireItemRow key={item.id} item={item} />
          ))}
        </div>
      ))}
    </div>
  );
}
