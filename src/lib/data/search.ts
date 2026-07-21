import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toInt, toNum } from "./util";

/**
 * Federated search (16a) — Postgres FTS + pg_trgm, no external engine.
 * `20260722090000_search_fts.sql` §6. The entire read path is one anon RPC,
 * `public.fn_search(p_q)`: `websearch_to_tsquery` ∪ a trigram fuzzy pass over
 * `public.search_documents` (maintained by triggers on `securities`+`filings`),
 * ranked + counted server-side. This module never reads `search_documents`
 * directly — only `fn_search` is a sanctioned reader (it returns metadata only,
 * never a document body).
 */

export type SearchDocType = "security" | "filing";

export interface SearchHit {
  docType: SearchDocType;
  docId: number;
  ticker: string | null;
  title: string;
  url: string;
  premium: boolean;
  rank: number;
}

export interface SearchTypeCount {
  docType: string;
  count: number;
}

/** Quote + score enrichment for the 16a "Top match" security card. */
export interface SearchSecurityDetail {
  venueCode: string;
  sector: string | null;
  currency: string | null;
  last: number | null;
  changePct: number | null;
  score: number | null;
  rating: string | null;
}

/** A filing hit enriched with the type/date columns `fn_search` doesn't carry (metadata-only RPC). */
export interface SearchFilingHit extends SearchHit {
  filingType: string | null;
  filedAt: string | null;
  isMarketMoving: boolean;
}

export interface SearchResult {
  q: string;
  /** All hits, rank-ordered, as returned by fn_search (flat — before per-type enrichment). */
  hits: SearchHit[];
  totalCount: number;
  typeCounts: SearchTypeCount[];
  /** The single highest-ranked SECURITY hit, enriched with quote+score — null if none matched. */
  topSecurity: (SearchHit & { detail: SearchSecurityDetail }) | null;
  /** Every security hit (for the "Stocks" facet view). */
  securityHits: SearchHit[];
  /** Every filing hit, enriched with type/date for FilingsList reuse. */
  filingHits: SearchFilingHit[];
}

interface SearchRow {
  doc_type: string;
  doc_id: number;
  ticker: string | null;
  title: string;
  url: string;
  premium: boolean;
  rank: unknown;
  type_count: unknown;
  total_count: unknown;
}

const MAX_Q_LEN = 200;
const EMPTY_RESULT = (q: string): SearchResult => ({
  q,
  hits: [],
  totalCount: 0,
  typeCounts: [],
  topSecurity: null,
  securityHits: [],
  filingHits: [],
});

/**
 * Run a federated search. Cached per query string ~5 min (matches the
 * `/api/search` CDN `s-maxage=300`); the RPC itself is single-digit-ms at this
 * corpus size (762 securities + ~14k filings) so a cache miss is cheap too.
 */
export async function runSearch(q: string): Promise<SearchResult> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 1800 });
  cacheTag("search");

  const query = (q ?? "").trim().slice(0, MAX_Q_LEN);
  if (!query) return EMPTY_RESULT(query);

  const sb = createAnonClient();
  const { data } = await sb.rpc("fn_search", { p_q: query });
  const rows = (data as SearchRow[] | null) ?? [];
  if (rows.length === 0) return EMPTY_RESULT(query);

  const hits: SearchHit[] = rows.map((r) => ({
    docType: r.doc_type as SearchDocType,
    docId: r.doc_id,
    ticker: r.ticker,
    title: r.title,
    url: r.url,
    premium: r.premium,
    rank: toNum(r.rank) ?? 0,
  }));

  // type_count is constant per doc_type (a window-function total from fn_search),
  // so the first row seen per type carries the right value.
  const typeCounts: SearchTypeCount[] = [];
  const seenTypes = new Set<string>();
  for (const r of rows) {
    if (seenTypes.has(r.doc_type)) continue;
    seenTypes.add(r.doc_type);
    typeCounts.push({ docType: r.doc_type, count: toInt(r.type_count) ?? 0 });
  }
  const totalCount = toInt(rows[0]?.total_count) ?? 0;

  const securityHits = hits.filter((h) => h.docType === "security");
  const filingHitsRaw = hits.filter((h) => h.docType === "filing");

  const [topSecurity, filingHits] = await Promise.all([
    securityHits[0] ? enrichSecurity(sb, securityHits[0]) : Promise.resolve(null),
    filingHitsRaw.length ? enrichFilings(sb, filingHitsRaw) : Promise.resolve([]),
  ]);

  return { q: query, hits, totalCount, typeCounts, topSecurity, securityHits, filingHits };
}

async function enrichSecurity(
  sb: ReturnType<typeof createAnonClient>,
  hit: SearchHit,
): Promise<(SearchHit & { detail: SearchSecurityDetail }) | null> {
  const [{ data: sec }, { data: quote }, { data: score }] = await Promise.all([
    sb
      .from("securities")
      .select("venue_code,sector,currency")
      .eq("id", hit.docId)
      .maybeSingle<{ venue_code: string; sector: string | null; currency: string | null }>(),
    sb
      .from("quotes_latest")
      .select("last,change_pct")
      .eq("security_id", hit.docId)
      .maybeSingle<{ last: unknown; change_pct: unknown }>(),
    sb
      .from("v_scores_public")
      .select("score,rating")
      .eq("security_id", hit.docId)
      .maybeSingle<{ score: number | null; rating: string | null }>(),
  ]);

  if (!sec) return null;
  return {
    ...hit,
    detail: {
      venueCode: sec.venue_code,
      sector: sec.sector ?? null,
      currency: sec.currency ?? null,
      last: toNum(quote?.last),
      changePct: toNum(quote?.change_pct),
      score: toInt(score?.score ?? null),
      rating: score?.rating ?? null,
    },
  };
}

/**
 * Batch-enrich filing hits with the type/date columns `fn_search` doesn't
 * return (it's metadata-only by design). Reads `public.filings` directly —
 * anon-readable (`world_read` RLS), the same table `getFilingsForSecurity`
 * reads — never `search_documents`.
 */
async function enrichFilings(
  sb: ReturnType<typeof createAnonClient>,
  hits: SearchHit[],
): Promise<SearchFilingHit[]> {
  const ids = hits.map((h) => h.docId);
  const { data } = await sb
    .from("filings")
    .select("id,filing_type,filed_at,is_market_moving")
    .in("id", ids);

  const meta = new Map<number, { filing_type: string | null; filed_at: string | null; is_market_moving: boolean | null }>();
  for (const r of (data as Array<{ id: number; filing_type: string | null; filed_at: string | null; is_market_moving: boolean | null }> | null) ?? []) {
    meta.set(r.id, r);
  }

  return hits.map((h) => {
    const m = meta.get(h.docId);
    return {
      ...h,
      filingType: m?.filing_type ?? null,
      filedAt: m?.filed_at ?? null,
      isMarketMoving: m?.is_market_moving ?? false,
    };
  });
}
