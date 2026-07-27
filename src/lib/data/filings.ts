import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toInt } from "./util";

/**
 * Public filings reads (anon-RLS `public.filings` + `public.securities`).
 * `full_text` / `extracted_facts` / `search_tsv` are intentionally NOT selected
 * here — the register/wire surfaces only need metadata + the AI summary. ~30s.
 */

export interface FilingItem {
  id: number;
  securityId: number | null;
  venueCode: string | null;
  ticker: string | null;
  name: string | null;
  formCode: string | null;
  filingType: string | null;
  title: string | null;
  filedAt: string | null;
  isMarketMoving: boolean;
  pdfPages: number | null;
  aiSummary: string | null;
}

export interface FilingsPage {
  items: FilingItem[];
  /** filed_at of the oldest row returned — pass back as `cursor` to page older. */
  nextCursor: string | null;
}

const FILING_COLS =
  "id,security_id,venue_code,form_code,filing_type,title,filed_at,is_market_moving,pdf_pages,ai_summary";

interface FilingRow {
  id: number;
  security_id: number | null;
  venue_code: string | null;
  form_code: string | null;
  filing_type: string | null;
  title: string | null;
  filed_at: string | null;
  is_market_moving: boolean | null;
  pdf_pages: number | null;
  ai_summary: string | null;
}

interface SecLite {
  id: number;
  ticker: string;
  venue_code: string;
  name_en: string;
}

/** Fetch identity for a set of security ids (for the wire feed's ticker chips). */
async function securityMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: number[],
): Promise<Map<number, SecLite>> {
  const map = new Map<number, SecLite>();
  const unique = [...new Set(ids.filter((n) => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb
    .from("securities")
    .select("id,ticker,venue_code,name_en")
    .in("id", unique);
  for (const s of (data as SecLite[] | null) ?? []) map.set(s.id, s);
  return map;
}

function mapFiling(r: FilingRow, sec?: SecLite): FilingItem {
  return {
    id: r.id,
    securityId: r.security_id,
    venueCode: r.venue_code ?? sec?.venue_code ?? null,
    ticker: sec?.ticker ?? null,
    name: sec?.name_en ?? null,
    formCode: r.form_code,
    filingType: r.filing_type,
    title: r.title,
    filedAt: r.filed_at,
    isMarketMoving: r.is_market_moving ?? false,
    pdfPages: toInt(r.pdf_pages),
    aiSummary: r.ai_summary,
  };
}

/**
 * Filings for one security, newest first. Tagged both `stock:{id}` (so a filings
 * ingest that calls `revalidateTag('stock:'+id)` refreshes this list too) and
 * `filings`.
 */
export async function getFilingsForSecurity(
  securityId: number,
  limit = 20,
): Promise<FilingItem[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 30, expire: 3600 });
  cacheTag(`stock:${securityId}`);
  cacheTag("filings");

  const sb = createAnonClient();
  const [{ data: rows }, { data: sec }] = await Promise.all([
    sb
      .from("filings")
      .select(FILING_COLS)
      .eq("security_id", securityId)
      .order("filed_at", { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 100)),
    sb.from("securities").select("id,ticker,venue_code,name_en").eq("id", securityId).maybeSingle<SecLite>(),
  ]);

  return ((rows as FilingRow[] | null) ?? []).map((r) => mapFiling(r, sec ?? undefined));
}

export interface FilingDetail extends FilingItem {
  sourceRef: string | null;
  /** Present on only ~152 rows; else null (show the PDF link instead). */
  fullText: string | null;
  /** jsonb — arbitrary extracted facts (~2.3k rows). Rendered as data, not code. */
  extractedFacts: unknown;
  aiSummaryModel: string | null;
  pdfStorageKey: string | null;
  pdfEnPath: string | null;
  createdAt: string | null;
}

const FILING_DETAIL_COLS =
  "id,security_id,venue_code,source_ref,form_code,filing_type,title,filed_at,full_text,extracted_facts,is_market_moving,pdf_pages,ai_summary,ai_summary_model,pdf_storage_key,pdf_en_path,created_at";

/**
 * One filing's full record (includes `full_text` + `extracted_facts` + the PDF
 * storage key). anon has column SELECT on these. Newest-value cached ~5 min,
 * tagged `filings` and (when known) `stock:{id}`.
 */
export async function getFilingDetail(filingId: number): Promise<FilingDetail | null> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 3600 });
  cacheTag("filings");

  const sb = createAnonClient();
  const { data: row } = await sb
    .from("filings")
    .select(FILING_DETAIL_COLS)
    .eq("id", filingId)
    .maybeSingle<FilingRow & {
      source_ref: string | null;
      full_text: string | null;
      extracted_facts: unknown;
      ai_summary_model: string | null;
      pdf_storage_key: string | null;
      pdf_en_path: string | null;
      created_at: string | null;
    }>();

  if (!row) return null;

  let sec: SecLite | undefined;
  if (row.security_id != null) {
    const { data } = await sb
      .from("securities")
      .select("id,ticker,venue_code,name_en")
      .eq("id", row.security_id)
      .maybeSingle<SecLite>();
    sec = data ?? undefined;
  }

  return {
    ...mapFiling(row, sec),
    sourceRef: row.source_ref ?? null,
    fullText: row.full_text ?? null,
    extractedFacts: row.extracted_facts ?? null,
    aiSummaryModel: row.ai_summary_model ?? null,
    pdfStorageKey: row.pdf_storage_key ?? null,
    pdfEnPath: row.pdf_en_path ?? null,
    createdAt: row.created_at ?? null,
  };
}

