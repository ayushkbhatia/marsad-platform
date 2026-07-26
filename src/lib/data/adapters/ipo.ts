import type { Kpi } from "@/lib/contracts/calendars";
import type {
  AllocationRow,
  IpoListingData,
  IpoOfferDetail,
  IpoPipelineData,
  JustListed,
  KeyVal,
  ListingKpi,
  PipelineOffer,
  PipelineStage,
  ProceedsRow,
  TimelineStep,
} from "@/lib/contracts/ipo";
import type { IpoKpis, IpoOfferItem, IpoStageBucket } from "@/lib/data/calendars";

/**
 * IPO Center adapters (designs 22a pipeline / 22b offer detail / 22c listing
 * day) — the real `ipo_offers` reads → the `IpoPipelineData`,
 * `IpoOfferDetail` and `IpoListingData` contracts.
 *
 * WHY THEY SHIP BEFORE THEIR PRODUCER (BRIDGE-BUILD-PLAN P2.5). Measured
 * against the live DB on 2026-07-26:
 *
 *   ipo_offers ............... 0 rows   (0 to `anon`)
 *   ipo_timeline_events ...... 0 rows   (0 to `anon`)
 *   listing_debuts ........... 0 rows   (0 to `anon`)
 *
 * There is no offer, no timeline and no debut to render. Per Law #2 the routes
 * must NOT keep serving the sample OQ Base Industries subscription or the Bina
 * Modular debut as though they were live Gulf offerings — `/ipo` renders
 * `EmptyState variant="awaitingFeed"` and the two template routes `notFound()`
 * on a slug that resolves to nothing. Deliberately NOT wrapped in
 * `withSampleFallback`: a known-empty producer is the exact case that helper
 * must never cover. The mappings are written, typed and fixture-tested
 * (`__tests__/ipo.test.ts`) so all three screens light up with no further
 * front-end change the moment the IPO producer lands (P7.2).
 *
 * NO RUNTIME IMPORTS BY DESIGN. Every import above is type-only (erased at
 * build time), so this module is a pure function of its arguments: no Supabase
 * client, no `server-only`, no `@/` runtime resolution — which is what lets the
 * fixture test prove the wiring without a producer and without a bundler.
 * Contract fields are pre-formatted strings, so formatting lives here.
 *
 * KNOWN GAPS, degraded honestly rather than invented (all reported to the lead;
 * `data/calendars.ts` and `lib/contracts/*` belong to other slices):
 * - Subscription COVERAGE lives in `ipo_timeline_events.coverage_inst` /
 *   `coverage_retail`, which no read fetches — the `covered` cell is "" (the
 *   contract's own no-chip value), never a plausible "3.1×".
 * - `JustListed.changePct` is a required non-null number, so a debut can only
 *   be listed once a post-listing price exists. `toIpoPipeline` takes an
 *   optional `lastPrices` map for that; with no map the just-listed rail is
 *   empty rather than showing a fabricated 0.0% move. Requested contract
 *   change: make `changePct`/`price` nullable so a debut can list with "—".
 * - Pre-IPO FINANCIALS have no producer (`financial_statements` only covers
 *   listed securities) → the 22b snapshot renders its heads over no rows.
 * - LISTED PEERS on 22c need a sector-peer + score read that this slice does
 *   not own → empty.
 * - The 22c debut record (`listing_debuts`) has no read function in
 *   `data/calendars.ts` at all. `toIpoListing` is written against the table's
 *   real column set (`ListingDebut` below) so the mapping is proven now;
 *   requested follow-up: a `getListingDebut(ipoId)` read in that file.
 */

const DASH = "—";
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Milliseconds in a day — used only for whole-day arithmetic on UTC dates. */
const DAY_MS = 86_400_000;

/**
 * Split a `YYYY-MM-DD` (or ISO timestamp) arithmetically. A local `new Date()`
 * would re-interpret the calendar date in the server's zone and can shift a
 * close/listing date by a day (the postgres.js Date trap, applied to
 * formatting).
 */
