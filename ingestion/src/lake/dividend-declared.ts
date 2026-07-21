/**
 * DIVIDEND.EXDATE dated-declaration normalization (03 §6/§7, 07 lake lineage).
 *
 * The PURE half of the `DIVIDEND.DECLARED` feed (BUILD-STATUS §7): turn a
 * DIVIDEND-typed filing whose facts the filing-facts extractor already parsed
 * (`public.filings.extracted_facts.ai.dividend` = {dps, currency, ex_date,
 * record_date, pay_date}, written by scripts/researchers/filing-extractor.mjs)
 * into a `NormalizedDividend`, a deterministic `DIVIDEND.EXDATE` natural key, a
 * lake-object payload carrying its lineage roots, and the `public.dividends`
 * upsert row.
 *
 * WHY this is a separate follow-on and not the reader history tier: the reader
 * `public.dividends` history rows are projected from `equity_change` statement
 * CASH TOTALS (`lake.fn_project_dividends_from_equity`, 20260720160000) and carry
 * NO ex/record/pay date and reference a FILING.FINANCIALS object — so they arm
 * TPL-03, never the dated ex-date card (BLK-EXDATE → TPL-04, migration
 * 20260713000008). This module produces the DATED declaration (DPS + ex_date)
 * whose object_type `DIVIDEND.EXDATE` is exactly what
 * worker edit.ts `autoSelectTemplate` maps to TPL-04 and what the
 * `ops.materiality_prefilter` DIVIDEND.EXDATE row routes material→wire→TPL-04
 * (migration 20260720110829).
 *
 * PURE: no I/O, no clock, no DB. The researcher runner
 * (scripts/researchers/dividend-declared.mjs) does the filing read, the security
 * resolution, the lake.objects insert + dividends upsert; this module is the
 * deterministic, unit-tested core it imports.
 *
 * ── Object lifecycle (deliberate, matches the 33b gate) ─────────────────────────
 * A dividend is a price-sensitive fact. The lake state guard
 * (lake.fn_object_state_guard) refuses VERIFIED for a price_sensitive object
 * without a HUMAN verifier, and public.dividends.fn_dividend_confirm_guard refuses
 * go-live without a human confirmer. So the object lands PENDING and the reader
 * row lands `pending_confirm`; a Desk human confirm promotes BOTH — which then
 * fires lake.fn_verified_enqueue → pipeline_classify → TPL-04. Single-source lands
 * PENDING/1-root gracefully; a corroborating second root is recorded on the
 * payload for the ≥2-lineage-root auto-publish precondition (03 §7.3, Revision #5).
 */

import type { NormalizedDividend, VenueCode } from '../core/types.js';

/** The dividend fact block filing-extractor.mjs writes under extracted_facts.ai.dividend. */
export interface FilingAiDividend {
  dps?: number | string | null;
  currency?: string | null;
  ex_date?: string | null;
  record_date?: string | null;
  pay_date?: string | null;
}

/** The minimal filing projection the producer reads from public.filings. */
export interface DividendFilingRow {
  id: number;
  venue: VenueCode;
  ticker: string; // the resolved security ticker (venue+ticker → securities.id)
  title: string | null;
  filedAt: string; // ISO-8601 (public.filings.filed_at)
  aiDividend: FilingAiDividend | null; // extracted_facts.ai.dividend
}

/** CONTRACT §6.5 primary-wins ranks. Lower wins. */
export const REGISTRAR_RANK = 10;
export const EXCHANGE_RANK = 20;
export const AGGREGATOR_RANK = 90;

/** A single provenance root feeding the DIVIDEND.EXDATE object (07 lineage). */
export interface LineageRoot {
  /** disclosure = the venue filing itself (exchange); the others are the corroborating second source. */
  root: 'disclosure' | 'equity_projection' | 'registrar' | 'aggregator' | 'venue_feed';
  rank: number; // CONTRACT §6.5: registrar=10, exchange/disclosure=20, aggregator/press=90
  filingId?: number; // source filing id (disclosure root)
  sourceRef?: string; // filings.source_ref of that root
  objectId?: string | null; // a corroborating lake object id (e.g. the equity-projection FILING.FINANCIALS root)
  note?: string;
}

/** The resolved lineage set: the roots array, their count, and the primary (lowest) rank. */
export interface LineageResult {
  roots: LineageRoot[];
  count: number;
  sourceRank: number;
}