/** Exact count of filings for one security (for the overview header stat). */
export async function getFilingsCountForSecurity(securityId: number): Promise<number> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  cacheTag(`stock:${securityId}`);
  cacheTag("filings");

  const sb = createAnonClient();
  const { count } = await sb
    .from("filings")
    .select("id", { count: "exact", head: true })
    .eq("security_id", securityId);
  return count ?? 0;
}

/**
 * Global filings register / wire feed, newest first. Keyset pagination by
 * `filed_at` (compared server-side — never a JS date string compare). Pass the
 * returned `nextCursor` back as `cursor` to load older rows.
 */
export async function getGlobalFilings(
  cursor?: string,
  limit = 30,
): Promise<FilingsPage> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 30, expire: 3600 });
  cacheTag("filings");

  const sb = createAnonClient();
  const take = Math.min(Math.max(limit, 1), 100);
  let q = sb
    .from("filings")
    .select(FILING_COLS)
    .order("filed_at", { ascending: false })
    .limit(take);
  if (cursor) q = q.lt("filed_at", cursor);

  const { data } = await q;
  const rows = (data as FilingRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id).filter((n): n is number => n != null));

  const items = rows.map((r) => mapFiling(r, r.security_id ? secs.get(r.security_id) : undefined));
  const nextCursor = rows.length === take ? rows[rows.length - 1]?.filed_at ?? null : null;

  return { items, nextCursor };
}

/**
 * Faceted newswire page: newest filings optionally narrowed by `venue` and/or
 * `filing_type`, keyset-paged by `filed_at` (compared server-side — never a JS
 * date string compare). Facets are applied in SQL via `.eq`, so the payload only
 * ever contains matching rows. The client `WireStream` island then appends newer
 * items from `/api/pulse/wire` using the same facets. ~30s, tagged `filings`.
 */
export async function getWireFilings(opts: {
  venue?: string;
  type?: string;
  cursor?: string;
  limit?: number;
} = {}): Promise<FilingsPage> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 30, expire: 3600 });
  cacheTag("filings");

  const sb = createAnonClient();
  const take = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const venue = (opts.venue ?? "").trim().toUpperCase();
  const type = (opts.type ?? "").trim().toUpperCase();

  let q = sb
    .from("filings")
    .select(FILING_COLS)
    .order("filed_at", { ascending: false })
    .limit(take);
  if (venue) q = q.eq("venue_code", venue);
  if (type) q = q.eq("filing_type", type);
  if (opts.cursor) q = q.lt("filed_at", opts.cursor);

  const { data } = await q;
  const rows = (data as FilingRow[] | null) ?? [];
  const secs = await securityMap(sb, rows.map((r) => r.security_id).filter((n): n is number => n != null));

  const items = rows.map((r) => mapFiling(r, r.security_id ? secs.get(r.security_id) : undefined));
  const nextCursor = rows.length === take ? rows[rows.length - 1]?.filed_at ?? null : null;
  return { items, nextCursor };
}