function ymd(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? "").trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { y: Number(m[1]), m: month, d: day };
}

/** The `YYYY-MM-DD` prefix of an ISO date or timestamp, for ordered compares. */
function isoDate(iso: string | null | undefined): string | null {
  const p = ymd(iso);
  if (!p) return null;
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** `2026-07-09` → `9 JUL`. */
function shortDate(iso: string | null | undefined): string {
  const p = ymd(iso);
  if (!p) return DASH;
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

/** `2026-11-28` → `28 NOV 2026`. */
function longDate(iso: string | null | undefined): string {
  const p = ymd(iso);
  if (!p) return DASH;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/** Whole days from `fromISO` to `toISO`, UTC-only. Null if either is unusable. */
function daysBetween(fromISO: string | null | undefined, toISO: string | null | undefined): number | null {
  const a = ymd(fromISO);
  const b = ymd(toISO);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

function addDays(iso: string | null | undefined, days: number): string | null {
  const p = ymd(iso);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function num(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}

/** Price with up to 3 decimals, trailing zeros beyond 2 trimmed (OMR 0.106). */
function price(n: number | null | undefined): string {
  if (!num(n)) return DASH;
  return n.toFixed(3).replace(/(\.\d{2}\d*?)0+$/, "$1");
}

/** `660_000_000` → `$660M`; `1_350_000_000` → `$1.35B`. USD per the read's note. */
function usd(n: number | null | undefined): string {
  if (!num(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
  if (abs >= 1e6) return `$${Math.round(n / 1e6)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n.toFixed(0)}`;
}

/** `2_400_000_000` → `2.40bn sh` (share counts, not money). */
function shares(n: number | null | undefined): string {
  if (!num(n)) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}bn sh`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(0)}m sh`;
  return `${Math.round(n)} sh`;
}

/**
 * `offer_size_pct` / `retail_tranche_pct` / `implied_yield` are stored as
 * percent-style numerics on `ipo_offers` (49 = 49%), unlike the dividend
 * fraction columns. 0 rows exist to confirm against, so this is flagged for
 * confirmation with the producer (same caveat as `VENUE_CCY` in
 * `data/calendars.ts`); a value ≤ 1 is left as-is rather than silently ×100.
 */
function pct(n: number | null | undefined, digits = 0): string {
  if (!num(n)) return DASH;
  return `${n.toFixed(digits)}%`;
}

function signedPct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/**
 * Pure copy of `classifyIpoStage` in `data/calendars.ts` (that module is
 * `server-only`, and this adapter must stay import-free so it can be
 * fixture-tested). Same keyword vocabulary — when the producer lands and the
 * real stage vocabulary is pinned (P7.2), collapse the two into this one by
 * having `data/calendars.ts` import from here.
 */
export function stageBucket(stage: string | null | undefined): IpoStageBucket {
  const s = (stage ?? "").toLowerCase();
  if (!s) return "other";
  if (s.includes("listed")) return "listed";
  if (s.includes("retail") || s.includes("subscri")) return "subscription_open";
  if (s.includes("book") || s.includes("institution")) return "bookbuilding";
  if (s.includes("announc") || s.includes("filed") || s.includes("draft") || s.includes("intention")) return "announced";
  return "other";
}

const STAGE_LABELS: Record<IpoStageBucket, string> = {
  subscription_open: "SUBSCRIPTION OPEN",
  bookbuilding: "BOOKBUILDING · INSTITUTIONAL",
  announced: "ANNOUNCED & FILED",
  listed: "LISTED",
  other: "OTHER OFFERS",
};

/** Band order on 22a — the reader's funnel, not the DB's. */
const STAGE_ORDER: IpoStageBucket[] = ["subscription_open", "bookbuilding", "announced", "listed", "other"];

// ─────────────────────────────────────────────────────────────────────────
// 22a — pipeline
// ─────────────────────────────────────────────────────────────────────────

/** `OMR 0.106–0.111`, or the struck price, or the honest dash. */
function priceRange(offer: IpoOfferItem): string {
  const ccy = offer.localCurrency ? `${offer.localCurrency} ` : "";
  if (num(offer.finalPrice)) return `${ccy}${price(offer.finalPrice)}`;
  if (num(offer.priceRangeLow) && num(offer.priceRangeHigh)) {
    return `${ccy}${price(offer.priceRangeLow)}–${price(offer.priceRangeHigh)}`;
  }
  if (num(offer.priceRangeLow)) return `${ccy}${price(offer.priceRangeLow)}+`;
  return "TBD";
}

function closesCell(offer: IpoOfferItem, bucket: IpoStageBucket): { closes: string; chip: boolean } {
  if (offer.retailCloseAt) {
    return { closes: shortDate(offer.retailCloseAt), chip: bucket === "subscription_open" };
  }
  if (offer.expectedListing) return { closes: `LISTS ${shortDate(offer.expectedListing)}`, chip: false };
  return { closes: DASH, chip: false };
}

function toPipelineOffer(offer: IpoOfferItem, bucket: IpoStageBucket): PipelineOffer {
  const { closes, chip } = closesCell(offer, bucket);
  const row: PipelineOffer = {
    ticker: offer.ticker ?? DASH,
    company: offer.companyName,
    venue: offer.venueCode,
    priceRange: priceRange(offer),
    raise: usd(offer.raiseAmount),
    closes,
    // Coverage lives on `ipo_timeline_events`, which no read fetches — the
    // contract's "" is the no-chip value, so the cell stays blank instead of
    // claiming a subscription multiple nobody published.
    covered: "",
  };
  return chip ? { ...row, closesChip: true } : row;
}

function toStages(offers: IpoOfferItem[]): PipelineStage[] {
  const byBucket = new Map<IpoStageBucket, IpoOfferItem[]>();
  for (const offer of offers) {
    const bucket = stageBucket(offer.stage);
    const list = byBucket.get(bucket);
    if (list) list.push(offer);
    else byBucket.set(bucket, [offer]);
  }

  return STAGE_ORDER.flatMap((bucket) => {
    const list = byBucket.get(bucket);
    if (!list || list.length === 0) return [];
    return [
      {
        label: STAGE_LABELS[bucket],
        meta: `${list.length} OFFER${list.length === 1 ? "" : "S"}`,
        offers: list.map((o) => toPipelineOffer(o, bucket)),
      },
    ];
  });
}

function toPipelineKpis(kpis: IpoKpis): Kpi[] {
  return [
    { label: "IN PIPELINE", value: String(kpis.inPipeline) },
    { label: "SUBSCRIPTION OPEN", value: String(kpis.subscriptionOpen) },
    { label: "LISTING THIS MONTH", value: String(kpis.listingThisMonth) },
    { label: "RAISED YTD · GCC", value: kpis.raisedYtd > 0 ? usd(kpis.raisedYtd) : DASH },
  ];
}

/**
 * Just-listed rail. `JustListed` requires a non-null `price` and `changePct`,
 * and `ipo_offers` carries neither post-listing figure — so a debut only
 * appears when the caller supplies its last price (keyed by `securityId`), and
 * the move is computed against the struck offer price. No map → no rows, never
 * a fabricated flat 0.0%.
 */
function toJustListed(offers: IpoOfferItem[], lastPrices: ReadonlyMap<number, number> | undefined): JustListed[] {
  if (!lastPrices || lastPrices.size === 0) return [];
  return offers.flatMap((offer) => {
    const last = offer.securityId != null ? lastPrices.get(offer.securityId) : undefined;
    if (!num(last) || !num(offer.finalPrice) || offer.finalPrice === 0) return [];
    return [
      {
        ticker: offer.ticker ?? DASH,
        company: offer.companyName,
        venue: offer.venueCode,
        price: price(last),
        changePct: ((last - offer.finalPrice) / offer.finalPrice) * 100,
        listed: offer.expectedListing ? `LISTED ${shortDate(offer.expectedListing)}` : "LISTED",
      },
    ];
  });
}

const NEVER_MISS = {
  kicker: "NEVER MISS A WINDOW",
  headline: "Get pinged the minute books open",
  body: "Push + email when any GCC offer opens for retail subscription — or only venues you follow.",
  cta: "Create IPO alert →",
};

const HOW_IT_WORKS = [
  "Retail vs institutional tranches",
  "Allocation & refunds, explained",
  "Which brokers take applications",
];

export interface IpoPipelineInput {
  /** `getIpoPipeline()` — every offer on file. */
  offers: IpoOfferItem[];
  /** `getIpoJustListed()` — offers whose stage buckets to "listed". */
  justListed: IpoOfferItem[];
  /** `getIpoKpis({ todayISO, monthEndISO, yearStartISO })`. */
  kpis: IpoKpis;
  /** Optional `securityId → last price` for the just-listed move (see above). */
  lastPrices?: ReadonlyMap<number, number>;
}

/**
 * Map the IPO pipeline reads onto the `IpoPipelineData` contract.
 *
 * Returns `null` when there is no offer at all — the route's signal to render
 * `EmptyState variant="awaitingFeed"`, which is what `/ipo` resolves to today
 * (`ipo_offers` = 0 rows).
 */
export function toIpoPipeline(input: IpoPipelineInput): IpoPipelineData | null {
  const { offers, justListed, kpis, lastPrices } = input;
  if (offers.length === 0 && justListed.length === 0) return null;

  return {
    kpis: toPipelineKpis(kpis),
    stages: toStages(offers),
    justListed: toJustListed(justListed, lastPrices),
    neverMiss: NEVER_MISS,
    howItWorks: HOW_IT_WORKS,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 22b — offer detail
// ─────────────────────────────────────────────────────────────────────────

/** `{"Debt paydown": 25}` or `[{label, pct}]` → proceeds rows. Unknown → []. */
function toProceeds(raw: unknown): ProceedsRow[] {
  const pairs: Array<{ label: string; value: number }> = [];

  const push = (label: unknown, value: unknown) => {
    const n = typeof value === "number" ? value : Number(value);
    if (typeof label === "string" && label.trim() && Number.isFinite(n)) {
      pairs.push({ label: label.trim(), value: n });
    }
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        push(o.label ?? o.name ?? o.purpose, o.pct ?? o.percent ?? o.share ?? o.value);
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [label, value] of Object.entries(raw as Record<string, unknown>)) push(label, value);
  }

  // 2.5px of bar per percentage point — the design's 60% → 150px scale.
  return pairs.map<ProceedsRow>((p) => ({
    label: p.label,
    pct: pct(p.value),
    barWidth: Math.max(0, Math.round(p.value * 2.5)),
  }));
}

/** `["Ahli Invest"]` or `[{name}]` or `{brokers:[…]}` → names. Unknown → []. */
function toBrokers(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { brokers?: unknown }).brokers)
      ? ((raw as { brokers: unknown[] }).brokers)
      : [];

  return list.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim()];
    if (entry && typeof entry === "object") {
      const name = (entry as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return [name.trim()];
    }
    return [];
  });
}

function timelineState(iso: string | null, todayISO: string): "done" | "current" | "future" {
  const d = isoDate(iso);
  if (!d) return "future";
  if (d < todayISO) return "done";
  if (d === todayISO) return "current";
  return "future";
}

function toTimeline(offer: IpoOfferItem, todayISO: string): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const openISO = isoDate(offer.retailOpenAt);
  const closeISO = isoDate(offer.retailCloseAt);

  if (openISO || closeISO) {
    const open = openISO ?? closeISO!;
    const close = closeISO ?? openISO!;
    const state: TimelineStep["state"] =
      todayISO > close ? "done" : todayISO >= open ? "current" : "future";
    steps.push({
      label: "RETAIL SUBSCRIPTION",
      value: openISO && closeISO ? `${shortDate(openISO)} – ${shortDate(closeISO)}` : shortDate(open),
      state,
    });
  }

  if (offer.refundsBy) {
    steps.push({
      label: "REFUNDS BY",
      value: shortDate(offer.refundsBy),
      state: timelineState(offer.refundsBy, todayISO),
    });
  }

  if (offer.expectedListing) {
    steps.push({
      label: "LISTING",
      value: shortDate(offer.expectedListing),
      state: timelineState(offer.expectedListing, todayISO),
    });
  }

  // `ipo_timeline_events` (announcement, bookbuild, allocation) has 0 rows and
  // no read function — those steps appear once that producer lands, rather than
  // being back-filled with plausible dates here.
  return steps;
}

function toFacts(offer: IpoOfferItem): KeyVal[] {
  const ccy = offer.localCurrency ? `${offer.localCurrency} ` : "";
  const minLotCost =
    num(offer.minLot) && num(offer.priceRangeHigh ?? offer.finalPrice)
      ? ` · ${ccy}${price(offer.minLot * (offer.finalPrice ?? offer.priceRangeHigh)!)}`
      : "";

  return [
    { label: "PRICE RANGE", value: priceRange(offer) },
    {
      label: "OFFER SIZE",
      value:
        num(offer.offerSizePct) || num(offer.sharesOffered)
          ? [num(offer.offerSizePct) ? pct(offer.offerSizePct) : null, num(offer.sharesOffered) ? shares(offer.sharesOffered) : null]
              .filter(Boolean)
              .join(" · ")
          : DASH,
    },
    { label: "RAISE", value: usd(offer.raiseAmount) },
    { label: "IMPLIED MKT CAP", value: usd(offer.impliedMcap) },
    { label: "IMPLIED P/E", value: num(offer.impliedPe) ? `${offer.impliedPe.toFixed(1)}×` : DASH },
    { label: "IMPLIED YIELD", value: pct(offer.impliedYield, 1) },
    { label: "RETAIL TRANCHE", value: pct(offer.retailTranchePct) },
    { label: "MIN LOT", value: num(offer.minLot) ? `${offer.minLot} sh${minLotCost}` : DASH },
    { label: "DIVIDEND POLICY", value: offer.dividendPolicy?.trim() || DASH },
    { label: "REFUNDS BY", value: shortDate(offer.refundsBy) },
  ];
}

function toCountdown(offer: IpoOfferItem, todayISO: string): IpoOfferDetail["countdown"] {
  const closeISO = isoDate(offer.retailCloseAt);
  const left = closeISO ? daysBetween(todayISO, closeISO) : null;
  const value = left == null ? DASH : left > 0 ? `${left}d` : left === 0 ? "TODAY" : "CLOSED";
  const tranche = num(offer.retailTranchePct) ? ` · RETAIL TRANCHE ${pct(offer.retailTranchePct)}` : "";

  return {
    kicker: left != null && left < 0 ? "RETAIL BOOKS CLOSED" : "RETAIL BOOKS CLOSE IN",
    value,
    sub: closeISO ? `${longDate(closeISO)}${tranche}` : "NO RETAIL WINDOW PUBLISHED",
    cta: "Subscribe via your broker",
  };
}

/** No desk view is published for any offer — `ai_theses` is 0 rows (P5). */
const NO_TAKE = {
  headline: "No Marsad take on this offer yet",
  body: "The desk's view on pricing and fair value appears here once an analyst publishes on this offer.",
  cta: "Unlock the take →",
};

export interface IpoOfferDetailInput {
  /** `getIpoOffer(offerSlug)` — the resolved offer. */
  offer: IpoOfferItem;
  /** The route's slug, echoed back into the contract (the canonical URL key). */
  slug: string;
  /** `YYYY-MM-DD` from a dynamic caller — never read from the clock in here. */
  todayISO: string;
}

/**
 * Map one resolved offer onto the `IpoOfferDetail` contract. The caller has
 * already resolved the slug (a miss must `notFound()`, not render someone
 * else's IPO), so this never returns null.
 */
export function toIpoOfferDetail(input: IpoOfferDetailInput): IpoOfferDetail {
  const { offer, slug, todayISO } = input;
  const proceeds = toProceeds(offer.useOfProceeds);
  const bucket = stageBucket(offer.stage);

  return {
    slug,
    ticker: offer.ticker ?? DASH,
    company: offer.companyName,
    meta: [offer.venueCode, offer.expectedListing ? `LISTING ${shortDate(offer.expectedListing)}` : null]
      .filter(Boolean)
      .join(" · "),
    statusChip: STAGE_LABELS[bucket],
    timeline: toTimeline(offer, todayISO),
    facts: toFacts(offer),
    useOfProceeds: proceeds,
    proceedsNote:
      proceeds.length > 0
        ? "Use of proceeds as disclosed in the prospectus."
        : "No use-of-proceeds breakdown has been captured for this offer yet.",
    // Pre-IPO financials have no producer: `financial_statements` only covers
    // already-listed securities, and the prospectus extractor does not exist.
    financials: { periods: [], rows: [] },
    countdown: toCountdown(offer, todayISO),
    brokers: toBrokers(offer.brokers),
    marsadTake: NO_TAKE,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 22c — listing day
// ─────────────────────────────────────────────────────────────────────────

/**
 * One `public.listing_debuts` row, camelCased. Mirrors the live column set
 * (measured 2026-07-26): `ipo_id, security_id, debut_date, offer_price,
 * open_price, auction_price, auction_volume, vwap, free_float_traded_pct,
 * allocation_recap`. There is no read function for this table yet — see the
 * gap list in the file header.
 */
export interface ListingDebut {
  ipoId: number;
  securityId: number | null;
  debutDate: string | null;
  offerPrice: number | null;
  openPrice: number | null;
  auctionPrice: number | null;
  auctionVolume: number | null;
  vwap: number | null;
  freeFloatTradedPct: number | null;
  allocationRecap: unknown;
}

function toAllocation(raw: unknown): AllocationRow[] {
  if (!raw || typeof raw !== "object") return [];
  const entries = Array.isArray(raw)
    ? raw.flatMap((e) =>
        e && typeof e === "object"
          ? [[String((e as Record<string, unknown>).label ?? ""), (e as Record<string, unknown>).value] as const]
          : [],
      )
    : Object.entries(raw as Record<string, unknown>);

  return entries.flatMap(([label, value]) => {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
    if (!label.trim() || text == null || !text.trim()) return [];
    return [{ label: label.trim(), value: text.trim() }];
  });
}

function toListingKpis(debut: ListingDebut, ccy: string): ListingKpi[] {
  const kpis: ListingKpi[] = [{ label: `OFFER PRICE${ccy ? ` · ${ccy}` : ""}`, value: price(debut.offerPrice) }];

  if (num(debut.openPrice)) {
    const move =
      num(debut.offerPrice) && debut.offerPrice !== 0
        ? ((debut.openPrice - debut.offerPrice) / debut.offerPrice) * 100
        : null;
    kpis.push({
      label: "OPENED",
      value: price(debut.openPrice),
      ...(move != null ? { delta: signedPct(move), dir: move < 0 ? ("down" as const) : ("up" as const) } : {}),
    });
  }

  if (num(debut.vwap)) kpis.push({ label: "VWAP", value: price(debut.vwap) });
  if (num(debut.auctionVolume)) {
    kpis.push({ label: "AUCTION VOLUME", value: shares(debut.auctionVolume).replace(" sh", "") });
  }
  if (num(debut.freeFloatTradedPct)) {
    kpis.push({ label: "FREE FLOAT TRADED", value: pct(debut.freeFloatTradedPct) });
  }

  // LAST / DAY RANGE / TURNOVER need an intraday quote read this slice does not
  // own — the strip carries four honest cells rather than five with a guess.
  return kpis;
}

/** Intraday polyline over the design's 720×240 viewBox. */
function toChart(debut: ListingDebut, closes: number[]): IpoListingData["chart"] {
  const offerLabel = `OFFER ${price(debut.offerPrice)}`;
  const openLabel = `OPEN ${price(debut.openPrice)}`;
  const series = closes.filter((n) => num(n));
  const anchors = [...series, ...(num(debut.offerPrice) ? [debut.offerPrice] : [])];

  if (series.length < 2 || anchors.length < 2) {
    return { offerY: 0, points: "", offerLabel, openLabel, openTop: 0 };
  }

  const hi = Math.max(...anchors);
  const lo = Math.min(...anchors);
  const span = hi - lo || 1;
  const y = (v: number) => Math.round(((hi - v) / span) * 220) + 10;
  const step = 720 / (series.length - 1);

  return {
    offerY: num(debut.offerPrice) ? y(debut.offerPrice) : 0,
    points: series.map((v, i) => `${Math.round(i * step)},${y(v)}`).join(" "),
    offerLabel,
    openLabel,
    openTop: num(debut.openPrice) ? Math.max(0, y(debut.openPrice) - 14) : 0,
  };
}

/**
 * Marsad Scores need 90 trading days of history. ~126 calendar days is the
 * standard conversion used across the desk copy; the date is stated as expected,
 * never as a published score.
 */
const TRADING_DAYS_TO_CALENDAR = 126;

export interface IpoListingInput {
  /** The offer the debut belongs to (identity + venue currency). */
  offer: IpoOfferItem;
  /** The `listing_debuts` row — `null` until the producer lands. */
  debut: ListingDebut | null;
  /** The route's slug, echoed back into the contract. */
  slug: string;
  /** Optional intraday closes for the debut session, oldest → newest. */
  intradayCloses?: number[];
  /** Optional session stamp for the "LIVE ·" chip, e.g. `TDWL 14:32 GST`. */
  sessionLabel?: string;
}

/**
 * Map a listing debut onto the `IpoListingData` contract.
 *
 * Returns `null` when no debut record exists — the route's signal to render
 * `EmptyState variant="awaitingFeed"` instead of another company's debut
 * session. `listing_debuts` is 0 rows today, so that is every case.
 */
export function toIpoListing(input: IpoListingInput): IpoListingData | null {
  const { offer, debut, slug, intradayCloses = [], sessionLabel } = input;
  if (!debut) return null;

  const scoreDate = longDate(addDays(debut.debutDate, TRADING_DAYS_TO_CALENDAR));

  return {
    slug,
    ticker: offer.ticker ?? DASH,
    company: offer.companyName,
    meta: [offer.venueCode, debut.debutDate ? `DEBUT ${shortDate(debut.debutDate)}` : null].filter(Boolean).join(" · "),
    liveLabel: sessionLabel ?? `${offer.venueCode} · DELAYED 15 MIN`,
    kpis: toListingKpis(debut, offer.localCurrency),
    chart: toChart(debut, intradayCloses),
    chartCaptions: [
      num(debut.auctionPrice)
        ? `OPENING AUCTION: ${price(debut.auctionPrice)}${num(debut.auctionVolume) ? ` · ${shares(debut.auctionVolume)}` : ""}`
        : null,
      num(debut.vwap) ? `VWAP ${price(debut.vwap)}` : null,
      num(debut.freeFloatTradedPct) ? `FREE FLOAT TRADED: ${pct(debut.freeFloatTradedPct)}` : null,
    ].filter((c): c is string => c != null),
    // No wire story is bound to a debut yet (the newsroom produces none — P4).
    wire: {
      kicker: "THE WIRE",
      headline: "No wire story has been published on this debut yet.",
      cta: "Follow on the Newswire →",
    },
    allocation: toAllocation(debut.allocationRecap),
    scorePending:
      `Marsad Scores need 90 trading days of price history. The first Score on ${offer.ticker ?? offer.companyName} ` +
      `is expected ${scoreDate}; no factor grades are published before then.`,
    scoreExpectedDate: scoreDate,
    // Sector peers + their scores need a peer read this slice does not own.
    listedPeers: [],
  };
}
