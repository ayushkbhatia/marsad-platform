"use client";

import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import { fmtSignedPct, venueName } from "@/lib/reader/format";

/**
 * Index-tape strip client island (Markets + Ledger). Seeded server-side with
 * `getIndexTape()` and then polls `/api/pulse/indices` (60s) while any venue is
 * open, so the strip AUTO-LIGHTS the moment the index-levels producer starts
 * filling `public.index_levels`.
 *
 * `public.index_levels` is EMPTY today: every level comes back null and each
 * index renders its name with an honest "—" + "awaiting data" placeholder — it
 * NEVER fabricates a level or a change. Under scrape-only delayed data the tape
 * is a delayed tape; there is no "live" affordance here (S1 color law).
 */

export interface IndexTapeSeedItem {
  code: string;
  name: string;
  venueCode: string;
  level: number | null;
  change: number | null;
  changePct: number | null;
}

interface IndicesPayload {
  indices: Array<{
    code: string;
    name: string;
    venueCode: string;
    level: number | null;
    change: number | null;
    changePct: number | null;
  }>;
}

function fmtLevel(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function IndexTape({
  initial,
  venues,
}: {
  initial: IndexTapeSeedItem[];
  venues: string[];
}) {
  const open = useMarketOpen(venues);
  const { data } = usePulse<IndicesPayload>("indices", {}, { enabled: open });

  const byCode = new Map<string, IndexTapeSeedItem>();
  for (const it of initial) byCode.set(it.code, it);
  for (const it of data?.indices ?? []) {
    byCode.set(it.code, {
      code: it.code,
      name: it.name,
      venueCode: it.venueCode,
      level: it.level,
      change: it.change,
      changePct: it.changePct,
    });
  }
  const items = [...byCode.values()].sort((a, b) => a.venueCode.localeCompare(b.venueCode));

  if (items.length === 0) {
    return (
      <div className="border border-hairline bg-paper px-4 py-3 font-mono text-[11px] text-ink-faint">
        No index universe configured.
      </div>
    );
  }

  return (
    <div className="flex gap-0 overflow-x-auto border border-hairline bg-paper">
      {items.map((it) => {
        const has = it.level != null && Number.isFinite(it.level);
        const dir = (it.changePct ?? 0) > 0 ? 1 : (it.changePct ?? 0) < 0 ? -1 : 0;
        const chgColor = dir > 0 ? "text-positive" : dir < 0 ? "text-negative" : "text-ink-faint";
        return (
          <div
            key={it.code}
            className="flex min-w-[150px] flex-none flex-col gap-1 border-r border-hairline-faint px-4 py-2.5 last:border-r-0"
            title={it.name}
          >
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] font-semibold tracking-[0.02em] text-ink">
                {it.code}
              </span>
              <span className="font-mono text-[8px] tracking-[0.08em] text-ink-faint uppercase">
                {venueName(it.venueCode)}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[15px] tabular-nums text-ink">{fmtLevel(it.level)}</span>
              {has ? (
                <span className={`font-mono text-[10px] tabular-nums ${chgColor}`}>
                  {dir > 0 ? "▲" : dir < 0 ? "▼" : "·"} {fmtSignedPct(it.changePct)}
                </span>
              ) : (
                <span className="font-mono text-[8.5px] tracking-[0.1em] text-ink-faint uppercase">
                  awaiting data
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
