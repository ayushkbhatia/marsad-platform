import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

/**
 * Editorial reads: `content_items` / `content_blocks` / `content_tickers`
 * (articles, research) and `analysts` / `analyst_calls` (the Coverage Desk).
 *
 * ── Article premium cut — NO `fn_article_render` RPC exists (confirmed via
 * read-only SQL against `information_schema.routines`, 2026-07-21). Enforcement
 * instead lives at the RLS layer on `public.content_blocks` (see
 * `docs/architecture/02-data-lake.md` §10/§19):
 *
 *   using ( exists (select 1 from content_items ci where ci.id = content_id
 *           and ci.status in ('live','updated','retracted'))
 *           and (not gated or public.jwt_tier() <> 'free') )
 *
 * `jwt_tier()` reads `auth.jwt() -> app_metadata ->> plan_tier`, defaulting to
 * `'free'` when there is no JWT at all — which is exactly the case for
 * `createAnonClient()` (cookieless, anon key, no session). So a plain
 * `select * from content_blocks where content_id = …` through the anon client
 * has gated rows **physically absent from the result set** — Postgres never
 * sends them. This file relies on that: `getArticleBySlug` below does a
 * straight anon read of `content_blocks` and trusts RLS to withhold the gated
 * remainder. This satisfies the "never ship gated data to a client" rule
 * (04-reader-app.md §5.1 / CONVENTIONS §2) as strongly as a SECURITY DEFINER
 * RPC would — the difference from Pattern B is only that there is no
 * **metering** here (the "3 free premium reads/month" unlock-and-count-once
 * behavior). That still needs `fn_article_render`/a route-handler equivalent
 * per `billing.consume_meter()` (02-data-lake.md §19 family 3) — FLAGGED to
 * the lead as a follow-up migration. Until it lands, an `is_premium` article
 * simply always shows the free lede + a `PremiumLock`, with no "N of 3 free
 * reads used" banner.
 *
 * ── Byline identity gap — `content_items.byline_chain` stores agent/editor
 * *codes* (`[{"role":"drafted_by","principal":"WRITER-2"}]`, per
 * 02-data-lake.md §10), not human display names, and `author_id` FKs to
 * `iam.principals` which has **no anon/authenticated SELECT policy at all**
 * (confirmed via `pg_policies` — only a `marsad_worker` policy exists). There
 * is currently no public-safe path from a content row to a human-readable
 * byline. Rendered as-is (role + code) rather than fabricated — FLAGGED to
 * the lead (needs either a denormalized display name snapshotted at publish
 * time, or a public-safe view/RPC over `iam.principals`).
 *
 * ── Analysts identity — RESOLVED 2026-07-26 by `public.v_analysts_public`
 * (migration `20260726190625_v_analysts_public.sql`, BRIDGE-BUILD-PLAN P0.5).
 * `public.analysts` still has no `slug`/`display_name` column of its own; the
 * identity lives in `iam.principals` (`handle` = the public slug,
 * `display_name`), which is `worker_read` only. The view is a
 * `security_invoker = false` wrapper — the same pattern as `v_scores_public` /
 * `v_key_ratios_public` — exposing exactly slug/display_name/title/credential/
 * bio/is_external/joined_at/principal_id to anon, filtered to
 * `is_active and purged_at is null`. `revenue_share_pct` is deliberately NOT
 * in the view (commercial terms, never public) — do not add it here either.
 * `getAnalystProfileBySlug` below reads it. The roster is still 0 rows until
 * the analyst seed lands (BRIDGE-BUILD-PLAN P3.1), so the function returns
 * `null` for every slug today — but by data, not by construction.
 *
 * (The **byline** gap above is a different, still-open problem:
 * `content_items.byline_chain` carries agent/editor *codes*, and there is no
 * join from a code to a principal. `v_analysts_public` only covers analysts.)
 */

// ── Articles ─────────────────────────────────────────────────────────────────

export interface BylineEntry {
  role: string | null;
  principal: string | null;
}

export interface RatingAttachment {
  securityId: number | null;
  ticker: string | null;
  venueCode: string | null;
  name: string | null;
  rating: string | null;
  priceTarget: number | null;
  /** (priceTarget / quotes_latest.last − 1) × 100 — null if either is missing. */
  impliedUpsidePct: number | null;
}

