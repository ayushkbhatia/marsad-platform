import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { toNum, toInt } from "./util";

/**
 * Compare + Entities (Investors/Holders, Datapoint series) reads. Every export is a
 * `use cache` fn over the anon-RLS surface, same shape as `src/lib/data/stocks.ts`.
 *
 * ── FLAG TO THE LEAD (blocks Compare's ratio columns) ──────────────────────────
 * `public.key_ratios` has RLS enabled with exactly ONE policy — `worker_all` scoped to
 * `marsad_worker` (verified live via the Supabase MCP against project yjsncnpbjuueaoeejrqj).
 * There is no `world_read` policy and no `v_key_ratios_public` view (unlike `scores`, which has
 * both `scores.premium_read` AND the anon-safe `public.v_scores_public` wrapper). Concretely:
 * anon HAS the base table-level SELECT grant, but RLS filters every row to zero for anon/
 * authenticated — so `getCompareEntity` below always resolves `market_cap`/`eps_ttm`/`ret_*`/
 * `*_margin`/`*_growth_yoy` to `null` today, NOT because the query is wrong, but because the row
 * literally isn't visible yet. Quote (`quotes_latest`) and the headline score (`v_scores_public`)
 * both DO have `world_read` and work today — Compare ships with real price + score, ratios show
 * "—" until this lands.
 *
 * Proposed fix (mirrors the existing `v_scores_public` pattern exactly — smallest, safest diff):
 *   create view public.v_key_ratios_public as
 *     select security_id, market_cap, eps_ttm, net_margin, gross_margin,
 *            rev_growth_yoy, eps_growth_yoy, ret_3m, ret_6m, ret_12_1,
 *            currency_computed, computed_at
 *     from public.key_ratios;
 *   grant select on public.v_key_ratios_public to anon, authenticated;
 * (Never add pe/pb/roe/dividend_yield/roce/nim/ev_ebitda/net_debt_ebitda/payout_ratio/ps/
 * book_value_ps to that view — those stay premium-only, read exclusively by `marsad_worker` /
 * the `fn_screener_run` SECURITY DEFINER RPC.) Once shipped, swap `getCompareEntity`'s
 * `.from("key_ratios")` below to `.from("v_key_ratios_public")` — the rest of the function is
 * already correct and needs no other change. Until then this file NEVER selects a premium
 * column, matching `screener.ts`'s "no code path can reach a premium table" contract.
 */

// ── FX (USD normalization for Compare's market-cap row) ────────────────────────

/** USD value of one unit of each local currency, derived from `fx_rates` (`USDxxx` pairs,
 *  e.g. `USDSAR=3.75` ⇒ 1 SAR = 1/3.75 USD). GCC pegs move rarely; cached long. */
export async function getFxUsdRates(): Promise<Record<string, number>> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 21600, expire: 172800 });
  cacheTag("fx");

  const sb = createAnonClient();
  const { data } = await sb.from("fx_rates").select("pair,rate");

  const out: Record<string, number> = { USD: 1 };
  for (const r of (data as Array<{ pair: string; rate: unknown }> | null) ?? []) {
    const m = /^USD([A-Z]{3})$/.exec((r.pair ?? "").trim().toUpperCase());
    const rate = toNum(r.rate);
    if (m && rate && rate > 0) out[m[1]] = 1 / rate;
  }
  return out;
}

// ── Compare (18a) ────────────────────────────────────────────────────────────

export interface CompareEntity {
  securityId: number;
  venueCode: string;
  ticker: string;
  name: string;
  sector: string | null;
  currency: string | null;
  last: number | null;
  changePct: number | null;
  score: number | null;
  /** Uppercase DB vocabulary (BUY/OVERWEIGHT/HOLD/…) — map via `toRating` to render. */
  rating: string | null;
  /** null until the `key_ratios` anon-read gap above is fixed. */
  marketCapUsd: number | null;
  epsTtm: number | null;
  ret3m: number | null;
  ret6m: number | null;
  ret12_1: number | null;
  netMargin: number | null;
  grossMargin: number | null;
  revGrowthYoy: number | null;
  epsGrowthYoy: number | null;
  ratiosComputedAt: string | null;
}

