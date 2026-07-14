/**
 * Marsad Score v1 — PURE math over the lake (no I/O, no clock, no network),
 * unit-tested independently of the DB (07 §3.4/§3.5). This is the flagship's IP:
 * given per-security ratio inputs it produces a 0–100 score, a rating band, five
 * factor sub-scores + letter grades, and the sector-cohort percentile — all
 * deterministic, zero external cost.
 *
 * The recipe (07 §3.4/§3.5), applied per GCC-wide sector cohort:
 *   1. Cohorts = securities grouped by sector (owner D-2, GCC-wide). Min size 8;
 *      smaller ⇒ thinCohort=true but still scored (prod is one 'unknown' cohort).
 *   2. Per metric within a cohort: winsorize at 2nd/98th pct (D-9) → percentile-
 *      rank 0–100 (D-10, distribution-free). P/E, P/B, EV/EBITDA are inverted so
 *      "higher = better" before ranking; Value uses earnings YIELD (E/P) so
 *      negative earnings rank at the bottom (not null).
 *   3. Five factors = weighted average of component PERCENTILES, weights
 *      renormalized over the non-null components. A factor computes only when
 *      ≥50% of its component weight is non-null; else factor=null, grade=null,
 *      DROPPED from the composite. Never impute zeros.
 *   4. Composite = 0.25·Value + 0.20·Growth + 0.20·Profitability + 0.20·Momentum
 *      + 0.15·Revisions (owner D-3), renormalized over the non-null factors. A
 *      name needs ≥3 of 5 factors present, else no score row (owner D-5).
 *   5. Re-percentile the composite across the FULL universe → score 0–100.
 *      sectorPercentile = composite percentile within its cohort.
 *   6. Rating bands (D-4) + factor letter grades from each 0–100 factor score.
 *
 * Revisions ships NULL at launch (owner D-8 — no consensus source), so it is
 * always dropped from the composite; grade_revisions is null.
 */

/** One security's raw ratio inputs — the Score's read of a public.key_ratios row
 *  plus the quote's 52-week band. Every metric is optional; a missing input drops
 *  that component (never a guessed number). */
export interface ScoreInput {
  securityId: number;
  venue: string;
  /** GCC-wide cohort key (07 §3.5 D-2). Prod is all 'unknown' ⇒ one cohort. */
  sector: string | null;

  // Value inputs.
  /** Earnings yield E/P = net_income_ttm / market_cap (or 1/pe, sign preserved). */
  earningsYield?: number | null;
  pb?: number | null;
  evEbitda?: number | null;
  dividendYield?: number | null;

  // Growth inputs.
  epsGrowthYoy?: number | null;
  revGrowthYoy?: number | null;
  epsCagr3y?: number | null;
  revCagr3y?: number | null;

  // Profitability inputs.
  roe?: number | null;
  roce?: number | null;
  nim?: number | null;
  netMargin?: number | null;
  grossMargin?: number | null;

  // Momentum inputs (price only).
  ret12_1?: number | null;
  ret6m?: number | null;
  ret3m?: number | null;
  /** 52-week-range position = (last − week52_low) / (week52_high − week52_low). */
  last?: number | null;
  week52High?: number | null;
  week52Low?: number | null;
}

export type FactorKey = 'value' | 'growth' | 'profitability' | 'momentum' | 'revisions';

export interface FactorScores {
  value: number | null;
  growth: number | null;
  profitability: number | null;
  momentum: number | null;
  /** Always null at launch (D-8, no consensus source). */
  revisions: number | null;
}

export interface Grades {
  value: string | null;
  growth: string | null;
  profitability: string | null;
  momentum: string | null;
  revisions: string | null;
}

export type Rating = 'BUY' | 'OVERWEIGHT' | 'HOLD' | 'UNDERWEIGHT' | 'SELL';

export interface ScoreResult {
  securityId: number;
  score: number; // 0–100, universe percentile of the composite
  rating: Rating;
  composite: number; // 0–100 raw composite (pre-universe-repercentile)
  factorScores: FactorScores;
  grades: Grades;
  sectorPercentile: number; // composite percentile within the sector cohort
  sectorPeerCount: number;
  thinCohort: boolean;
}

/** Minimum GCC-wide cohort size before a cohort is flagged thin (D-2). */
export const MIN_COHORT = 8;

/** Winsorization tails (owner D-9). */
const WINSOR_LOW = 0.02;
const WINSOR_HIGH = 0.98;

