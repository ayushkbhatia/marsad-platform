"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import type { FilingItem } from "@/lib/data/filings";
import type { FreshnessBlock } from "@/lib/market/freshness";
import {
  filingToWireItem,
  groupWireFeedByDay,
  sortWireFeed,
  fmtSyncClock,
  type WireFeedItem,
} from "./wire/feed";
import { WireFeedList } from "./wire/WireFeedList";

/**
 * Newswire (1d) stream (client island). Seeded with the server's already
 * merged + sorted `WireFeedItem[]` (filings + the newsroom's own published
 * WIRE content, shaped by `@/components/reader/wire/feed.ts`), then appends
 * newer filings from `/api/pulse/wire?after=<cursor>` on a 30s cadence while
 * the relevant venue is open — the newsroom items are static (they aren't
 * part of the polled surface) and never move.
 *
 * Also renders the design's amber "reconnecting" banner straight off the
 * pulse payload's `freshness` block (never fabricated — it only appears once
 * the client has actually observed a `reconnecting` venue), the mono date
 * dividers grouping the merged feed by day, and the keyset "Load earlier
 * items" link (a plain navigation to `?cursor=`, same pattern as the
 * `/filings` register — paging into history pauses live polling and drops
 * the newsroom cards, since neither is meaningful mid-history).
 */

interface WirePayload {
  items: FilingItem[];
  latest: string | null;
  freshness?: FreshnessBlock[];
}

export function WireStream({
  initial,
  venue,
  type,
  cursor,
  nextCursor,
  emptyLabel,
}: {
  initial: WireFeedItem[];
  venue?: string;
  type?: string;
  cursor?: string;
  nextCursor?: string | null;
  emptyLabel?: string;
}) {
  const open = useMarketOpen(venue ? [venue] : undefined);
  const [items, setItems] = useState<WireFeedItem[]>(initial);
  const [freshness, setFreshness] = useState<FreshnessBlock[]>([]);

  // `items` is always kept sorted newest-first (every update below re-sorts
  // it), so the first filing-kind entry IS the latest filing — no need to
  // scan/compare dates again here.
  const latestFilingAt = items.find((i) => i.kind === "filing")?.filedAt ?? undefined;

  const { data } = usePulse<WirePayload>(
    "wire",
    { after: latestFilingAt, venue, type },
    { enabled: open && !cursor },
  );

  useEffect(() => {
    if (!data) return;
    // Deferred out of the synchronous effect body so its setState doesn't
    // cascade renders (react-hooks/set-state-in-effect) — same trick the
    // previous version of this island used.
    queueMicrotask(() => {
      const fresh = (data.items ?? []).map((f) => filingToWireItem(f, null));
      if (fresh.length > 0) {
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          const add = fresh.filter((i) => !seen.has(i.id));
          return add.length > 0 ? sortWireFeed([...add, ...prev]) : prev;
        });
      }
      if (data.freshness) setFreshness(data.freshness);
    });
  }, [data]);

  const groups = groupWireFeedByDay(items);
  const reconnecting = freshness.find((f) => f.state === "reconnecting" && (!venue || f.venue === venue));

  let earlierHref: string | null = null;
  if (nextCursor) {
    const p = new URLSearchParams();
    if (venue) p.set("venue", venue);
    if (type) p.set("type", type);
    p.set("cursor", nextCursor);
    earlierHref = `/wire?${p.toString()}`;
  }

  return (
    <div className="flex flex-col">
      {reconnecting ? (
        <div className="mt-1 mb-[2px] flex items-center gap-[9px] border border-hairline border-l-[3px] border-l-caution bg-paper-tint px-3 py-2">
          <span className="h-[7px] w-[7px] flex-none rounded-full bg-caution" aria-hidden />
          <span className="font-ui text-[11.5px] text-ink-mid">
            Reconnecting to the exchange feed — items may be delayed a few seconds.
          </span>
          <span className="ml-auto font-mono text-[8.5px] text-ink-faint uppercase">
            Last sync {fmtSyncClock(reconnecting.lastSync)} · Retrying…
          </span>
        </div>
      ) : null}

      <WireFeedList groups={groups} emptyLabel={emptyLabel} />

      {earlierHref ? (
        <div className="flex justify-center pt-4">
          <Link
            href={earlierHref}
            className="border border-ink px-[22px] py-[9px] font-ui text-[11px] font-semibold tracking-[0.08em] text-ink uppercase hover:bg-paper-tint"
          >
            Load earlier items
          </Link>
        </div>
      ) : null}
    </div>
  );
}
