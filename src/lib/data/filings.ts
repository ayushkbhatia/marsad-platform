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
