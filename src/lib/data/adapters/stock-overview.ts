import "server-only";
import type { Overview, KeyRatio, Peer } from "@/lib/contracts/stock";
import type { ResolvedSecurity } from "@/lib/securities/resolve";
import { getStockOverview } from "@/lib/data/stocks";
import { getKeyRatiosRow, derivePe } from "@/lib/data/stock-ratios";
import { getPeerComparison } from "@/lib/data/stock-overview";
import { fmtPrice, fmtCompact, fmtSignedPct, currencyLabel, sectorLabel } from "@/lib/reader/format";

/**
 * ADAPTER: real reads → the `Overview` view-model contract (design 3a).
 *
 * WHAT IS REAL: the 9 key ratios, the price sparkline, and the peer table —
 * all from `v_key_ratios_public`, `ohlcv_daily`, `quotes_latest` and
 * `v_scores_public`.
 *
 * WHAT IS NOT, AND WHY (this matters — see Law #1/#2 in the build plan):
 * - `aboutHtml`, `keyPoints`, `deskView`, `pros`, `cons`, `prosConsNote` are
 *   EDITORIAL fields. There is no company-description or desk-view column
 *   anywhere in the schema, so they are returned EMPTY and the component omits
 *   each block. They are explicitly NOT sample-filled: borrowing one company's
 *   description for another is misinformation, not a placeholder. Tracked as
 *   **DEF-STOCK-EDITORIAL-FIELDS**; the honest source is a desk-authored
 *   `content_items` row per security, not an LLM guess at render time.
 * - P/B, dividend yield, ROE and EV/EBITDA are absent from the free ratio view,
 *   so peer cells render "—" (DEF-STOCK-RATIO-GAPS). `dividend_yield` is NULL in
 *   ALL 736 rows upstream, so it could not be shown even if the column existed.
 * - P/E is derived (price ÷ eps_ttm) and is SUPPRESSED for TDWL while
 *   `DEF-TDWL-EPS-MAPPING` is open — see `derivePe`.
 */
const DASH = "—";

function pct(n: number | null): string {
  return n == null ? DASH : fmtSignedPct(n * 100);
}

/**
 * ⚠️ `v_key_ratios_public.net_margin` is WRONG FOR BANKS and is suppressed for
 * them. Measured 2026-07-27 against a TTM recomputation from
 * `financial_statements` (4 most recent filed quarters):
 *
 *   non-banks match EXACTLY — DTC 9.9 vs 9.9, Almarai 10.6 vs 10.6, Alba 15.4 vs 15.4
 *   banks are INFLATED    — ALRAJHI 64.5 actual vs 85.5 shown (+21.0pp),
 *                            CBQK 41.3 vs 56.7 (+15.4), QNBK 40.3 vs 50.1 (+9.8),
 *                            MARK 16.4 vs 21.1 (+4.7)
 *
 * The denominator is understated for lenders — the ratio job appears to divide by
 * a net-interest-income-like figure rather than total operating income. Banks are
 * the largest sector on these venues, so this is not a rounding quibble.
 * DEF-RATIO-BANK-MARGIN.
 */
const MARGIN_UNRELIABLE_SECTORS = new Set(["banks"]);