interface SecurityIdRow {
  id: number;
  venue_code: string;
  ticker: string;
  name_en: string;
  sector: string | null;
  currency: string | null;
}
interface QuoteLastRow {
  security_id: number;
  last: unknown;
  change_pct: unknown;
}
interface ScorePublicRow {
  security_id: number;
  score: number | null;
  rating: string | null;
}
/** Free-tier columns ONLY — see the file-header flag. Never add a premium column here. */
interface KeyRatiosFreeRow {
  security_id: number;
  market_cap: unknown;
  eps_ttm: unknown;
  net_margin: unknown;
  gross_margin: unknown;
  rev_growth_yoy: unknown;
  eps_growth_yoy: unknown;
  ret_3m: unknown;
  ret_6m: unknown;
  ret_12_1: unknown;
  currency_computed: string | null;
  computed_at: string | null;
}

const KEY_RATIOS_FREE_COLS =
  "security_id,market_cap,eps_ttm,net_margin,gross_margin,rev_growth_yoy,eps_growth_yoy,ret_3m,ret_6m,ret_12_1,currency_computed,computed_at";

/**
 * One Compare column: identity + quote + headline score + the free `key_ratios` fields
 * (USD-normalized market cap; everything else stays in local currency / percent). Tagged
 * `stock:{id}` (same tag the score batch / quote pulse already revalidate) plus `compare`.
 */
export async function getCompareEntity(securityId: number): Promise<CompareEntity | null> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag(`stock:${securityId}`);
  cacheTag("compare");

  const sb = createAnonClient();
  const [{ data: sec }, { data: quote }, { data: kr }, { data: score }, fx] = await Promise.all([
    sb
      .from("securities")
      .select("id,venue_code,ticker,name_en,sector,currency")
      .eq("id", securityId)
      .maybeSingle<SecurityIdRow>(),
    sb.from("quotes_latest").select("security_id,last,change_pct").eq("security_id", securityId).maybeSingle<QuoteLastRow>(),
    // Free columns only — see file header. Resolves to `null` today (anon-RLS gap on key_ratios).
    sb.from("key_ratios").select(KEY_RATIOS_FREE_COLS).eq("security_id", securityId).maybeSingle<KeyRatiosFreeRow>(),
    sb.from("v_scores_public").select("security_id,score,rating").eq("security_id", securityId).maybeSingle<ScorePublicRow>(),
    getFxUsdRates(),
  ]);

  if (!sec) return null;

  const marketCapLocal = toNum(kr?.market_cap);
  const ccy = (kr?.currency_computed ?? sec.currency ?? "").trim().toUpperCase();
  const usdPerUnit = ccy ? (fx[ccy] ?? null) : null;
  const marketCapUsd = marketCapLocal != null && usdPerUnit != null ? marketCapLocal * usdPerUnit : null;

  return {
    securityId: sec.id,
    venueCode: sec.venue_code,
    ticker: sec.ticker,
    name: sec.name_en,
    sector: sec.sector ?? null,
    currency: sec.currency ?? null,
    last: toNum(quote?.last),
    changePct: toNum(quote?.change_pct),
    score: toInt(score?.score ?? null),
    rating: score?.rating ?? null,
    marketCapUsd,
    epsTtm: toNum(kr?.eps_ttm),
    ret3m: toNum(kr?.ret_3m),
    ret6m: toNum(kr?.ret_6m),
    ret12_1: toNum(kr?.ret_12_1),
    netMargin: toNum(kr?.net_margin),
    grossMargin: toNum(kr?.gross_margin),
    revGrowthYoy: toNum(kr?.rev_growth_yoy),
    epsGrowthYoy: toNum(kr?.eps_growth_yoy),
    ratiosComputedAt: kr?.computed_at ?? null,
  };
}

/** Parse `?t=TDWL:2222,QE:QNBK,ADX:FAB` into up to 4 (venue,ticker) pairs. Malformed/blank
 *  segments are dropped; callers resolve each pair via `resolveSecurity` (which itself 404s
 *  unknown venue/ticker combinations) — this fn only shapes the URL. */