/** The DIVIDEND.EXDATE lake-object payload (snake_case — the shape the writer/ex-date card read). */
export interface DividendObjectPayload {
  venue: VenueCode;
  ticker: string;
  div_type: NormalizedDividend['divType'];
  fiscal_ref: string;
  dps: number;
  currency: string;
  ex_date: string | null;
  record_date: string | null;
  pay_date: string | null;
  verification: NormalizedDividend['verification'];
  source_filing_id: number;
  /** Every provenance root; ≥2 ⇒ double-sourced (the auto-publish precondition, recorded for the
   *  per-object lineage-root machinery the rules stage will read). */
  lineage_roots: LineageRoot[];
  lineage_root_count: number;
}

/** The public.dividends upsert row (columns exact per the live DDL; conflict target = dividends_uni). */
export interface DividendUpsertRow {
  security_id: number;
  div_type: NormalizedDividend['divType'];
  fiscal_ref: string | null; // public.dividends.fiscal_ref is nullable
  dps: number | null;
  currency: string;
  ex_date: string | null;
  record_date: string | null;
  pay_date: string | null;
  verification: NormalizedDividend['verification'];
  state: 'pending_confirm';
  source_object_id: string; // the DIVIDEND.EXDATE lake object id
}

/** Venue → ISO-4217 settlement currency (char(3)), the NOT-NULL fallback when the filing omits it. */
const VENUE_CURRENCY: Record<VenueCode, string> = {
  TDWL: 'SAR',
  DFM: 'AED',
  ADX: 'AED',
  QE: 'QAR',
  MSX: 'OMR',
  BHB: 'BHD',
};

export function venueCurrency(venue: VenueCode): string {
  return VENUE_CURRENCY[venue];
}

/** Normalise the extracted currency to a 3-letter upper code; venue default when absent/garbage. */
export function normalizeCurrency(raw: string | null | undefined, venue: VenueCode): string {
  const c = (raw ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : venueCurrency(venue);
}

/**
 * Dividend TYPE from the filing title (the extractor does not classify type). Order matters:
 * SPECIAL beats INTERIM beats the FINAL default. Deterministic, English-only (CONTRACT §0.4).
 */
export function normalizeDivType(title: string | null | undefined): NormalizedDividend['divType'] {
  const t = (title ?? '').toLowerCase();
  if (/\b(special|one[-\s]?off|exceptional|extraordinary)\b/.test(t)) return 'SPECIAL';
  if (/\b(interim|quarter|q[1-4]\b|semi[-\s]?annual|half[-\s]?year|first half|h1|nine[-\s]?month|9m)\b/.test(t)) {
    return 'INTERIM';
  }
  return 'FINAL';
}

/** Strict 'YYYY-MM-DD' → the same string if it is a real calendar date, else null. */
export function parseIsoDate(s: string | null | undefined): string | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const yr = Number(y);
  const mon = Number(mo);
  const day = Number(d);
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
  // Reject impossible days (e.g. 2026-02-30) via a round-trip through UTC.
  const dt = new Date(Date.UTC(yr, mon - 1, day));
  if (dt.getUTCFullYear() !== yr || dt.getUTCMonth() !== mon - 1 || dt.getUTCDate() !== day) return null;
  return `${y}-${mo}-${d}`;
}

