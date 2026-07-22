import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { createAnonClient } from "@/lib/supabase/public";
import { getFxUsdRates } from "./entities";
import { getDividendsForSecurity } from "./stock-events";
import { toNum, toInt } from "./util";

/**
 * Overview-BODY reads for the stock page (design screens 1g / 3a): the
 * key-ratios strip, the sector peer-comparison table, and the dividend rail
 * box. Every export is a `use cache` fn over the anon-RLS surface, same shape
 * as `stocks.ts` / `entities.ts` — this file does not duplicate either (it
 * reuses `getFxUsdRates` and `getDividendsForSecurity` rather than re-querying
 * `fx_rates` / `dividends` directly).
 *
 * PREMIUM BOUNDARY (hard rule, matches `entities.ts`'s KEY_RATIOS_FREE_COLS
 * contract exactly): this file NEVER selects a premium `key_ratios` column —
 * pe / pb / roe / dividend_yield / payout_ratio / roce / nim / net_debt_ebitda
 * / ev_ebitda / ps / book_value_ps all stay behind `marsad_worker`'s RLS and
 * are NEVER queried here, only through `public.v_key_ratios_public`'s free
 * projection (market_cap / eps_ttm / margins / growth / returns). Callers
 * render those premium fields as a locked 🔒 affordance — no number, ever.
 */

// ── Shared display helpers ──────────────────────────────────────────────────

/** Compact LOCAL-currency market cap for a single security (e.g. "SAR 6.48T").
 *  Extends `fmtCompact` (src/lib/reader/format.ts) with a trillion step — GCC
 *  mega-caps (Aramco ≈ SAR 6.5T) round-trip through `fmtCompact` as "6480.00B",
 *  which the design never shows, so this stays local to the Overview module
 *  rather than changing the shared formatter other (untouched) surfaces rely on. */
export function fmtMarketCapLocal(n: number | null, ccy: string | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const scaled =
    abs >= 1e12 ? `${(n / 1e12).toFixed(2)}T` :
    abs >= 1e9 ? `${(n / 1e9).toFixed(2)}B` :
    abs >= 1e6 ? `${(n / 1e6).toFixed(2)}M` :
    Math.round(n).toLocaleString("en-US");
  return ccy ? `${ccy} ${scaled}` : scaled;
}

/** Compact USD-normalized market cap (e.g. "$1.73T") — used ONLY where values
 *  from different currencies are compared side-by-side (the peer table), so a
 *  raw local-currency sum/sort never silently mixes SAR with KWD. */
