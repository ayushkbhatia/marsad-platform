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