/** Composite factor weights (owner D-3). */
const FACTOR_WEIGHTS: Record<FactorKey, number> = {
  value: 0.25,
  growth: 0.2,
  profitability: 0.2,
  momentum: 0.2,
  revisions: 0.15,
};

/** A name needs at least this many non-null factors to publish a score (D-5). */
const MIN_FACTORS = 3;

/** A factor computes only when ≥ this share of its component weight is non-null. */
const MIN_FACTOR_COVERAGE = 0.5;

const nn = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;

/** One weighted component of a factor. */
interface Component {
  weight: number;
  /** Direction is pre-baked: higher raw value = better after any inversion. */
  value: number | null;
}

/**
 * Winsorize a series to [2nd, 98th] percentile bounds (D-9), then percentile-rank
 * each value 0–100 (D-10). Distribution-free: rank = (# strictly-below + 0.5·ties)
 * / n × 100, so the median maps near 50 and ties share a rank. Nulls stay null and
 * do not participate in the ranking population. Returns a map keyed by the caller's
 * index into the input series.
 */
export function winsorizedPercentiles(values: Array<number | null>): Array<number | null> {
  const present: number[] = [];
  for (const v of values) if (v !== null && Number.isFinite(v)) present.push(v);
  if (present.length === 0) return values.map(() => null);

  const sorted = [...present].sort((a, b) => a - b);
  const lo = quantile(sorted, WINSOR_LOW);
  const hi = quantile(sorted, WINSOR_HIGH);

  // Clamp to the winsor bounds, then rank against the clamped population.
  const clamped = present.map((v) => (v < lo ? lo : v > hi ? hi : v));
  const n = clamped.length;

  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    const c = v < lo ? lo : v > hi ? hi : v;
    let below = 0;
    let equal = 0;
    for (const other of clamped) {
      if (other < c) below += 1;
      else if (other === c) equal += 1;
    }
    return ((below + 0.5 * equal) / n) * 100;
  });
}

/** Linear-interpolated quantile of a pre-sorted ascending series. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  const frac = pos - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

/** True for banks/insurers (07 §3.3 D-1) — a P/B-led Value factor, no EV/EBITDA. */
function isBankOrInsurer(sector: string | null): boolean {
  return sector !== null && /bank|insur/i.test(sector);
}

/**
 * 52-week-range position (07 §3.4 Momentum). null unless last + a non-degenerate
 * band are all present. Clamped to [0,1] — a print above the recorded 52w-high
 * (delayed board vs. our stored extremes) still ranks best, not >1.
 */
function week52Position(input: ScoreInput): number | null {
  const last = nn(input.last);
  const hi = nn(input.week52High);
  const lo = nn(input.week52Low);
  if (last === null || hi === null || lo === null) return null;
  const range = hi - lo;
  if (range <= 0) return null;
  const pos = (last - lo) / range;
  return pos < 0 ? 0 : pos > 1 ? 1 : pos;
}

/**
 * Per-metric percentile matrices for one cohort. For every ScoreInput we first
 * collect its raw metric values (direction-corrected: inverted where lower-is-
 * cheaper-is-better), then winsorize+rank each metric column across the cohort,
 * yielding a percentile per (security, metric). Momentum's 52w-range is derived
 * before ranking so it too competes cohort-relative.
 */
interface RankedMetrics {
  // Each map: metric key → percentile (or null) for this security.
  perSecurity: Array<Record<string, number | null>>;
}

/** The raw (pre-rank) metric extractor. Inversions bake "higher = better". */
function rawMetrics(input: ScoreInput): Record<string, number | null> {
  return {
    // Value — direction cheap=high. E/P already higher=cheaper=better. Invert P/B
    // and EV/EBITDA (lower multiple = cheaper). div_yield higher = better.
    ep: nn(input.earningsYield),
    pbInv: invert(nn(input.pb)),
    evEbitdaInv: invert(nn(input.evEbitda)),
    divYield: nn(input.dividendYield),
    // Growth — higher = better already.
    epsGrowthYoy: nn(input.epsGrowthYoy),
    revGrowthYoy: nn(input.revGrowthYoy),
    epsCagr3y: nn(input.epsCagr3y),
    revCagr3y: nn(input.revCagr3y),
    // Profitability — higher = better already.
    roe: nn(input.roe),
    roceOrNim: nn(input.roce) ?? nn(input.nim),
    netMargin: nn(input.netMargin),
    grossMargin: nn(input.grossMargin),
    // Momentum — higher = better already.
    ret12_1: nn(input.ret12_1),
    ret6m: nn(input.ret6m),
    ret3m: nn(input.ret3m),
    week52: week52Position(input),
  };
}