function ratioCells(
  r: Awaited<ReturnType<typeof getKeyRatiosRow>>,
  price: number | null,
  venueCode: string,
  currency: string,
  sector: string | null,
): KeyRatio[] {
  const marginsUnreliable = MARGIN_UNRELIABLE_SECTORS.has((sector ?? "").toLowerCase());
  const pe = derivePe(price, r?.epsTtm ?? null, venueCode);
  return [
    { label: "MARKET CAP", value: r?.marketCap != null ? `${currency} ${fmtCompact(r.marketCap)}` : DASH },
    { label: "P/E (TTM)", value: pe != null ? `${pe.toFixed(1)}×` : DASH },
    { label: "EPS (TTM)", value: r?.epsTtm != null && venueCode.toUpperCase() !== "TDWL" ? fmtPrice(r.epsTtm, 2) : DASH },
    {
      label: "NET MARGIN",
      value:
        marginsUnreliable || r?.netMargin == null ? DASH : `${(r.netMargin * 100).toFixed(1)}%`,
    },
    {
      label: "GROSS MARGIN",
      value:
        marginsUnreliable || r?.grossMargin == null ? DASH : `${(r.grossMargin * 100).toFixed(1)}%`,
    },
    { label: "REV GROWTH Y/Y", value: pct(r?.revGrowthYoy ?? null) },
    { label: "REV CAGR 3Y", value: pct(r?.revCagr3y ?? null) },
    { label: "RETURN 3M", value: pct(r?.ret3m ?? null) },
    { label: "MOMENTUM 12-1", value: pct(r?.ret12m1 ?? null) },
  ];
}

/** Build the SVG polyline points the design's inline chart expects. */
function sparkPoints(closes: number[], w = 720, h = 200): { area: string; line: string } {
  if (closes.length < 2) return { area: "", line: "" };
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const pts = closes.map((c, i) => {
    const x = (i / (closes.length - 1)) * w;
    const y = h - ((c - lo) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { line: pts.join(" "), area: `0,${h} ${pts.join(" ")} ${w},${h}` };
}

export async function buildStockOverview(sec: ResolvedSecurity): Promise<Overview | null> {
  const [ov, ratios, peerData] = await Promise.all([
    getStockOverview(sec.id),
    getKeyRatiosRow(sec.id),
    getPeerComparison(sec.id),
  ]);
  if (!ov) return null;

  const currency = currencyLabel(ov.currency);
  const price = ov.quote?.last ?? null;
  const spark = sparkPoints(ov.sparkline ?? []);

  const peers: Peer[] = (peerData?.peers ?? []).map((p) => ({
    ticker: p.ticker,
    company: p.name,
    price: p.price != null ? fmtPrice(p.price, 2) : DASH,
    // Peer P/E would need each peer's eps_ttm; the peer read does not return it
    // and fanning out one ratio read per peer is not worth the latency here.
    pe: DASH,
    pb: DASH,
    yield: DASH,
    roe: DASH,
    evEbitda: DASH,
    mktCap: p.marketCapUsd != null ? `$${fmtCompact(p.marketCapUsd)}` : DASH,
    ytd: pct(p.ret3m),
    score: p.score ?? 0,
    self: p.isSelf,
  }));

  return {
    keyRatios: ratioCells(ratios, price, sec.venueCode, currency, ov.sector),
    chartTabs: ["PRICE", "P/E", "SALES & MARGIN", "EV/EBITDA", "P/B"],
    chart: {
      areaPoints: spark.area,
      linePoints: spark.line,
      note:
        ov.sparklineFrom && ov.sparklineTo
          ? `DAILY CLOSE · ${ov.sparklineFrom} → ${ov.sparklineTo}`
          : "AWAITING PRICE HISTORY",
    },
    // ── editorial: EMPTY, never borrowed ─────────────────────────────────────
    // These are PER-ENTITY fields with no backing column. Falling back to the
    // sample here would print Saudi Aramco's description, desk view and
    // pros/cons on every other company's page — that is not a placeholder,
    // it is misinformation (Law #2). The component omits each block when empty
    // and says the desk has not covered this name yet.
    // DEF-STOCK-EDITORIAL-FIELDS.
    aboutHtml: "",
    keyPoints: [],
    deskView: { quote: "", byline: "" },
    pros: [],
    cons: [],
    prosConsNote: "",
    // ─────────────────────────────────────────────────────────────────────────
    peers,
    peersSector: peerData?.sector ? sectorLabel(peerData.sector) : "",
    peersMedian:
      peerData?.medianMarketCapUsd != null
        ? `SECTOR MEDIAN MKT CAP $${fmtCompact(peerData.medianMarketCapUsd)} · ${peerData.peerCount} PEERS`
        : "",
  };
}
