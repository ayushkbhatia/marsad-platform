"use client";

import { useEffect, useState } from "react";
import { TickerChip } from "@/components/ui";
import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import { fmtPrice } from "@/lib/reader/format";

/**
 * Row 1 of the desktop masthead (`MarsadNav`, ~34px) — the GCC headline
 * index levels as compact `TickerChip` cells (code + level + change, no
 * sparkline), plus the DELAYED indicator sitting in the design's row-1 clock
 * slot (`MarsadNav.dc.html` renders a live "LIVE · HH:MM GST" clock there;
 * Marsad is scrape-only delayed data, so the honest badge lives in that same
 * position instead — S1 color law, never "live").
 *
 * SERVER-SEEDED + polling. `MarsadNav` passes a server-read `initial` snapshot
 * (the same `getIndexTape` the home rail uses) so the first paint carries REAL
 * levels; the strip then polls `/api/pulse/indices` on the surface's 60s cadence
 * REGARDLESS of market hours, because off-session the nav should keep showing
 * the last known close. The endpoint is edge-cached (`s-maxage=55`), so
 * continuous polling from every tab is cheap.
 *
 * `public.index_levels` can be empty for a given index — each cell then
 * renders an honest "awaiting data" placeholder instead of a fabricated
 * level/direction (same law as `IndexTape`). It NEVER falls back to sample
 * levels: doing so put a fake TASI print in the served HTML on every render.
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

function IndexCell({ item, muted }: { item: IndicesIndexItem; muted?: boolean }) {
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

  // Market-closed (design 16c): the levels are the prior session's close, not
  // live — desaturate to grey and drop the up/down colour so the strip never
  // reads as a live tape off-session.
  if (muted) {
    return (
      <span className="inline-flex flex-none items-baseline gap-[7px] whitespace-nowrap font-ui">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.04em] text-ink-faint">
          {item.code}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-ink-faint">{fmtPrice(item.level, 2)}</span>
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

function LiveClock({ open }: { open: boolean }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // First value on the next frame (not synchronously in the effect body) so
    // the bare server render and first client render still agree.
    const raf = requestAnimationFrame(() => setNow(new Date()));
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);

  // Market-closed (design 16c): the clock chip stops reading "LIVE" and the dot
  // goes grey — the strip beside it is a prior close, so "live" would be a lie.
  const dot = open ? "bg-positive" : "bg-ink-faint";
  const prefix = open ? "LIVE" : "CLOSED";
  return (
    <div className="ml-auto flex flex-none items-center gap-2 pl-4">
      <span className={`h-[6px] w-[6px] flex-none rounded-full ${dot}`} aria-hidden />
      <span className="font-mono text-[10px] tracking-[0.08em] whitespace-nowrap text-ink-muted">
        {now ? `${prefix} · ${fmtGst(now)}` : prefix}
      </span>
    </div>
  );
}

export function NavIndexStrip({ initial = [] }: { initial?: IndicesIndexItem[] }) {
  const { data } = usePulse<IndicesPayload>("indices");
  const open = useMarketOpen();
  // SERVER-SEEDED, never sampled. This strip used to fall back to
  // `SAMPLE_INDICES` whenever the client poll had not resolved — which is every
  // server render — so the masthead shipped FABRICATED index levels in the HTML
  // (TASI 11,842.60 against a real 10,804) and only corrected after hydration.
  // `index_levels` has 4,261 rows and reports on a 10-minute timer, so the
  // honest seed is the same server read the page rail uses; the poll then keeps
  // it fresh. If neither has data the strip renders nothing rather than a lie.
  const live = data?.indices ?? [];
  const source: IndicesIndexItem[] = live.length > 0 ? live : initial;
  const items = [...source].sort((a, b) => a.venueCode.localeCompare(b.venueCode));

  return (
    <div className="h-[34px] border-b border-hairline">
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-6 overflow-x-auto px-7">
        {items.map((it) => (
          <IndexCell key={it.code} item={it} muted={!open} />
        ))}
        <LiveClock open={open} />
      </div>
    </div>
  );
}