export function parseComparePairs(raw: string | string[] | undefined): Array<{ venue: string; ticker: string }> {
  const s = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const out: Array<{ venue: string; ticker: string }> = [];
  const seen = new Set<string>();
  for (const part of s.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [venue, ticker] = trimmed.split(":");
    if (!venue || !ticker) continue;
    const key = `${venue.trim().toUpperCase()}:${ticker.trim().toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ venue: venue.trim().toUpperCase(), ticker: ticker.trim().toUpperCase() });
    if (out.length >= 4) break;
  }
  return out;
}

// ── Investors / holders directory (20b) ─────────────────────────────────────

export interface HolderListItem {
  id: number;
  slug: string;
  name: string;
  holderType: string;
  country: string | null;
  disclosedValueUsd: number | null;
  aumSelfReported: boolean;
  holdingsCount: number;
}

function slugifyHolderName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "holder"
  );
}
export function holderSlug(h: { id: number; name: string }): string {
  return `${slugifyHolderName(h.name)}-${h.id}`;
}
function parseHolderId(slug: string): number | null {
  const m = /-(\d+)$/.exec((slug ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface HolderRow {
  id: number;
  name: string;
  holder_type: string;
  country: string | null;
  disclosed_value_usd: unknown;
  aum_self_reported: boolean;
}

/** Full holders directory (0 rows today — producer pending, see CONVENTIONS §6). Grouped
 *  `holdingsCount` comes from a second query over `holder_positions`, not a stored column. */
export async function getHoldersDirectory(): Promise<HolderListItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 900, expire: 86400 });
  cacheTag("holders");

  const sb = createAnonClient();
  const [{ data: holders }, { data: positions }] = await Promise.all([
    sb
      .from("holders")
      .select("id,name,holder_type,country,disclosed_value_usd,aum_self_reported")
      .order("disclosed_value_usd", { ascending: false, nullsFirst: false }),
    sb.from("holder_positions").select("holder_id,security_id"),
  ]);

  const holdingsByHolder = new Map<number, Set<number>>();
  for (const p of (positions as Array<{ holder_id: number; security_id: number }> | null) ?? []) {
    if (!holdingsByHolder.has(p.holder_id)) holdingsByHolder.set(p.holder_id, new Set());
    holdingsByHolder.get(p.holder_id)!.add(p.security_id);
  }

  return ((holders as HolderRow[] | null) ?? []).map((h) => ({
    id: h.id,
    slug: holderSlug(h),
    name: h.name,
    holderType: h.holder_type,
    country: h.country,
    disclosedValueUsd: toNum(h.disclosed_value_usd),
    aumSelfReported: h.aum_self_reported,
    holdingsCount: holdingsByHolder.get(h.id)?.size ?? 0,
  }));
}

// ── Investor detail (20c) ────────────────────────────────────────────────────

export interface HolderPositionItem {
  securityId: number;
  venueCode: string;
  ticker: string;
  companyName: string;
  sector: string | null;
  asOf: string;
  stakePct: number | null;
  qoqChangePp: number | null;
  /** Derived (`holder_positions` carries no value column): stakePct/100 × the position's
   *  USD-normalized market cap, sourced from `key_ratios` — subject to the same anon-RLS gap
   *  flagged at the top of this file, so this resolves to `null` until that lands too. */
  valueUsd: number | null;
}

export interface SectorTiltItem {
  sector: string;
  weightPct: number;
}

export interface HolderDetail {
  id: number;
  slug: string;
  name: string;
  holderType: string;
  country: string | null;
  established: number | null;
  disclosedValueUsd: number | null;
  aumSelfReported: boolean;
  positions: HolderPositionItem[];
  sectorTilt: SectorTiltItem[];
  totalPositionValueUsd: number | null;
}

/** Resolve a `/investors/[slug]` slug → full holder record + disclosed positions. Returns
 *  `null` for a malformed slug OR (today, always) because `holders` has 0 rows — the route
 *  renders `EmptyState awaitingFeed`, same treatment as `getIpoOffer` / `ipo/[offerSlug]`. */
export async function getHolderDetail(slug: string): Promise<HolderDetail | null> {
  "use cache";
  const id = parseHolderId(slug);
  if (id == null) return null;

  cacheLife({ stale: 300, revalidate: 900, expire: 86400 });
  cacheTag(`holder:${id}`);
  cacheTag("holders");

  const sb = createAnonClient();
  const { data: holder } = await sb
    .from("holders")
    .select("id,name,holder_type,country,established,disclosed_value_usd,aum_self_reported")
    .eq("id", id)
    .maybeSingle<HolderRow & { established: number | null }>();
  if (!holder) return null;

  const [{ data: positions }, fx] = await Promise.all([
    sb
      .from("holder_positions")
      .select("security_id,as_of,stake_pct,qoq_change_pp")
      .eq("holder_id", id)
      .order("as_of", { ascending: false }),
    getFxUsdRates(),
  ]);

  const posRows =
    (positions as Array<{ security_id: number; as_of: string; stake_pct: unknown; qoq_change_pp: unknown }> | null) ?? [];
  const secIds = [...new Set(posRows.map((p) => p.security_id))];

  const secMap = new Map<number, SecurityIdRow>();
  const krMap = new Map<number, { market_cap: unknown; currency_computed: string | null }>();
  if (secIds.length > 0) {
    const [{ data: secs }, { data: krs }] = await Promise.all([
      sb.from("securities").select("id,venue_code,ticker,name_en,sector,currency").in("id", secIds),
      sb.from("key_ratios").select("security_id,market_cap,currency_computed").in("security_id", secIds),
    ]);
    for (const s of (secs as SecurityIdRow[] | null) ?? []) secMap.set(s.id, s);
    for (const k of (krs as Array<{ security_id: number; market_cap: unknown; currency_computed: string | null }> | null) ?? [])
      krMap.set(k.security_id, k);
  }

  // Latest disclosed position per security (posRows already ordered as_of desc).
  const seen = new Set<number>();
  const positions_: HolderPositionItem[] = [];
  for (const p of posRows) {
    if (seen.has(p.security_id)) continue;
    seen.add(p.security_id);
    const sec = secMap.get(p.security_id);
    if (!sec) continue;
    const kr = krMap.get(p.security_id);
    const stakePct = toNum(p.stake_pct);
    const mcapLocal = toNum(kr?.market_cap);
    const ccy = (kr?.currency_computed ?? sec.currency ?? "").trim().toUpperCase();
    const usdPerUnit = ccy ? (fx[ccy] ?? null) : null;
    const mcapUsd = mcapLocal != null && usdPerUnit != null ? mcapLocal * usdPerUnit : null;
    const valueUsd = stakePct != null && mcapUsd != null ? (stakePct / 100) * mcapUsd : null;
    positions_.push({
      securityId: p.security_id,
      venueCode: sec.venue_code,
      ticker: sec.ticker,
      companyName: sec.name_en,
      sector: sec.sector,
      asOf: p.as_of,
      stakePct,
      qoqChangePp: toNum(p.qoq_change_pp),
      valueUsd,
    });
  }
  positions_.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const bySector = new Map<string, number>();
  let total = 0;
  for (const p of positions_) {
    if (p.valueUsd == null) continue;
    const key = p.sector ?? "unknown";
    bySector.set(key, (bySector.get(key) ?? 0) + p.valueUsd);
    total += p.valueUsd;
  }
  const sectorTilt: SectorTiltItem[] =
    total > 0
      ? [...bySector.entries()].map(([sector, v]) => ({ sector, weightPct: (v / total) * 100 })).sort((a, b) => b.weightPct - a.weightPct)
      : [];

  return {
    id: holder.id,
    slug: holderSlug(holder),
    name: holder.name,
    holderType: holder.holder_type,
    country: holder.country,
    established: toInt(holder.established),
    disclosedValueUsd: toNum(holder.disclosed_value_usd),
    aumSelfReported: holder.aum_self_reported,
    positions: positions_,
    sectorTilt,
    totalPositionValueUsd: total > 0 ? total : null,
  };
}

// ── Datapoint series (18b) ────────────────────────────────────────────────────

export interface DatapointValueItem {
  period: string;
  periodEnd: string;
  value: number | null;
  prevValue: number | null;
  qoqDelta: number | null;
  asOf: string | null;
}

export interface DatapointSeriesDetail {
  id: number;
  securityId: number | null;
  ticker: string | null;
  companyName: string | null;
  venueCode: string | null;
  entityKind: string;
  entityRef: string | null;
  metricKey: string;
  displayName: string;
  unit: string;
  cadence: string;
  isPublic: boolean;
  revisionSlaHours: number;
  isAnalystMaintained: boolean;
  /** Newest period first. */
  values: DatapointValueItem[];
  latest: DatapointValueItem | null;
}

export interface RelatedSeriesItem {
  id: number;
  displayName: string;
}

interface DatapointSeriesRow {
  id: number;
  security_id: number | null;
  entity_kind: string;
  entity_ref: string | null;
  metric_key: string;
  display_name: string;
  unit: string;
  cadence: string;
  maintainer_id: string | null;
  revision_sla_hours: number;
  is_public: boolean;
}

/** Resolve a `/datapoints/[seriesId]` numeric id → the series + its live values (revisions
 *  excluded via `superseded_by is null`). Returns `null` for a malformed id OR (today, always,
 *  `datapoint_series`/`datapoints` are 0 rows) an unknown series — the route renders
 *  `EmptyState awaitingFeed`, same non-404 treatment as the IPO/holder detail pages. Never joins
 *  `iam.principals` (the `maintainer_id` FK target) — that schema is staff-internal, not part of
 *  the anon-safe `public` surface, so the page shows "analyst-maintained" generically rather than
 *  a resolved name. */
export async function getDatapointSeries(seriesId: number): Promise<DatapointSeriesDetail | null> {
  "use cache";
  if (!Number.isInteger(seriesId) || seriesId <= 0) return null;

  cacheLife({ stale: 300, revalidate: 900, expire: 86400 });
  cacheTag(`datapoint-series:${seriesId}`);
  cacheTag("datapoints");

  const sb = createAnonClient();
  const { data: series } = await sb
    .from("datapoint_series")
    .select("id,security_id,entity_kind,entity_ref,metric_key,display_name,unit,cadence,maintainer_id,revision_sla_hours,is_public")
    .eq("id", seriesId)
    .eq("is_public", true)
    .maybeSingle<DatapointSeriesRow>();
  if (!series) return null;

  const [{ data: sec }, { data: values }] = await Promise.all([
    series.security_id
      ? sb.from("securities").select("venue_code,ticker,name_en").eq("id", series.security_id).maybeSingle<{
          venue_code: string;
          ticker: string;
          name_en: string;
        }>()
      : Promise.resolve({ data: null }),
    sb
      .from("datapoints")
      .select("period,period_end,value,prev_value,as_of")
      .eq("series_id", seriesId)
      .is("superseded_by", null)
      .order("period_end", { ascending: false })
      .limit(40),
  ]);

  const valueRows: DatapointValueItem[] = (
    (values as Array<{ period: string; period_end: string; value: unknown; prev_value: unknown; as_of: string | null }> | null) ?? []
  ).map((v) => {
    const value = toNum(v.value);
    const prevValue = toNum(v.prev_value);
    return {
      period: v.period,
      periodEnd: v.period_end,
      value,
      prevValue,
      qoqDelta: value != null && prevValue != null ? value - prevValue : null,
      asOf: v.as_of ?? null,
    };
  });

  return {
    id: series.id,
    securityId: series.security_id,
    ticker: sec?.ticker ?? null,
    companyName: sec?.name_en ?? null,
    venueCode: sec?.venue_code ?? null,
    entityKind: series.entity_kind,
    entityRef: series.entity_ref,
    metricKey: series.metric_key,
    displayName: series.display_name,
    unit: series.unit,
    cadence: series.cadence,
    isPublic: series.is_public,
    revisionSlaHours: series.revision_sla_hours,
    isAnalystMaintained: series.maintainer_id != null,
    values: valueRows,
    latest: valueRows[0] ?? null,
  };
}

/** Other public series tracked for the same security (design's "Related series" rail). */
export async function getRelatedSeries(securityId: number, excludeSeriesId: number, limit = 3): Promise<RelatedSeriesItem[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 900, expire: 86400 });
  cacheTag("datapoints");

  const sb = createAnonClient();
  const { data } = await sb
    .from("datapoint_series")
    .select("id,display_name")
    .eq("security_id", securityId)
    .eq("is_public", true)
    .neq("id", excludeSeriesId)
    .order("display_name", { ascending: true })
    .limit(limit);

  return ((data as Array<{ id: number; display_name: string }> | null) ?? []).map((d) => ({ id: d.id, displayName: d.display_name }));
}