export interface ArticleBlockView {
  id: number;
  seq: number;
  kind: string;
  text: string | null;
}

export interface ArticleTickerRailItem {
  securityId: number;
  ticker: string;
  venueCode: string;
  name: string;
  isPrimary: boolean;
  changePct: number | null;
}

export interface ArticleDetail {
  id: string;
  slug: string;
  contentType: string;
  section: string | null;
  kicker: string | null;
  headline: string;
  dek: string | null;
  status: string;
  isPremium: boolean;
  readMinutes: number | null;
  wordCount: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  retractionNotice: string | null;
  byline: BylineEntry[];
  rating: RatingAttachment | null;
  blocks: ArticleBlockView[];
  /** Sum of words across the blocks actually delivered (RLS-visible). */
  visibleWordCount: number;
  /** `is_premium` article — always show the lock below the visible blocks. */
  hasGatedRemainder: boolean;
  /** `word_count` (whole piece) minus `visibleWordCount`, floored at 0 — a UI
   *  teaser number only, derived entirely from data the anon client already
   *  received (never from a gated-row count, which anon cannot see). */
  remainingWordsEstimate: number | null;
  tickers: ArticleTickerRailItem[];
}

export interface ArticleSummary {
  id: string;
  slug: string;
  section: string | null;
  kicker: string | null;
  headline: string;
  dek: string | null;
  isPremium: boolean;
  readMinutes: number | null;
  publishedAt: string | null;
  byline: BylineEntry[];
}

const ARTICLE_COLS =
  "id,content_type,slug,section,kicker,dek,headline,status,is_premium,premium_cut_after_block,read_minutes,published_at,updated_at,retraction_notice,byline_chain,rating_attachment,word_count";

const SUMMARY_COLS =
  "id,slug,section,kicker,dek,headline,is_premium,read_minutes,published_at,byline_chain";

interface ContentItemRow {
  id: string;
  content_type: string;
  slug: string | null;
  section: string | null;
  kicker: string | null;
  dek: string | null;
  headline: string;
  status: string;
  is_premium: boolean;
  premium_cut_after_block: number | null;
  read_minutes: number | null;
  published_at: string | null;
  updated_at: string | null;
  retraction_notice: string | null;
  byline_chain: unknown;
  rating_attachment: unknown;
  word_count: number | null;
}

interface ContentBlockRow {
  id: number;
  seq: number;
  block_kind: string;
  body: unknown;
}

interface SecLite {
  id: number;
  ticker: string;
  venue_code: string;
  name_en: string;
}

function toByline(raw: unknown): BylineEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .map((e) => ({
      role: typeof e.role === "string" ? e.role : null,
      principal: typeof e.principal === "string" ? e.principal : null,
    }));
}

function blockText(kind: string, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.caption === "string") return b.caption;
  return null;
}

function countWords(text: string | null): number {
  if (!text) return 0;
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

async function secLiteMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: number[],
): Promise<Map<number, SecLite>> {
  const map = new Map<number, SecLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb
    .from("securities")
    .select("id,ticker,venue_code,name_en")
    .in("id", unique);
  for (const s of (data as SecLite[] | null) ?? []) map.set(s.id, s);
  return map;
}

interface QuoteLite {
  changePct: number | null;
  last: number | null;
}

async function quoteLiteMap(
  sb: ReturnType<typeof createAnonClient>,
  ids: number[],
): Promise<Map<number, QuoteLite>> {
  const map = new Map<number, QuoteLite>();
  const unique = [...new Set(ids.filter((n): n is number => n != null))];
  if (unique.length === 0) return map;
  const { data } = await sb
    .from("quotes_latest")
    .select("security_id,change_pct,last")
    .in("security_id", unique);
  for (const r of (data as Array<{ security_id: number; change_pct: unknown; last: unknown }> | null) ?? []) {
    map.set(r.security_id, { changePct: toNum(r.change_pct), last: toNum(r.last) });
  }
  return map;
}