/** 1/x with the sign preserved and a null on zero/non-finite. Keeps a cheap (low)
 *  multiple ranking above an expensive (high) one after inversion. */
function invert(v: number | null): number | null {
  if (v === null || v === 0) return null;
  const r = 1 / v;
  return Number.isFinite(r) ? r : null;
}

/** Rank every metric column across one cohort (winsorize+percentile per metric). */
function rankCohort(inputs: ScoreInput[]): RankedMetrics {
  const raws = inputs.map(rawMetrics);
  const keys = raws.length > 0 ? Object.keys(raws[0]!) : [];
  const ranked: Array<Record<string, number | null>> = raws.map(() => ({}));

  for (const key of keys) {
    const col = raws.map((r) => r[key] ?? null);
    const pct = winsorizedPercentiles(col);
    for (let i = 0; i < inputs.length; i += 1) ranked[i]![key] = pct[i]!;
  }
  return { perSecurity: ranked };
}

/**
 * Combine weighted component percentiles into a factor score. Returns null when
 * fewer than MIN_FACTOR_COVERAGE of the total component weight is non-null (07
 * §3.5). Weights are renormalized over the present components — never impute.
 */
function combineFactor(components: Component[]): number | null {
  let totalWeight = 0;
  let presentWeight = 0;
  let acc = 0;
  for (const c of components) {
    totalWeight += c.weight;
    if (c.value !== null && Number.isFinite(c.value)) {
      presentWeight += c.weight;
      acc += c.weight * c.value;
    }
  }
  if (totalWeight === 0 || presentWeight / totalWeight < MIN_FACTOR_COVERAGE) return null;
  return acc / presentWeight;
}

/** Factor components for one security, given its ranked metric percentiles and
 *  the sector-conditional Value override (07 §3.4). */
function factorComponents(
  sector: string | null,
  m: Record<string, number | null>,
): Record<Exclude<FactorKey, 'revisions'>, Component[]> {
  const value: Component[] = isBankOrInsurer(sector)
    ? [
        // Bank override: P/B primary (50), P/E-as-yield (30), div_yield (20); drop EV/EBITDA.
        { weight: 50, value: m.pbInv ?? null },
        { weight: 30, value: m.ep ?? null },
        { weight: 20, value: m.divYield ?? null },
      ]
    : [
        { weight: 30, value: m.ep ?? null },
        { weight: 25, value: m.pbInv ?? null },
        { weight: 25, value: m.evEbitdaInv ?? null },
        { weight: 20, value: m.divYield ?? null },
      ];

  const growth: Component[] = [
    { weight: 35, value: m.epsGrowthYoy ?? null },
    { weight: 25, value: m.revGrowthYoy ?? null },
    { weight: 25, value: m.epsCagr3y ?? null },
    { weight: 15, value: m.revCagr3y ?? null },
  ];

  const profitability: Component[] = [
    { weight: 30, value: m.roe ?? null },
    { weight: 25, value: m.roceOrNim ?? null },
    { weight: 25, value: m.netMargin ?? null },
    { weight: 20, value: m.grossMargin ?? null },
  ];

  const momentum: Component[] = [
    { weight: 40, value: m.ret12_1 ?? null },
    { weight: 25, value: m.ret6m ?? null },
    { weight: 20, value: m.ret3m ?? null },
    { weight: 15, value: m.week52 ?? null },
  ];

  return { value, growth, profitability, momentum };
}

/**
 * Composite = weighted mean of the five factor scores, renormalized over the
 * non-null factors (07 §3.5). Revisions is always null at launch so it always
 * drops. Returns null when fewer than MIN_FACTORS factors are present (D-5).
 */
function composite(f: FactorScores): number | null {
  const entries: Array<[FactorKey, number | null]> = [
    ['value', f.value],
    ['growth', f.growth],
    ['profitability', f.profitability],
    ['momentum', f.momentum],
    ['revisions', f.revisions],
  ];
  let present = 0;
  let weightSum = 0;
  let acc = 0;
  for (const [key, v] of entries) {
    if (v !== null && Number.isFinite(v)) {
      present += 1;
      weightSum += FACTOR_WEIGHTS[key];
      acc += FACTOR_WEIGHTS[key] * v;
    }
  }
  if (present < MIN_FACTORS || weightSum === 0) return null;
  return acc / weightSum;
}

