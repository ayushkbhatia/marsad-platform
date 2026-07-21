import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum } from "./util";

/**
 * Newsroom reads: `content_items` / `content_blocks` / `content_tickers` for
 * the autonomous newsroom's own WIRE/ARTICLE output, surfaced on the Ledger,
 * `/wire`, and the `/wire/[slug]` permalink — the first place a reader can
 * actually SEE what the agent pipeline published (03-agent-newsroom.md,
 * 04-reader-app.md §5.1). Deliberately disjoint from `src/lib/data/editorial.ts`
 * (ARTICLE-only, owns the premium cut + `/articles/[slug]`) per
 * `docs/frontend/CONVENTIONS.md` §1 — this file never reads/writes that one,
 * and callers needing the premium ARTICLE reader stay on `editorial.ts`.
 *
 * ── Slug gap (now closed by migration) — `content_items` published via
 * `desk_approve` → `ops.desk_decide_approval` (approve) or
 * `ops.newsroom_publish_sweep` (scheduled→live) never stamped `slug`; the
 * pipeline's first live WIRE (item #7, "QNB posts QAR 4.43bn net profit in Q2
 * 2026, revenue up 11.2%") sat at `slug=NULL`. Fixed by a DB trigger + backfill
 * in `supabase/migrations/20260722150000_newsroom_wire_slug_and_citations_read.sql`
 * (migration FILE only — the lead applies it, per CONVENTIONS §1.4). Until
 * that lands, `getNewsroomItemBySlugOrId` below still resolves every item
 * correctly via its `id` fallback (slug is only ever a nicer URL, never the
 * only key) — nothing here is blocked on the migration landing.
 *
 * ── Citation read gap (now closed by the same migration) — `lake.citations`
 * carries the `[c1]`/`[c2]`… claim text a WIRE body cites, but anon has no
 * `USAGE` on the `lake` schema at all (confirmed via `pg_policies` +
 * `information_schema.role_table_grants`, 2026-07-22) — a plain anon read
 * returns zero rows, so the "[c1] marker → small sources note" the reader
 * needs has no data path. The same migration adds `public.v_content_citations`
 * — an owner-privileged wrapper view (mirrors `public.v_scores_public`) that
 * excludes any content item carrying so much as one gated block, so a
 * citation used inside a premium cut can never leak through this side door.
 * `getNewsroomItemDetail`/list fns below read that view; until the migration
 * applies, `citations` on every returned item is simply `[]` (the `[cN]`
 * markers render as plain literal text — never broken, never a gated leak).
 *
 * ── Byline gap — same as `editorial.ts`: `byline_chain` stores agent codes,
 * not display names, and `content_items.byline_chain` is `[]` for the wire
 * pipeline's TPL-01 output today, so `bylineLabel` below falls back to the
 * newsroom's own name rather than fabricating a byline.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface NewsroomBlockView {
  id: number;
  seq: number;
  kind: string;
  text: string | null;
}

export interface NewsroomCitationView {
  blockKey: string;
  claimText: string | null;
  quotedValue: string | null;
}

export interface NewsroomTickerItem {
  securityId: number;
  ticker: string;
  venueCode: string;
  name: string;
  isPrimary: boolean;
  changePct: number | null;
  last: number | null;
}

export interface NewsroomItemSummary {
  id: string;
  slug: string | null;
  contentType: string;
  kicker: string | null;
  headline: string;
  dek: string | null;
  status: string;
  publishedAt: string | null;
  updatedAt: string | null;
}

export interface NewsroomItemDetail extends NewsroomItemSummary {
  bylineLabel: string;
  retractionNotice: string | null;
  blocks: NewsroomBlockView[];
  citations: NewsroomCitationView[];
  tickers: NewsroomTickerItem[];
}

/** Path segment for a newsroom item: the slug once backfilled, the raw id
 *  meanwhile — `/wire/[slug]` resolves either form (see `getWireHref`). */
export function newsroomItemHref(item: Pick<NewsroomItemSummary, "id" | "slug">): string {
  return `/wire/${item.slug ?? item.id}`;
}

const SUMMARY_COLS = "id,content_type,slug,kicker,dek,headline,status,published_at,updated_at";
const DETAIL_COLS =
  "id,content_type,slug,kicker,dek,headline,status,published_at,updated_at,byline_chain,retraction_notice";

interface ContentItemSummaryRow {
  id: string;
  content_type: string;
  slug: string | null;
  kicker: string | null;
  dek: string | null;
  headline: string;
  status: string;
  published_at: string | null;
  updated_at: string | null;
}

interface ContentItemDetailRow extends ContentItemSummaryRow {
  byline_chain: unknown;
  retraction_notice: string | null;
}