function parseRatingAttachment(raw: unknown, sec?: SecLite, quote?: QuoteLite): RatingAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const securityId = toInt(r.security_id ?? r.securityId);
  const priceTarget = toNum(r.pt ?? r.price_target);
  const last = quote?.last ?? null;
  const impliedUpsidePct =
    priceTarget != null && last != null && last > 0 ? ((priceTarget - last) / last) * 100 : null;
  return {
    securityId,
    ticker: sec?.ticker ?? null,
    venueCode: sec?.venue_code ?? null,
    name: sec?.name_en ?? null,
    rating: typeof r.rating === "string" ? r.rating : null,
    priceTarget,
    impliedUpsidePct,
  };
}

function mapSummary(r: ContentItemRow): ArticleSummary {
  return {
    id: r.id,
    slug: r.slug ?? "",
    section: r.section,
    kicker: r.kicker,
    headline: r.headline,
    dek: r.dek,
    isPremium: r.is_premium,
    readMinutes: toInt(r.read_minutes),
    publishedAt: r.published_at,
    byline: toByline(r.byline_chain),
  };
}

/**
 * One article by slug (ARTICLE content type only — WIRE/EXPLAINER/NOTE/TAKE/
 * NEWSLETTER items are out of this route's scope). RLS restricts the
 * `content_items` row to `status in ('live','updated','retracted')` and the
 * `content_blocks` rows to the free portion for anon (see file header) — so
 * this function never sees, let alone returns, the gated remainder of a
 * premium piece.
 */
export async function getArticleBySlug(slug: string): Promise<ArticleDetail | null> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 3600 });
  cacheTag("content");
  cacheTag("articles");

  const s = (slug ?? "").trim();
  if (!s) return null;

  const sb = createAnonClient();
  const { data: item } = await sb
    .from("content_items")
    .select(ARTICLE_COLS)
    .eq("slug", s)
    .eq("content_type", "ARTICLE")
    .maybeSingle<ContentItemRow>();
  if (!item) return null;

  const [{ data: blockRows }, { data: tickerRows }] = await Promise.all([
    sb
      .from("content_blocks")
      .select("id,seq,block_kind,body")
      .eq("content_id", item.id)
      .order("seq", { ascending: true }),
    sb
      .from("content_tickers")
      .select("security_id,is_primary")
      .eq("content_id", item.id),
  ]);

  const tickerLinks = (tickerRows as Array<{ security_id: number; is_primary: boolean }> | null) ?? [];
  const rating = item.rating_attachment as Record<string, unknown> | null;
  const ratingSecId = rating ? toInt((rating as Record<string, unknown>).security_id ?? (rating as Record<string, unknown>).securityId) : null;

  const secIds = [...tickerLinks.map((t) => t.security_id), ...(ratingSecId != null ? [ratingSecId] : [])];
  const [secs, quotes] = await Promise.all([secLiteMap(sb, secIds), quoteLiteMap(sb, secIds)]);

  const blocks: ArticleBlockView[] = ((blockRows as ContentBlockRow[] | null) ?? []).map((b) => ({
    id: b.id,
    seq: b.seq,
    kind: b.block_kind,
    text: blockText(b.block_kind, b.body),
  }));

  const visibleWordCount = blocks.reduce((sum, b) => sum + countWords(b.text), 0);
  const wordCount = toInt(item.word_count);
  const remainingWordsEstimate =
    item.is_premium && wordCount != null ? Math.max(0, wordCount - visibleWordCount) : null;

  const tickers: ArticleTickerRailItem[] = tickerLinks
    .map((t) => {
      const sec = secs.get(t.security_id);
      if (!sec) return null;
      return {
        securityId: t.security_id,
        ticker: sec.ticker,
        venueCode: sec.venue_code,
        name: sec.name_en,
        isPrimary: t.is_primary,
        changePct: quotes.get(t.security_id)?.changePct ?? null,
      };
    })
    .filter((t): t is ArticleTickerRailItem => t != null)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));

  return {
    id: item.id,
    slug: item.slug ?? s,
    contentType: item.content_type,
    section: item.section,
    kicker: item.kicker,
    headline: item.headline,
    dek: item.dek,
    status: item.status,
    isPremium: item.is_premium,
    readMinutes: toInt(item.read_minutes),
    wordCount,
    publishedAt: item.published_at,
    updatedAt: item.updated_at,
    retractionNotice: item.retraction_notice,
    byline: toByline(item.byline_chain),
    rating: parseRatingAttachment(
      item.rating_attachment,
      ratingSecId != null ? secs.get(ratingSecId) : undefined,
      ratingSecId != null ? quotes.get(ratingSecId) : undefined,
    ),
    blocks,
    visibleWordCount,
    hasGatedRemainder: item.is_premium,
    remainingWordsEstimate,
    tickers,
  };
}

