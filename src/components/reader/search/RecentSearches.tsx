"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * 16a "Recent searches" chips. Client-side `localStorage` only — deliberately
 * NOT backed by `public.search_history` (04-reader-app.md §6 specs a per-user,
 * 20-capped DB table, but that needs an authenticated dynamic write path this
 * anon-cacheable slice doesn't have; see the migration header note and
 * `docs/BUILD-STATUS.md` §7 DEF-SEARCH-HISTORY). This is a client leaf by
 * necessity (localStorage is a browser-only API), not a style choice.
 */

const STORAGE_KEY = "marsad:recentSearches";
const MAX_ITEMS = 6;

function readStored(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeStored(list: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode / storage disabled — recents are best-effort only.
  }
}

export function RecentSearches({ current }: { current: string }) {
  const [items, setItems] = useState<string[]>([]);

  useEffect(() => {
    // localStorage is client-only, so this genuinely belongs in an effect —
    // but the setState is deferred out of the synchronous effect body so it
    // cannot cascade a second render pass (react-hooks/set-state-in-effect).
    // Same pattern as the deferred first tick in `lib/hooks/usePulse.ts`.
    queueMicrotask(() => {
      const existing = readStored();
      const withoutCurrent = existing.filter((q) => q.toLowerCase() !== current.toLowerCase());
      const next = current ? [current, ...withoutCurrent].slice(0, MAX_ITEMS) : existing;
      if (current) writeStored(next);
      setItems(next.filter((q) => q.toLowerCase() !== current.toLowerCase()).slice(0, MAX_ITEMS));
    });
    // Only re-run when the query itself changes (a new /search?q= navigation).
  }, [current]);

  if (items.length === 0) return null;

  return (
    <div>
      <div className="border-b-2 border-ink pb-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-ink-faint uppercase">
        Recent searches
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {items.map((q) => (
          <Link
            key={q}
            href={`/search?q=${encodeURIComponent(q)}`}
            className="border border-hairline-strong px-2 py-1 font-mono text-[9.5px] text-ink-muted transition-colors hover:text-ink"
          >
            {q}
          </Link>
        ))}
      </div>
    </div>
  );
}
