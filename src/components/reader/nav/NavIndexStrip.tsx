"use client";

import { useEffect, useState } from "react";
import { TickerChip } from "@/components/ui";
import { usePulse } from "@/lib/hooks/usePulse";
import { fmtPrice } from "@/lib/reader/format";
import { SAMPLE_INDICES } from "@/lib/data/sample/ledger";

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

/** Live GST wall clock for the masthead row-1 right slot — the design 1b
 *  `LIVE · HH:MM GST · DDD D MMM YYYY` treatment. Owner-directed 2026-07-22 to
 *  show LIVE here (overriding the earlier never-live nav convention); GST is
 *  fixed UTC+4 (Asia/Dubai, no DST). Time is client-only (starts as bare
 *  "LIVE" so server + first client render agree, then fills in after mount —
 *  no hydration mismatch). */
function fmtGst(d: Date): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
    .format(d)
    .toUpperCase()
    .replace(/,/g, "");
  return `${time} GST · ${date}`;
}

function LiveClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // First value on the next frame (not synchronously in the effect body) so
    // the bare-"LIVE" server render and first client render still agree.
    const raf = requestAnimationFrame(() => setNow(new Date()));
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  return (
    <div className="ml-auto flex flex-none items-center gap-2 pl-4">
      <span className="h-[6px] w-[6px] flex-none rounded-full bg-positive" aria-hidden />
      <span className="font-mono text-[10px] tracking-[0.08em] whitespace-nowrap text-ink-muted">
        {now ? `LIVE · ${fmtGst(now)}` : "LIVE"}
      </span>
    </div>
  );
}

export function NavIndexStrip() {
  const { data } = usePulse<IndicesPayload>("indices");
  // Until `public.index_levels` is filling, the pulse comes back empty; fall
  // back to the representative sample strip so the masthead ticker renders
  // (design 1b). Live levels override the moment they arrive.
  const live = data?.indices ?? [];
  const source: IndicesIndexItem[] =
    live.length > 0
      ? live
      : SAMPLE_INDICES.map((i) => ({
          code: i.code,
          venueCode: i.venueCode,
          level: i.level,
          changePct: i.changePct,
        }));
  const items = [...source].sort((a, b) => a.venueCode.localeCompare(b.venueCode));

  return (
    <div className="h-[34px] border-b border-hairline">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-6 overflow-x-auto px-7">
        {items.map((it) => (
          <IndexCell key={it.code} item={it} />
        ))}
        <LiveClock />
      </div>
    </div>
  );
}