interface ContentBlockRow {
  id: number;
  content_id: string;
  seq: number;
  block_kind: string;
  body: unknown;
}

interface ContentTickerRow {
  content_id: string;
  security_id: number;
  is_primary: boolean;
}

interface CitationRow {
  content_id: string;
  block_key: string;
  claim_text: string | null;
  quoted_value: string | null;
}

interface SecLite {
  id: number;
  ticker: string;
  venue_code: string;
  name_en: string;
}

interface QuoteLite {
  changePct: number | null;
  last: number | null;
}

function blockText(kind: string, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.caption === "string") return b.caption;
  return null;
}

/** `byline_chain` is `[{"role":"drafted_by","principal":"WRITER-2"}]` — agent
 *  codes, not display names (see file header). Empty chain (the common case
 *  for TPL-01 wires today) reads as the newsroom's own byline. */
function bylineLabel(raw: unknown): string {
  if (!Array.isArray(raw) || raw.length === 0) return "Marsad Newsroom";
  const parts = raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => {
      const role = typeof e.role === "string" ? e.role.replace(/_/g, " ") : null;
      const who = typeof e.principal === "string" ? e.principal : null;
      if (!who) return null;
      return role ? `${role} · ${who}` : who;
    })
    .filter((s): s is string => s != null);
  return parts.length > 0 ? parts.join(" · ") : "Marsad Newsroom";
}

function mapSummary(r: ContentItemSummaryRow): NewsroomItemSummary {
  return {
    id: r.id,
    slug: r.slug,
    contentType: r.content_type,
    kicker: r.kicker,
    headline: r.headline,
    dek: r.dek,
    status: r.status,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
  };
}

async function secLiteMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: number[],
): Promise<Map<number, SecLite>> {
  const map = new Map<number, SecLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb.from("securities").select("id,ticker,venue_code,name_en").in("id", unique);
  for (const s of (data as SecLite[] | null) ?? []) map.set(s.id, s);
  return map;
}

async function quoteLiteMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: number[],
): Promise<Map<number, QuoteLite>> {
  const map = new Map<number, QuoteLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb.from("quotes_latest").select("security_id,change_pct,last").in("security_id", unique);
  for (const r of (data as Array<{ security_id: number; change_pct: unknown; last: unknown }> | null) ?? []) {
    map.set(r.security_id, { changePct: toNum(r.change_pct), last: toNum(r.last) });
  }
  return map;
}

/** Batch-hydrate a page of content_item rows with blocks/tickers/citations —
 *  avoids N+1 reads when listing several items at once (Ledger/`/wire`). */
async function hydrate(
  sb: ReturnType<typeof createAnonClient>,
  rows: ContentItemDetailRow[],
): Promise<NewsroomItemDetail[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [{ data: blockRows }, { data: tickerRows }, { data: citationRows }] = await Promise.all([
    sb
      .from("content_blocks")
      .select("id,content_id,seq,block_kind,body")
      .in("content_id", ids)
      .order("seq", { ascending: true }),
    sb.from("content_tickers").select("content_id,security_id,is_primary").in("content_id", ids),
    sb.from("v_content_citations").select("content_id,block_key,claim_text,quoted_value").in("content_id", ids),
  ]);

  const blocksByItem = new Map<string, NewsroomBlockView[]>();
  for (const b of (blockRows as ContentBlockRow[] | null) ?? []) {
    const list = blocksByItem.get(b.content_id) ?? [];
    list.push({ id: b.id, seq: b.seq, kind: b.block_kind, text: blockText(b.block_kind, b.body) });
    blocksByItem.set(b.content_id, list);
  }

  const tickerLinksByItem = new Map<string, ContentTickerRow[]>();
  const allSecIds: number[] = [];
  for (const t of (tickerRows as ContentTickerRow[] | null) ?? []) {
    const list = tickerLinksByItem.get(t.content_id) ?? [];
    list.push(t);
    tickerLinksByItem.set(t.content_id, list);
    allSecIds.push(t.security_id);
  }
  const [secs, quotes] = await Promise.all([secLiteMap(sb, allSecIds), quoteLiteMap(sb, allSecIds)]);

  const citationsByItem = new Map<string, NewsroomCitationView[]>();
  for (const c of (citationRows as CitationRow[] | null) ?? []) {
    const list = citationsByItem.get(c.content_id) ?? [];
    list.push({ blockKey: c.block_key, claimText: c.claim_text, quotedValue: c.quoted_value });
    citationsByItem.set(c.content_id, list);
  }

  return rows.map((r) => {
    const tickers: NewsroomTickerItem[] = (tickerLinksByItem.get(r.id) ?? [])
      .map((t) => {
        const sec = secs.get(t.security_id);
        if (!sec) return null;
        const q = quotes.get(t.security_id);
        return {
          securityId: t.security_id,
          ticker: sec.ticker,
          venueCode: sec.venue_code,
          name: sec.name_en,
          isPrimary: t.is_primary,
          changePct: q?.changePct ?? null,
          last: q?.last ?? null,
        };
      })
      .filter((t): t is NewsroomTickerItem => t != null)
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

    return {
      ...mapSummary(r),
      bylineLabel: bylineLabel(r.byline_chain),
      retractionNotice: r.retraction_notice,
      blocks: blocksByItem.get(r.id) ?? [],
      citations: citationsByItem.get(r.id) ?? [],
      tickers,
    };
  });
}