/**
 * Research index list — ARTICLE-type content_items, newest first. `section`
 * narrows to one facet (Banks/Energy/…) when given. RLS restricts to
 * published rows; slug is required to link, so slugless rows (shouldn't occur
 * once the publish flow stamps one, but is true of every draft today) are
 * excluded in SQL.
 */
export async function listResearchArticles(
  opts: { section?: string; limit?: number } = {},
): Promise<ArticleSummary[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  cacheTag("content");
  cacheTag("articles");

  const sb = createAnonClient();
  const take = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  let q = sb
    .from("content_items")
    .select(SUMMARY_COLS)
    .eq("content_type", "ARTICLE")
    .not("slug", "is", null)
    .order("published_at", { ascending: false })
    .limit(take);
  if (opts.section) q = q.eq("section", opts.section);

  const { data } = await q;
  return ((data as ContentItemRow[] | null) ?? []).map(mapSummary);
}

/** Distinct `section` vocabulary among published articles, for the research
 *  index facet chips. Ordered by frequency (busiest sections first). */
export async function getArticleSectionFacets(): Promise<Array<{ section: string; count: number }>> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 86400 });
  cacheTag("articles");

  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select("section")
    .eq("content_type", "ARTICLE")
    .not("section", "is", null)
    .limit(2000);

  const counts = new Map<string, number>();
  for (const r of (data as Array<{ section: string | null }> | null) ?? []) {
    const t = (r.section ?? "").trim();
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count);
}

/** Recent articles excluding one id — the "Related" rail on the article page. */
export async function getRelatedArticles(excludeId: string, limit = 3): Promise<ArticleSummary[]> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 120, expire: 3600 });
  cacheTag("content");
  cacheTag("articles");

  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select(SUMMARY_COLS)
    .eq("content_type", "ARTICLE")
    .not("slug", "is", null)
    .neq("id", excludeId)
    .order("published_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 20));

  return ((data as ContentItemRow[] | null) ?? []).map(mapSummary);
}

/** Every published-article slug — for a future `sitemap.ts` entry (that file
 *  is foundation-owned per CONVENTIONS §1.6; wiring this in is a lead task). */
export async function listPublishedArticleSlugs(
  limit = 5000,
): Promise<Array<{ slug: string; updatedAt: string | null }>> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 86400 });
  cacheTag("articles");

  const sb = createAnonClient();
  const { data } = await sb
    .from("content_items")
    .select("slug,updated_at")
    .eq("content_type", "ARTICLE")
    .not("slug", "is", null)
    .limit(Math.min(Math.max(limit, 1), 45000));

  return ((data as Array<{ slug: string | null; updated_at: string | null }> | null) ?? [])
    .filter((r): r is { slug: string; updated_at: string | null } => r.slug != null)
    .map((r) => ({ slug: r.slug, updatedAt: r.updated_at }));
}

// ── Analysts (the Coverage Desk) ────────────────────────────────────────────

export interface AnalystLeaderboardRow {
  analystPrincipalId: string;
  title: string | null;
  isExternal: boolean;
  namesCovered: number;
  closedCallCount: number;
  winRatePct: number | null;
  avgCallReturnPct: number | null;
  /** Most recent five *closed* calls, newest first; true = beat the index. */
  lastFive: boolean[];
}

interface AnalystRow {
  principal_id: string;
  title: string | null;
  is_external: boolean;
}

interface AnalystCallRow {
  analyst_id: string;
  security_id: number;
  call_return_pct: unknown;
  vs_index_pct: unknown;
  closed_at: string | null;
  published_at: string;
}

/**
 * Leaderboard (1i). `analysts` is world-readable but 0 rows today (producer
 * pending — see AGENTS.md task brief); `analyst_calls` is also world-readable
 * and 0 rows. Both reads and the aggregation below are real and will light up
 * unmodified once analysts are seeded and start publishing calls.
 */
