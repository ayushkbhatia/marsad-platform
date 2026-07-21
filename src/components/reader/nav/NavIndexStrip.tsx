"use client";

import { TickerChip } from "@/components/ui";
import { usePulse } from "@/lib/hooks/usePulse";
import { fmtPrice } from "@/lib/reader/format";

/**
 * Row 1 of the desktop masthead (`MarsadNav`, ~34px) — the GCC headline
 * index levels as compact `TickerChip` cells (code + level + change, no
 * sparkline), plus the DELAYED indicator sitting in the design's row-1 clock
 * slot (`MarsadNav.dc.html` renders a live "LIVE · HH:MM GST" clock there;
 * Marsad is scrape-only delayed data, so the honest badge lives in that same
 * position instead — S1 color law, never "live").
 *
 * Self-contained by design (no server seed from the layout): unlike the
 * page-level `IndexTape` — which is hydrated with a server-fetched `initial`
 * snapshot and only polls while a venue is open — this strip has no seed, so
 * it fetches `/api/pulse/indices` immediately on mount and keeps polling at
 * the surface's 60s cadence REGARDLESS of market hours. Off-session it would
 * otherwise render nothing at all, and the nav needs to keep showing the
 * last known levels. The endpoint is edge-cached (`s-maxage=55`), so
 * continuous polling from every tab is cheap.
 *
 * `public.index_levels` can be empty for a given index — each cell then
 * renders an honest "awaiting data" placeholder instead of a fabricated
 * level/direction (same law as `IndexTape`).
 */

interface IndicesIndexItem {
  code: string;
  venueCode: string;
  level: number | null;
  changePct: number | null;
}

interface IndicesPayload {
  indices: IndicesIndexItem[];
}

function fmtChgMag(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.abs(n).toFixed(2)}%`;
}

function IndexCell({ item }: { item: IndicesIndexItem }) {
  const has = item.level != null && Number.isFinite(item.level);

  if (!has) {
    return (
      <span className="inline-flex flex-none items-baseline gap-[7px] whitespace-nowrap font-ui">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.04em] text-ink">
          {item.code}
        </span>
        <span className="font-mono text-[9px] tracking-[0.08em] text-ink-faint uppercase">
          awaiting data
        </span>
      </span>
    );
  }

  return (
    <span className="flex-none">
      <TickerChip
        code={item.code}
        level={fmtPrice(item.level, 2)}
        chg={fmtChgMag(item.changePct)}
        dir={(item.changePct ?? 0) < 0 ? "down" : "up"}
        sparkline={false}
      />
    </span>
  );
}

export function NavIndexStrip() {
  const { data } = usePulse<IndicesPayload>("indices");
  const items = [...(data?.indices ?? [])].sort((a, b) =>
    a.venueCode.localeCompare(b.venueCode),
  );

  return (
    <div className="h-[34px] border-b border-hairline">
      <div className="mx-auto flex h-full max-w-[1180px] items-center gap-6 overflow-x-auto px-7">
        {items.map((it) => (
          <IndexCell key={it.code} item={it} />
        ))}
        <div className="ml-auto flex flex-none items-center gap-2 pl-4">
          <span className="h-[6px] w-[6px] flex-none rounded-full bg-caution" aria-hidden />
          <span
            className="font-mono text-[10px] tracking-[0.08em] text-ink-muted"
            title="All market data is delayed at least 15 minutes — scrape-only, never live"
          >
            DELAYED 15 MIN
          </span>
        </div>
      </div>
    </div>
  );
}