// ── Public reads ─────────────────────────────────────────────────────────────

/**
 * Published newsroom content, full detail (blocks/tickers/citations
 * included), newest by `published_at`. Defaults to WIRE+ARTICLE; callers that
 * only want the wire (Ledger, `/wire`, the permalink rail) pass
 * `contentTypes: ["WIRE"]`. RLS on `content_items`/`content_blocks` already
 * restricts anon to `status in ('live','updated','retracted')` and the
 * ungated block portion — this function trusts that (never re-derives it in
 * JS), matching `editorial.ts`'s posture.
 */
export async function listNewsroomContent(
  opts: { contentTypes?: string[]; limit?: number } = {},
): Promise<NewsroomItemDetail[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("content");
  cacheTag("newsroom");

  const sb = createAnonClient();
  const types = opts.contentTypes && opts.contentTypes.length > 0 ? opts.contentTypes : ["WIRE", "ARTICLE"];
  const take = Math.min(Math.max(opts.limit ?? 20, 1), 100);

  const { data } = await sb
    .from("content_items")
    .select(DETAIL_COLS)
    .in("content_type", types)
    .order("published_at", { ascending: false })
    .limit(take);

  return hydrate(sb, (data as ContentItemDetailRow[] | null) ?? []);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One newsroom item by slug — or by raw `id` when the slug backfill hasn't
 * reached it yet (defense-in-depth alongside the migration; see file header).
 * Defaults to WIRE only (the `/wire/[slug]` permalink's scope — ARTICLE stays
 * on `/articles/[slug]` via `editorial.ts`, which owns the premium cut).
 */
export async function getNewsroomItemBySlugOrId(
  slugOrId: string,
  opts: { contentTypes?: string[] } = {},
): Promise<NewsroomItemDetail | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("content");
  cacheTag("newsroom");

  const key = (slugOrId ?? "").trim();
  if (!key) return null;

  const sb = createAnonClient();
  const types = opts.contentTypes && opts.contentTypes.length > 0 ? opts.contentTypes : ["WIRE"];

  let q = sb.from("content_items").select(DETAIL_COLS).in("content_type", types);
  q = UUID_RE.test(key) ? q.eq("id", key) : q.eq("slug", key);
  const { data: item } = await q.maybeSingle<ContentItemDetailRow>();
  if (!item) return null;

  const [detail] = await hydrate(sb, [item]);
  return detail ?? null;
}

/** Recent wires excluding one id — the "More from the newsroom" rail on the
 *  permalink. Summary-only (no blocks/citations) — the rail is headline+dek. */
export async function getRecentWiresExcluding(excludeId: string, limit = 4): Promise<NewsroomItemSummary[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  cacheTag("content");
  cacheTag("newsroom");

  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select(SUMMARY_COLS)
    .eq("content_type", "WIRE")
    .neq("id", excludeId)
    .order("published_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 20));

  return ((data as ContentItemSummaryRow[] | null) ?? []).map(mapSummary);
}

/** Every published-WIRE slug (id fallback for pre-backfill rows) — for a
 *  future `sitemap.ts` entry (foundation-owned per CONVENTIONS §1.6; wiring
 *  this in is a lead task, same posture as `editorial.ts#listPublishedArticleSlugs`). */
export async function listPublishedWireSlugs(limit = 5000): Promise<Array<{ path: string; updatedAt: string | null }>> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 86400 });
  cacheTag("newsroom");

  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select("id,slug,updated_at")
    .eq("content_type", "WIRE")
    .limit(Math.min(Math.max(limit, 1), 45000));

  return ((data as Array<{ id: string; slug: string | null; updated_at: string | null }> | null) ?? []).map((r) => ({
    path: `/wire/${r.slug ?? r.id}`,
    updatedAt: r.updated_at,
  }));
}
