"use client";

import { useEffect, useState } from "react";
import { FilingsList } from "./FilingsList";
import { usePulse, useMarketOpen } from "@/lib/hooks/usePulse";
import type { FilingItem } from "@/lib/data/filings";

/**
 * Newswire stream (client island). Seeded with the server's first faceted page
 * of filings, then appends newer items from `/api/pulse/wire?after=<cursor>` on
 * a 30s cadence while any venue is open. The `after` cursor is compared
 * server-side in SQL (never a JS date compare); the JS `getTime` sort here only
 * orders already-fetched rows for display.
 *
 * The facet params (`venue`, `type`) ride the poll URL so appended items honor
 * the same filter the server page rendered. No premium data is present in the
 * payload — filings metadata + AI summary only.
 */

interface WirePayload {
  items: FilingItem[];
  latest: string | null;
}

const t = (iso: string | null): number => {
  if (!iso) return 0;
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
};

export function WireStream({
  initial,
  venue,
  type,
  emptyLabel,
}: {
  initial: FilingItem[];
  venue?: string;
  type?: string;
  emptyLabel?: string;
}) {
  const open = useMarketOpen();
  const [items, setItems] = useState<FilingItem[]>(initial);
  // "Added since load" is derived — items only ever grows by prepending.
  const added = Math.max(0, items.length - initial.length);

  const latest = items.length ? items[0].filedAt : null;
  const { data } = usePulse<WirePayload>(
    "wire",
    { after: latest ?? undefined, venue, type },
    { enabled: open },
  );

  useEffect(() => {
    const fresh = data?.items ?? [];
    if (fresh.length === 0) return;
    // Defer the merge out of the synchronous effect body so its setState doesn't
    // cascade renders (react-hooks/set-state-in-effect) — same trick as usePulse.
    queueMicrotask(() => {
      setItems((prev) => {
        const seen = new Set(prev.map((f) => f.id));
        const add = fresh.filter((f) => !seen.has(f.id));
        if (add.length === 0) return prev;
        return [...add, ...prev].sort((a, b) => t(b.filedAt) - t(a.filedAt));
      });
    });
  }, [data]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between font-mono text-[10px] text-ink-faint">
        <span>
          {items.length.toLocaleString("en-US")} on the wire
          {added > 0 ? ` · +${added} since load` : ""}
        </span>
        <span className="tracking-[0.08em] uppercase">
          {open ? "Auto-updating · 30s" : "Updates paused · markets closed"}
        </span>
      </div>
      <FilingsList
        items={items}
        showTicker
        showSummary
        emptyLabel={emptyLabel ?? "No filings on the wire yet."}
      />
    </div>
  );
}