export async function getAnalystLeaderboard(limit = 20): Promise<AnalystLeaderboardRow[]> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 3600 });
  cacheTag("analysts");

  const sb = createAnonClient();
  const { data: analystRows } = await sb
    .from("analysts")
    .select("principal_id,title,is_external")
    .limit(200);
  const analysts = (analystRows as AnalystRow[] | null) ?? [];
  if (analysts.length === 0) return [];

  const ids = analysts.map((a) => a.principal_id);
  const { data: callRows } = await sb
    .from("analyst_calls")
    .select("analyst_id,security_id,call_return_pct,vs_index_pct,closed_at,published_at")
    .in("analyst_id", ids)
    .order("published_at", { ascending: false })
    .limit(4000);
  const calls = (callRows as AnalystCallRow[] | null) ?? [];

  const rows: AnalystLeaderboardRow[] = analysts.map((a) => {
    const mine = calls.filter((c) => c.analyst_id === a.principal_id);
    const closed = mine.filter((c) => c.closed_at != null);
    const wins = closed.filter((c) => (toNum(c.vs_index_pct) ?? 0) > 0);
    const avgReturn =
      closed.length === 0
        ? null
        : closed.reduce((sum, c) => sum + (toNum(c.call_return_pct) ?? 0), 0) / closed.length;
    const namesCovered = new Set(mine.map((c) => c.security_id)).size;
    const lastFive = closed
      .slice(0, 5)
      .map((c) => (toNum(c.vs_index_pct) ?? 0) > 0);

    return {
      analystPrincipalId: a.principal_id,
      title: a.title,
      isExternal: a.is_external,
      namesCovered,
      closedCallCount: closed.length,
      winRatePct: closed.length === 0 ? null : (wins.length / closed.length) * 100,
      avgCallReturnPct: avgReturn,
      lastFive,
    };
  });

  return rows
    .sort((a, b) => (b.avgCallReturnPct ?? -Infinity) - (a.avgCallReturnPct ?? -Infinity))
    .slice(0, limit);
}

