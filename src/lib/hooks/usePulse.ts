"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAnyVenueOpen } from "@/lib/market/hours";

/**
 * Client poller for the `/api/pulse/*` surfaces (04-reader-app.md §4).
 *
 * - `setInterval` + `fetch` at the surface's cadence.
 * - Pauses while `document.hidden` (no polls on a backgrounded tab), refetches
 *   immediately when the tab becomes visible again.
 * - Stops entirely when `enabled` is false — callers pass
 *   `enabled = anyVenueOpen` (from `useMarketOpen` or a server `getMarketState`)
 *   so polling ceases when every relevant venue is closed.
 *
 * No websockets by design: delayed/EOD data makes a 30–60s poll honest and cheap.
 */

export const PULSE_INTERVALS: Record<string, number> = {
  quote: 30_000,
  wire: 30_000,
  indices: 60_000,
  heatmap: 60_000,
};

export type PulseParams = Record<string, string | number | boolean | null | undefined>;

export interface UsePulseOptions {
  /** Override the per-surface default cadence. */
  intervalMs?: number;
  /** Poll only while true (e.g. any relevant venue open). Default true. */
  enabled?: boolean;
  /** Fetch once immediately on mount/enable. Default true. */
  immediate?: boolean;
}

export interface UsePulseResult<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  /** Epoch ms of the last successful fetch (for client-side recency decay). */
  lastUpdated: number | null;
  /** Force an out-of-band refetch. */
  refresh: () => void;
}

function buildUrl(surface: string, params: PulseParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return `/api/pulse/${encodeURIComponent(surface)}${s ? `?${s}` : ""}`;
}

export function usePulse<T = unknown>(
  surface: string,
  params: PulseParams = {},
  options: UsePulseOptions = {},
): UsePulseResult<T> {
  const { enabled = true, immediate = true } = options;
  const intervalMs = options.intervalMs ?? PULSE_INTERVALS[surface] ?? 30_000;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Stable dependency for the params object (callers pass inline objects).
  const paramsKey = JSON.stringify(params ?? {});
  const abortRef = useRef<AbortController | null>(null);

  const fetchNow = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setIsLoading(true);
    try {
      const res = await fetch(buildUrl(surface, JSON.parse(paramsKey) as PulseParams), {
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`pulse ${surface} responded ${res.status}`);
      const json = (await res.json()) as T;
      setData(json);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e as Error);
    } finally {
      setIsLoading(false);
    }
  }, [surface, paramsKey]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const run = () => {
      if (!cancelled && !document.hidden) fetchNow();
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (!timer) timer = setInterval(run, intervalMs);
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        run();
        start();
      }
    };

    if (!document.hidden) {
      // Defer the first fetch out of the synchronous effect body so its setState
      // doesn't cascade renders (react-hooks/set-state-in-effect).
      if (immediate) queueMicrotask(run);
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      abortRef.current?.abort();
    };
  }, [enabled, immediate, intervalMs, fetchNow]);

  return { data, error, isLoading, lastUpdated, refresh: fetchNow };
}

/**
 * Client-side market open/closed gate for `usePulse({ enabled })`. Uses the
 * static trading-hours mirror in `@/lib/market/hours` (holidays not encoded —
 * the pulse payload's own freshness block covers those). Re-checks each minute.
 */
export function useMarketOpen(venues?: string[], recheckMs = 60_000): boolean {
  const key = (venues ?? []).join(",");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const list = key ? key.split(",") : undefined;
    const check = () => setOpen(isAnyVenueOpen(list));
    check();
    const id = setInterval(check, recheckMs);
    return () => clearInterval(id);
  }, [key, recheckMs]);

  return open;
}