/** Coerce an extracted dps (number | numeric string) → a finite positive number, else null. */
export function toDps(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The 4-digit fiscal year for the declaration: from ex_date if present, else the filing date. */
function fiscalYear(exDate: string | null, filedAt: string): string {
  const iso = exDate ?? filedAt;
  const m = /^(\d{4})/.exec(iso);
  return m ? m[1] : new Date(filedAt).getUTCFullYear().toString();
}

/**
 * Deterministic fiscal reference for the dividend natural key (and the reader row). FINAL →
 * `FY{year}`; INTERIM → `{year}-INT`; SPECIAL → `{year}-SPL`. Stable across re-runs of the SAME
 * declaration (idempotency), and NOT keyed on ex_date so a corrected ex_date supersedes the object
 * (a new revision) rather than minting a duplicate.
 */
export function deriveFiscalRef(
  divType: NormalizedDividend['divType'],
  exDate: string | null,
  filedAt: string,
): string {
  const yr = fiscalYear(exDate, filedAt);
  if (divType === 'FINAL') return `FY${yr}`;
  if (divType === 'INTERIM') return `${yr}-INT`;
  return `${yr}-SPL`;
}

/**
 * Build a NormalizedDividend (CONTRACT §6.4) from a filing's extracted dividend facts, or null when
 * the facts carry no usable DPS (the producer skips those — a filing typed DIVIDEND that the extractor
 * could not read a per-share figure from is not a declaration we can stand behind).
 */
export function extractDividend(row: DividendFilingRow): NormalizedDividend | null {
  const facts = row.aiDividend;
  if (!facts) return null;
  const dps = toDps(facts.dps);
  if (dps === null) return null;

  const divType = normalizeDivType(row.title);
  const exDate = parseIsoDate(facts.ex_date);
  return {
    venue: row.venue,
    ticker: row.ticker,
    divType,
    fiscalRef: deriveFiscalRef(divType, exDate, row.filedAt),
    dps,
    currency: normalizeCurrency(facts.currency, row.venue),
    exDate,
    recordDate: parseIsoDate(facts.record_date),
    payDate: parseIsoDate(facts.pay_date),
    verification: 'disclosure',
  };
}

/**
 * The DIVIDEND.EXDATE natural key. Deterministic + colon-delimited per CONTRACT §6.5
 * (`DIVIDEND.EXDATE:TDWL:7010:2026-INT1`). Keyed on (venue, ticker, div_type, fiscal_ref) so a
 * re-scrape of the SAME declaration collapses onto one object and a corrected value supersedes it.
 */
export function dividendNaturalKey(
  d: Pick<NormalizedDividend, 'venue' | 'ticker' | 'divType' | 'fiscalRef'>,
): string {
  return `DIVIDEND.EXDATE:${d.venue}:${d.ticker}:${d.divType}:${d.fiscalRef ?? 'NA'}`;
}

/** The disclosure (venue-filing) root — always present; it IS the declaration. */
export function disclosureRoot(filingId: number, sourceRef: string | null): LineageRoot {
  return {
    root: 'disclosure',
    rank: EXCHANGE_RANK,
    filingId,
    ...(sourceRef ? { sourceRef } : {}),
  };
}

/**
 * Assemble the lineage roots. `corroborating` is the SECOND, independent source when the producer
 * found one (the equity-projection dividend's source lake object, a registrar/aggregator DPS, or a
 * second venue filing). count ≥2 ⇒ double-sourced; sourceRank = the lowest (primary-wins) rank.
 */
export function buildLineageRoots(
  primary: LineageRoot,
  corroborating?: LineageRoot | null,
): LineageResult {
  const roots = corroborating ? [primary, corroborating] : [primary];
  const sourceRank = roots.reduce((min, r) => Math.min(min, r.rank), Number.POSITIVE_INFINITY);
  return { roots, count: roots.length, sourceRank };
}

/** The DIVIDEND.EXDATE lake-object payload (snake_case, no clock/id — stable content hash). */
export function dividendObjectPayload(
  d: NormalizedDividend,
  filingId: number,
  lineage: LineageResult,
): DividendObjectPayload {
  return {
    venue: d.venue,
    ticker: d.ticker,
    div_type: d.divType,
    fiscal_ref: d.fiscalRef ?? 'NA',
    dps: d.dps,
    currency: d.currency,
    ex_date: d.exDate ?? null,
    record_date: d.recordDate ?? null,
    pay_date: d.payDate ?? null,
    verification: d.verification,
    source_filing_id: filingId,
    lineage_roots: lineage.roots,
    lineage_root_count: lineage.count,
  };
}

/** The public.dividends upsert row (state pending_confirm — the 33b human gate promotes to live). */
export function dividendUpsertRow(
  d: NormalizedDividend,
  securityId: number,
  sourceObjectId: string,
): DividendUpsertRow {
  return {
    security_id: securityId,
    div_type: d.divType,
    fiscal_ref: d.fiscalRef ?? null,
    dps: d.dps,
    currency: d.currency,
    ex_date: d.exDate ?? null,
    record_date: d.recordDate ?? null,
    pay_date: d.payDate ?? null,
    verification: d.verification,
    state: 'pending_confirm',
    source_object_id: sourceObjectId,
  };
}