/** Rating band from a 0–100 score (owner D-4). */
export function ratingForScore(score: number): Rating {
  if (score >= 80) return 'BUY';
  if (score >= 60) return 'OVERWEIGHT';
  if (score >= 40) return 'HOLD';
  if (score >= 20) return 'UNDERWEIGHT';
  return 'SELL';
}

/** Factor letter grade from a 0–100 factor score (07 §3.5, 12-bucket ladder). */
export function gradeForScore(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 90) return 'A+';
  if (score >= 83) return 'A';
  if (score >= 76) return 'A-';
  if (score >= 69) return 'B+';
  if (score >= 62) return 'B';
  if (score >= 55) return 'B-';
  if (score >= 48) return 'C+';
  if (score >= 41) return 'C';
  if (score >= 34) return 'C-';
  if (score >= 27) return 'D+';
  if (score >= 20) return 'D';
  return 'D-';
}

/** Percentile-rank one value against a population (same convention as
 *  winsorizedPercentiles, no winsorization — the composite is already tame). */
function percentileRank(value: number, population: number[]): number {
  const n = population.length;
  if (n === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const other of population) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return ((below + 0.5 * equal) / n) * 100;
}

/**
 * Score the whole universe (07 §3.4/§3.5). Groups inputs into GCC-wide sector
 * cohorts, ranks each metric within its cohort, builds the five factors and the
 * composite per name, then re-percentiles the composite across every scored name
 * → the published 0–100 score. Names with < MIN_FACTORS factors are omitted
 * entirely (no score row). The result order is NOT the input order — each result
 * carries securityId. Returns a flat array; the caller persists each.
 */
export function scoreUniverse(inputs: ScoreInput[]): ScoreResult[] {
  // 1. Group into sector cohorts (null sector coalesces to its own 'unknown' key).
  const cohorts = new Map<string, ScoreInput[]>();
  for (const input of inputs) {
    const key = input.sector ?? 'unknown';
    const bucket = cohorts.get(key);
    if (bucket) bucket.push(input);
    else cohorts.set(key, [input]);
  }

  // 2–4. Per cohort: rank metrics → factors → composite. Collect the intermediate
  //      per-name payload; the universe percentile (step 5) needs every composite
  //      first, so we stage before assigning the published score.
  interface Staged {
    input: ScoreInput;
    factorScores: FactorScores;
    composite: number;
    cohortKey: string;
    cohortSize: number;
    thinCohort: boolean;
  }
  const staged: Staged[] = [];
  const cohortComposites = new Map<string, number[]>();

  for (const [cohortKey, members] of cohorts) {
    const cohortSize = members.length;
    const thinCohort = cohortSize < MIN_COHORT;
    const ranked = rankCohort(members);

    for (let i = 0; i < members.length; i += 1) {
      const input = members[i]!;
      const m = ranked.perSecurity[i]!;
      const comps = factorComponents(input.sector, m);
      const factorScores: FactorScores = {
        value: combineFactor(comps.value),
        growth: combineFactor(comps.growth),
        profitability: combineFactor(comps.profitability),
        momentum: combineFactor(comps.momentum),
        revisions: null, // D-8 — always null at launch.
      };
      const comp = composite(factorScores);
      if (comp === null) continue; // < MIN_FACTORS ⇒ no score row (D-5).

      staged.push({ input, factorScores, composite: comp, cohortKey, cohortSize, thinCohort });
      const list = cohortComposites.get(cohortKey);
      if (list) list.push(comp);
      else cohortComposites.set(cohortKey, [comp]);
    }
  }

  // 5. Re-percentile the composite across the full scored universe → score 0–100;
  //    sectorPercentile is the composite percentile within its own cohort.
  const universeComposites = staged.map((s) => s.composite);
  const results: ScoreResult[] = [];
  for (const s of staged) {
    const universePct = percentileRank(s.composite, universeComposites);
    const score = Math.round(universePct);
    const cohortPop = cohortComposites.get(s.cohortKey)!;
    const sectorPct = Math.round(percentileRank(s.composite, cohortPop));

    results.push({
      securityId: s.input.securityId,
      score,
      rating: ratingForScore(score),
      composite: s.composite,
      factorScores: s.factorScores,
      grades: {
        value: gradeForScore(s.factorScores.value),
        growth: gradeForScore(s.factorScores.growth),
        profitability: gradeForScore(s.factorScores.profitability),
        momentum: gradeForScore(s.factorScores.momentum),
        revisions: gradeForScore(s.factorScores.revisions),
      },
      sectorPercentile: sectorPct,
      sectorPeerCount: s.cohortSize,
      thinCohort: s.thinCohort,
    });
  }
  return results;
}