/** Coverage-by-sector bar data — open (unclosed) calls grouped by security sector. */
export async function getCoverageBySector(): Promise<Array<{ sector: string; count: number }>> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });
  cacheTag("analysts");

  const sb = createAnonClient();
  const { data: callRows } = await sb
    .from("analyst_calls")
    .select("security_id")
    .is("closed_at", null)
    .limit(3000);
  const secIds = [...new Set(((callRows as Array<{ security_id: number }> | null) ?? []).map((r) => r.security_id))];
  if (secIds.length === 0) return [];

  const { data: secRows } = await sb.from("securities").select("id,sector").in("id", secIds);
  const counts = new Map<string, number>();
  for (const s of (secRows as Array<{ id: number; sector: string | null }> | null) ?? []) {
    const key = (s.sector ?? "unknown").trim();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([sector, count]) => ({ sector, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Analyst profile (1j) ─────────────────────────────────────────────────────

/** One `analyst_calls` row, joined to its security for the ticker rail. */
export interface AnalystCallView {
  id: number;
  securityId: number;
  ticker: string | null;
  venueCode: string | null;
  name: string | null;
  rating: string | null;
  priceTarget: number | null;
  publishedAt: string | null;
  /** Snapshotted by the `fn_analyst_call_freeze` trigger at publish time. */
  priceAtPublication: number | null;
  indexLevelAtPublication: number | null;
  closedAt: string | null;
  closePrice: number | null;
  /** Scoreboard math is computed in the DB — never recomputed here. */
  callReturnPct: number | null;
  vsIndexPct: number | null;
  /** The `content_items` row this call was published with, when there is one. */
  contentId: string | null;
}

export interface AnalystProfileDetail {
  /** `iam.principals.handle` — the public URL slug. */
  slug: string;
  displayName: string | null;
  title: string | null;
  credential: string | null;
  bio: string | null;
  isExternal: boolean;
  joinedAt: string | null;
  principalId: string;
  /** Newest first. */
  calls: AnalystCallView[];
  namesCovered: number;
  openCallCount: number;
  closedCallCount: number;
  /** Share of *closed* calls that beat their venue index; null with no closed calls. */
  winRatePct: number | null;
  /** Mean `call_return_pct` across closed calls; null with no closed calls. */
  avgCallReturnPct: number | null;
}

interface AnalystPublicRow {
  slug: string | null;
  display_name: string | null;
  title: string | null;
  credential: string | null;
  bio: string | null;
  is_external: boolean | null;
  joined_at: string | null;
  principal_id: string;
}

interface AnalystCallDetailRow {
  id: number;
  security_id: number;
  rating: string | null;
  price_target: unknown;
  published_at: string | null;
  price_at_publication: unknown;
  index_level_at_publication: unknown;
  closed_at: string | null;
  close_price: unknown;
  call_return_pct: unknown;
  vs_index_pct: unknown;
  content_id: string | null;
}

const ANALYST_PUBLIC_COLS =
  "slug,display_name,title,credential,bio,is_external,joined_at,principal_id";

const ANALYST_CALL_COLS =
  "id,security_id,rating,price_target,published_at,price_at_publication,index_level_at_publication,closed_at,close_price,call_return_pct,vs_index_pct,content_id";

/**
 * Analyst profile by slug (1j) — reads `public.v_analysts_public`, the
 * `security_invoker = false` view added by `20260726190625_v_analysts_public.sql`
 * (see file header). The slug **is** `iam.principals.handle`; there is no other
 * public identifier for an analyst.
 *
 * The roster is 0 rows until the seed lands (BRIDGE-BUILD-PLAN P3.1), so every
 * slug returns `null` today — the caller must `notFound()` on null rather than
 * render a placeholder profile (Law #2: never fabricate).
 *
 * The scoreboard columns (`call_return_pct`, `vs_index_pct`, and the
 * publication-time price/index snapshots) are all produced in Postgres by
 * `fn_analyst_call_freeze` and the close path — this function aggregates them
 * but never derives them, so the FE can never disagree with the leaderboard.
 */
export async function getAnalystProfileBySlug(slug: string): Promise<AnalystProfileDetail | null> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 300, expire: 3600 });
  cacheTag("analysts");

  const s = (slug ?? "").trim();
  if (!s) return null;

  const sb = createAnonClient();
  const { data: profile } = await sb
    .from("v_analysts_public")
    .select(ANALYST_PUBLIC_COLS)
    .eq("slug", s)
    .maybeSingle<AnalystPublicRow>();
  if (!profile) return null;

  const { data: callRows } = await sb
    .from("analyst_calls")
    .select(ANALYST_CALL_COLS)
    .eq("analyst_id", profile.principal_id)
    .order("published_at", { ascending: false })
    .limit(500);

  const raw = (callRows as AnalystCallDetailRow[] | null) ?? [];
  const secs = await secLiteMap(sb, raw.map((c) => c.security_id));

  const calls: AnalystCallView[] = raw.map((c) => {
    const sec = secs.get(c.security_id);
    return {
      id: c.id,
      securityId: c.security_id,
      ticker: sec?.ticker ?? null,
      venueCode: sec?.venue_code ?? null,
      name: sec?.name_en ?? null,
      rating: c.rating,
      priceTarget: toNum(c.price_target),
      publishedAt: c.published_at,
      priceAtPublication: toNum(c.price_at_publication),
      indexLevelAtPublication: toNum(c.index_level_at_publication),
      closedAt: c.closed_at,
      closePrice: toNum(c.close_price),
      callReturnPct: toNum(c.call_return_pct),
      vsIndexPct: toNum(c.vs_index_pct),
      contentId: c.content_id,
    };
  });

  const closed = calls.filter((c) => c.closedAt != null);
  const wins = closed.filter((c) => (c.vsIndexPct ?? 0) > 0);
  const avgCallReturnPct =
    closed.length === 0
      ? null
      : closed.reduce((sum, c) => sum + (c.callReturnPct ?? 0), 0) / closed.length;

  return {
    slug: profile.slug ?? s,
    displayName: profile.display_name,
    title: profile.title,
    credential: profile.credential,
    bio: profile.bio,
    isExternal: profile.is_external ?? false,
    joinedAt: profile.joined_at,
    principalId: profile.principal_id,
    calls,
    namesCovered: new Set(calls.map((c) => c.securityId)).size,
    openCallCount: calls.length - closed.length,
    closedCallCount: closed.length,
    winRatePct: closed.length === 0 ? null : (wins.length / closed.length) * 100,
    avgCallReturnPct,
  };
}