export function fmtCompactUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** `key_ratios` return/growth columns are fractions (e.g. `-0.042` = −4.2%,
 *  per CompareTable.tsx's identical convention) — scale at the display
 *  boundary only, never in the cached data. */
export function pctFrac(n: number | null): number | null {
  return n == null ? null : n * 100;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Key ratios strip (screen 3a, 9-col grid — free half only) ──────────────

export interface KeyRatiosStripData {
  price: number | null;
  week52Low: number | null;
  week52High: number | null;
  marketCap: number | null;
  marketCapCurrency: string | null;
}

interface StripQuoteRow {
  last: unknown;
  week52_high: unknown;
  week52_low: unknown;
}
interface StripKeyRatiosRow {
  market_cap: unknown;
  currency_computed: string | null;
}

/** The strip's 3 FREE cells (market cap, price, 52w hi/lo). The other 6 cells
 *  (P/E TTM, book value, div yield, ROCE, ROE, net debt/EBITDA) are premium —
 *  the caller renders those as a locked stub without calling this fn again. */
export async function getKeyRatiosStrip(securityId: number): Promise<KeyRatiosStripData> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  cacheTag(`stock:${securityId}`);

  const sb = createAnonClient();
  const [{ data: quote }, { data: kr }] = await Promise.all([
    sb
      .from("quotes_latest")
      .select("last,week52_high,week52_low")
      .eq("security_id", securityId)
      .maybeSingle<StripQuoteRow>(),
    sb
      .from("v_key_ratios_public")
      .select("market_cap,currency_computed")
      .eq("security_id", securityId)
      .maybeSingle<StripKeyRatiosRow>(),
  ]);

  return {
    price: toNum(quote?.last),
    week52Low: toNum(quote?.week52_low),
    week52High: toNum(quote?.week52_high),
    marketCap: toNum(kr?.market_cap),
    marketCapCurrency: kr?.currency_computed ?? null,
  };
}

// ── Peer comparison (screen 3a — sector peers, top by market cap) ──────────

export interface PeerRow {
  securityId: number;
  venueCode: string;
  ticker: string;
  name: string;
  price: number | null;
  /** USD-normalized (via `getFxUsdRates`) so cross-venue/cross-currency peers
   *  sort and compare validly — see the file-header note. */
  marketCapUsd: number | null;
  /** Fraction (e.g. -0.042 = -4.2%) — scale with `pctFrac` at render time. */
  ret3m: number | null;
  score: number | null;
  isSelf: boolean;
}

export interface PeerComparisonData {
  sector: string | null;
  /** Self + up to `PEER_LIMIT - 1` other sector peers, sorted by USD market
   *  cap descending (self included wherever it naturally ranks). */
  peers: PeerRow[];
  /** Total OTHER (ex-self) sector peers found — may exceed `peers.length - 1`
   *  if the sector has more names than the display cap. */
  peerCount: number;
  medianMarketCapUsd: number | null;
  medianRet3m: number | null;
}

interface PeerSecRow {
  id: number;
  venue_code: string;
  ticker: string;
  name_en: string;
  currency: string | null;
}
interface PeerQuoteRow {
  security_id: number;
  last: unknown;
}
interface PeerKeyRatiosRow {
  security_id: number;
  market_cap: unknown;
  ret_3m: unknown;
  currency_computed: string | null;
}
interface PeerScoreRow {
  security_id: number;
  score: number | null;
}

const PEER_LIMIT = 8;
const EMPTY_PEERS: PeerComparisonData = {
  sector: null,
  peers: [],
  peerCount: 0,
  medianMarketCapUsd: null,
  medianRet3m: null,
};

/** Sector peers for one security: same `securities.sector`, top by USD market
 *  cap, self row always included. Reads `securities` + `quotes_latest` +
 *  `v_scores_public` (headline score only) + `v_key_ratios_public` (free cols
 *  only) + `fx_rates` (via `getFxUsdRates`) — never a premium ratio column. */
export async function getPeerComparison(securityId: number): Promise<PeerComparisonData> {
  "use cache";
  cacheLife({ stale: 120, revalidate: 600, expire: 3600 });
  cacheTag(`stock:${securityId}`);
  cacheTag("compare"); // same invalidation family as Compare (fx_rates / key_ratios)

  const sb = createAnonClient();
  const { data: self } = await sb
    .from("securities")
    .select("sector")
    .eq("id", securityId)
    .maybeSingle<{ sector: string | null }>();
  const sector = self?.sector ?? null;
  if (!sector) return EMPTY_PEERS;

  const [{ data: secs }, fx] = await Promise.all([
    sb
      .from("securities")
      .select("id,venue_code,ticker,name_en,currency")
      .eq("sector", sector)
      .in("status", ["listed", "suspended"]),
    getFxUsdRates(),
  ]);

  const secRows = (secs as PeerSecRow[] | null) ?? [];
  if (secRows.length === 0) return { ...EMPTY_PEERS, sector };

  const ids = secRows.map((s) => s.id);
  const [{ data: quotes }, { data: krs }, { data: scores }] = await Promise.all([
    sb.from("quotes_latest").select("security_id,last").in("security_id", ids),
    sb.from("v_key_ratios_public").select("security_id,market_cap,ret_3m,currency_computed").in("security_id", ids),
    sb.from("v_scores_public").select("security_id,score").in("security_id", ids),
  ]);

  const quoteById = new Map<number, PeerQuoteRow>();
  for (const q of (quotes as PeerQuoteRow[] | null) ?? []) quoteById.set(q.security_id, q);
  const krById = new Map<number, PeerKeyRatiosRow>();
  for (const k of (krs as PeerKeyRatiosRow[] | null) ?? []) krById.set(k.security_id, k);
  const scoreById = new Map<number, PeerScoreRow>();
  for (const s of (scores as PeerScoreRow[] | null) ?? []) scoreById.set(s.security_id, s);

  const all: PeerRow[] = secRows.map((s) => {
    const kr = krById.get(s.id);
    const mcapLocal = toNum(kr?.market_cap);
    const ccy = (kr?.currency_computed ?? s.currency ?? "").trim().toUpperCase();
    const usdPerUnit = ccy ? (fx[ccy] ?? null) : null;
    const marketCapUsd = mcapLocal != null && usdPerUnit != null ? mcapLocal * usdPerUnit : null;
    return {
      securityId: s.id,
      venueCode: s.venue_code,
      ticker: s.ticker,
      name: s.name_en,
      price: toNum(quoteById.get(s.id)?.last),
      marketCapUsd,
      ret3m: toNum(kr?.ret_3m),
      score: toInt(scoreById.get(s.id)?.score ?? null),
      isSelf: s.id === securityId,
    };
  });

  const selfRow = all.find((p) => p.isSelf) ?? null;
  const others = all
    .filter((p) => !p.isSelf)
    .sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));

  const top = others.slice(0, selfRow ? PEER_LIMIT - 1 : PEER_LIMIT);
  const peers = (selfRow ? [selfRow, ...top] : top).sort(
    (a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1),
  );

  return {
    sector,
    peers,
    peerCount: others.length,
    medianMarketCapUsd: median(others.map((o) => o.marketCapUsd).filter((n): n is number => n != null)),
    medianRet3m: median(others.map((o) => o.ret3m).filter((n): n is number => n != null)),
  };
}

// ── Dividend box (rail, screen 1g) ──────────────────────────────────────────

export interface DividendBoxData {
  exDate: string | null;
  dps: number | null;
  fiscalRef: string | null;
  currency: string | null;
  yieldPct: number | null;
  payoutPct: number | null;
}

const EMPTY_DIVIDEND_BOX: DividendBoxData = {
  exDate: null,
  dps: null,
  fiscalRef: null,
  currency: null,
  yieldPct: null,
  payoutPct: null,
};

/** Derives the rail's 4-stat dividend box from the most recently disclosed
 *  `dividends` row for this security. Reuses `getDividendsForSecurity`
 *  (stock-events.ts) rather than re-querying `dividends` — that fn's RLS
 *  `world_read` policy only exposes `state = 'live'` rows to anon, so this
 *  resolves to the honest all-"—" box until the 33b confirm gate promotes a
 *  row (see stock-events.ts's module doc — today that is every security). */
export async function getDividendBox(securityId: number): Promise<DividendBoxData> {
  const items = await getDividendsForSecurity(securityId, 1);
  const latest = items[0];
  if (!latest) return EMPTY_DIVIDEND_BOX;

  return {
    exDate: latest.exDate,
    dps: latest.dps,
    fiscalRef: latest.fiscalRef,
    currency: latest.currency,
    yieldPct: latest.yieldAtAnnounce != null ? latest.yieldAtAnnounce * 100 : null,
    payoutPct: latest.payoutRatio != null ? latest.payoutRatio * 100 : null,
  };
}
