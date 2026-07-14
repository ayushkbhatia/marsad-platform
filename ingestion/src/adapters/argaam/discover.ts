/**
 * Argaam financials discovery — PURE parsing of the Argaam financial-reports index
 * into statement references (docs/plans/p17-financials-pdf-architecture.md §3.1).
 * No I/O: the impure headless-index render + the open-S3 PDF download live in the
 * fetch half (argaam/fetch.ts); this module turns the rendered HTML into a clean,
 * deduplicable list of {ticker, year, period, lang, uuid, pdfUrl}.
 *
 * Argaam addresses every statement by period. The English link carries all the
 * metadata we need in its path:
 *   https://www.argaam.com/en/Tadawul/{MARKET}/{ticker}/financial-report/{year}/{period}/{uuid}.pdf
 * and the open S3 object (no WAF, plain http) is:
 *   https://argaamplus.s3.amazonaws.com/{uuid}.pdf
 * The Arabic sibling is a direct argaamplus.s3 link. We prefer EN (English-only, §0).
 *
 * INCREMENTAL (the coverage invariant, p17-continuous §2.1): the `uuid` is the stable
 * dedup key — a weekly run list-diffs the enumerated uuids against what the lake has
 * already ingested, so steady state emits only genuinely new statements.
 */

/** One statement PDF discovered on an Argaam index/company page. */
export interface ArgaamStatementRef {
  /** Marsad venue code, mapped from the Argaam market segment (TASI/NOMU → TDWL). */
  venue: string;
  /** Tadawul ticker, lower-cased slug as Argaam prints it (e.g. 'sabic', '2010'). */
  ticker: string;
  /** Fiscal year, e.g. 2026. */
  year: number;
  /** Argaam period token: 'Q1'|'Q2'|'Q3'|'Q4'|'Annual'. */
  period: string;
  /** Marsad period_kind. */
  periodKind: 'quarter' | 'annual';
  lang: 'en' | 'ar';
  /** The Argaam S3 object uuid — the stable dedup / list-diff key. */
  uuid: string;
  /** Open S3 PDF URL (plain http, no WAF). */
  pdfUrl: string;
  /** The page/link the ref was discovered on (provenance). */
  sourceUrl: string;
}

/** Argaam market segment → Marsad venue. Argaam covers the Saudi market (TASI/NOMU). */
const MARKET_VENUE: Record<string, string> = { TASI: 'TDWL', NOMU: 'TDWL' };

const S3_HOST = 'https://argaamplus.s3.amazonaws.com';

/** Argaam period token → Marsad period_kind. */
function periodKindOf(period: string): 'quarter' | 'annual' {
  return /annual|^fy$/i.test(period) ? 'annual' : 'quarter';
}

/**
 * PURE. Extract every English statement reference from Argaam index/company HTML.
 * Matches the SEO English link shape and recovers the S3 uuid + metadata from it.
 * Dedupes on uuid (the same statement can appear multiple times on a page).
 */
export function parseArgaamIndex(html: string, sourceUrl = ''): ArgaamStatementRef[] {
  const re =
    /\/(?:en\/)?Tadawul\/(TASI|NOMU)\/([a-z0-9-]+)\/financial-report\/(\d{4})\/([A-Za-z0-9]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf/gi;
  const seen = new Set<string>();
  const out: ArgaamStatementRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, market, ticker, yearStr, period, uuid] = m;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const venue = MARKET_VENUE[market.toUpperCase()];
    if (!venue) continue;
    out.push({
      venue,
      ticker: ticker.toLowerCase(),
      year: Number(yearStr),
      period,
      periodKind: periodKindOf(period),
      lang: 'en',
      uuid,
      pdfUrl: `${S3_HOST}/${uuid}.pdf`,
      sourceUrl,
    });
  }
  return out;
}

/**
 * PURE. The incremental filter (p17-continuous §2.1): keep only refs whose uuid the
 * lake has not already ingested. `known` is the set of already-seen Argaam uuids.
 */
export function newRefs(refs: ArgaamStatementRef[], known: ReadonlySet<string>): ArgaamStatementRef[] {
  return refs.filter((r) => !known.has(r.uuid));
}

/** The Argaam annual/quarterly index URL for a market segment + year (headless render target). */
export function argaamIndexUrl(marketSegmentId: number, year: number): string {
  return `https://www.argaam.com/en/company/financial-pdf/${marketSegmentId}/${year}`;
}