/**
 * The distinct `filing_type` vocabulary present on the wire, for the newswire
 * facet control. Ordered by frequency so the busiest types surface first.
 * Reads only `public.filings`. Cached ~10 min, tagged `filings`.
 */
export async function getFilingTypeFacets(): Promise<Array<{ type: string; count: number }>> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("filings");

  const sb = createAnonClient();
  // Bounded scan of recent rows — enough to enumerate the live type vocabulary
  // without counting all 13k filings on every render.
  const { data } = await sb
    .from("filings")
    .select("filing_type")
    .order("filed_at", { ascending: false })
    .limit(4000);

  const counts = new Map<string, number>();
  for (const r of (data as Array<{ filing_type: string | null }> | null) ?? []) {
    const t = (r.filing_type ?? "").trim().toUpperCase();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

/** Recent filing ids + timestamps for the sitemap. `use cache`, tagged `filings`. */
export async function listRecentFilingRefs(
  limit = 10000,
): Promise<Array<{ id: number; filedAt: string | null }>> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 86400 });
  cacheTag("filings");

  const sb = createAnonClient();
  const { data, error } = await sb
    .from("filings")
    .select("id,filed_at")
    .order("filed_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 45000));
  // `filings` is indexed on (venue_code, filed_at) and (security_id, filed_at),
  // never on `filed_at` alone, so this sorts the whole 14,710-row table and blows
  // the anon role's 3s statement_timeout. Surfacing the error rather than
  // returning [] is the difference between a visible fault and a silently
  // truncated sitemap — see `listFilingRefsByPk` for the cheap alternative.
  if (error) throw new Error(`filings recent refs: ${error.message}`);

  return ((data as Array<{ id: number; filed_at: string | null }> | null) ?? []).map((r) => ({
    id: r.id,
    filedAt: r.filed_at,
  }));
}

/**
 * The same refs ordered by primary key — newest inserted rather than newest
 * filed. Walks `filings_pkey` backwards and stops at `limit`, so there is no
 * sort and no timeout risk. `id` and `filed_at` are strongly correlated (rows
 * are inserted as they are discovered), so the set is nearly the same one.
 */
export async function listFilingRefsByPk(
  limit = 10000,
): Promise<Array<{ id: number; filedAt: string | null }>> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 86400 });
  cacheTag("filings");

  const sb = createAnonClient();
  const { data, error } = await sb
    .from("filings")
    .select("id,filed_at")
    .order("id", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 45000));
  if (error) throw new Error(`filings refs by pk: ${error.message}`);

  return ((data as Array<{ id: number; filed_at: string | null }> | null) ?? []).map((r) => ({
    id: r.id,
    filedAt: r.filed_at,
  }));
}

/**
 * Register filtered to a bare ticker. Tickers are ambiguous across venues
 * (AMAN/GFH/ITHMR/ORDS), so this returns filings for EVERY security carrying
 * that ticker, newest first — the ticker chips disambiguate by venue. ~30s.
 */
export async function getFilingsByTicker(ticker: string, limit = 100): Promise<FilingItem[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 30, expire: 3600 });
  cacheTag("filings");

  const t = (ticker ?? "").trim().toUpperCase();
  if (!t) return [];

  const sb = createAnonClient();
  const { data: secs } = await sb
    .from("securities")
    .select("id,ticker,venue_code,name_en")
    .eq("ticker", t);
  const secList = (secs as SecLite[] | null) ?? [];
  if (secList.length === 0) return [];

  const secById = new Map<number, SecLite>(secList.map((s) => [s.id, s]));
  const { data: rows } = await sb
    .from("filings")
    .select(FILING_COLS)
    .in("security_id", secList.map((s) => s.id))
    .order("filed_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 200));

  return ((rows as FilingRow[] | null) ?? []).map((r) =>
    mapFiling(r, r.security_id ? secById.get(r.security_id) : undefined),
  );
}
