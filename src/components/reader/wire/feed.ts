import type { FilingItem } from "@/lib/data/filings";
import type { NewsroomItemDetail } from "@/lib/data/newsroom";

/**
 * Pure, isomorphic shaping for the /wire (1d) center feed — merges the two
 * sources the page reads (`public.filings` rows + the newsroom's own
 * published WIRE `content_items`) into one `WireFeedItem` shape so the
 * design's unified, date-grouped timeline can render both through a single
 * row component (plain filing vs. the newsroom's bordered/badged
 * "DEVELOPING" treatment). No data access here — see `@/lib/data/wire.ts` +
 * `@/lib/data/filings.ts` + `@/lib/data/newsroom.ts` for the reads — only
 * types + shaping, so both the server page (`wire/page.tsx`) and the client
 * `WireStream` island (which reshapes freshly-polled filings the same way on
 * every `/api/pulse/wire` tick) import the same functions.
 *
 * Only `import type` reaches into filings.ts/newsroom.ts here — both are
 * `server-only`, and a runtime (value) import from either would throw when
 * this module lands in the client bundle via `WireStream`. Type-only imports
 * are erased at compile time, so this file stays safely isomorphic.
 */

export interface WireFeedTicker {
  code: string;
  venueCode: string | null;
  last: number | null;
  changePct: number | null;
}

export interface WireFeedItem {
  id: string;
  kind: "filing" | "newsroom";
  /** "developing" = the newsroom's own authored wire (1d's ink-bordered,
   *  black "DEVELOPING" badge treatment); "plain" = a raw exchange filing. */
  variant: "plain" | "developing";
  filedAt: string | null;
  venueCode: string | null;
  /** Filing type (filings) or kicker (newsroom) — the mono category label. */
  category: string;
  headline: string;
  summary: string | null;
  href: string;
  ticker: WireFeedTicker | null;
}

export interface WireFeedGroup {
  key: string;
  label: string;
  items: WireFeedItem[];
}

/** Matches `@/lib/data/wire.ts`'s `WireQuoteLite` without importing the
 *  server-only module for the type. */
export interface WireQuoteLite {
  changePct: number | null;
  last: number | null;
}

export function filingToWireItem(f: FilingItem, quote?: WireQuoteLite | null): WireFeedItem {
  return {
    id: `filing-${f.id}`,
    kind: "filing",
    variant: "plain",
    filedAt: f.filedAt,
    venueCode: f.venueCode,
    category: f.filingType ?? f.formCode ?? "FILING",
    headline: f.title ?? "Untitled filing",
    summary: f.aiSummary,
    href: `/filings/${f.id}`,
    ticker: f.ticker
      ? { code: f.ticker, venueCode: f.venueCode, last: quote?.last ?? null, changePct: quote?.changePct ?? null }
      : null,
  };
}

/** `newsroomItemHref` (`@/lib/data/newsroom`) inlined rather than imported —
 *  that module is `server-only` and this file must stay client-safe. */
export function newsroomToWireItem(item: NewsroomItemDetail): WireFeedItem {
  const primary = item.tickers.find((t) => t.isPrimary) ?? item.tickers[0] ?? null;
  return {
    id: `newsroom-${item.id}`,
    kind: "newsroom",
    variant: "developing",
    filedAt: item.publishedAt,
    venueCode: primary?.venueCode ?? null,
    category: item.kicker ?? "NEWSROOM",
    headline: item.headline,
    summary: item.dek,
    href: `/wire/${item.slug ?? item.id}`,
    ticker: null,
  };
}

const filedAtMs = (iso: string | null): number => {
  if (!iso) return 0;
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
};

/** Newest-first. Always parses to epoch ms before comparing — never a raw
 *  string compare, even client-side (the postgres.js Date-trap convention
 *  this repo holds server-side extends here: ISO strings are opaque). */
export function sortWireFeed(items: WireFeedItem[]): WireFeedItem[] {
  return [...items].sort((a, b) => filedAtMs(b.filedAt) - filedAtMs(a.filedAt));
}

// The design's date divider reads "Sunday 5 July 2026" — weekday, then
// day-month-year, no commas. No locale produces exactly that (en-US gives
// "Sunday, July 5, 2026"; en-GB keeps the comma), so the two parts are
// formatted separately and joined. Both are UTC, matching every other stamp
// on this surface.
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" });
const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function dayKey(iso: string | null): string {
  if (!iso) return "undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "undated";
  return d.toISOString().slice(0, 10);
}

function dayLabel(iso: string | null): string {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Undated";
  return `${WEEKDAY_FMT.format(d)} ${DATE_FMT.format(d)}`;
}

/** Groups an already-sorted (newest-first) feed into day buckets, preserving
 *  order — the design's mono date dividers ("Sunday 5 July 2026"). */
export function groupWireFeedByDay(items: WireFeedItem[]): WireFeedGroup[] {
  const groups: WireFeedGroup[] = [];
  const byKey = new Map<string, WireFeedGroup>();
  for (const item of items) {
    const key = dayKey(item.filedAt);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: dayLabel(item.filedAt), items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

/** HH:MM:SS (UTC) — the reconnecting banner's "LAST SYNC" stamp. Distinct
 *  from `@/lib/reader/format`'s `fmtClock` (HH:MM only, used for the item
 *  time gutter). */
export function fmtSyncClock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
