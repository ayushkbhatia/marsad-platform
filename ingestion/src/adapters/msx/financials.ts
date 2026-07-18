// MSX (Muscat Stock Exchange) — snapshot.aspx "Financials Reports" tab: the statement-filing INDEX.
//
// The tab is a jQuery.tmpl grid over a plain ASP.NET ScriptService — NOT a WebForms postback, and NOT
// present in the served HTML (curl'ing snapshot.aspx yields zero .zip hrefs; the rows are injected
// client-side). Verified live 2026-07-17, DIRECT, cold: no cookie, no session, no ViewState, no WAF
// challenge — Incapsula fronts the site but does not gate these calls:
//   POST https://www.msx.om/snapshot.aspx/FinancialsReports
//        {"Symbol":"BKMB","Year":""}          ← Year:"" ⇒ the ENTIRE history in one call (BKMB: 118 rows)
//   → { d: [ { ReportID, ReportYear, NameEn, CategoryID, TitleEn, FileNameEn, UploadDate, … } ] }
// then each report's artifact is a public static download:
//   GET https://www.msx.om/MSMDOCS/FinancialReports/{FileNameEn}    → application/x-zip-compressed
//
// So MSX needs NO browser and NO residential proxy (unlike Tadawul, which is Akamai-walled) — this is the
// BHB shape. See scripts/researchers/msx-financials.mjs (Class-B researcher) and
// docs/architecture/08-worker-fleet.md.
//
// The artifact is a ZIP, not a PDF — and it is a PRE-SEGMENTED statement set, one PDF per statement:
//   11_AAIC_FilingInformation_11022026_53.pdf   ← machine-readable metadata sheet (periods/rounding/sector)
//   2_AAIC_BalanceSheet_…pdf   3_AAIC_IncomeStatement_…pdf   4_AAIC_CashFlowStatements_…pdf   …
// The PDFs are digital text (no OCR needed) rendered from XBRL, so their line items carry verbatim IFRS
// taxonomy labels. MSX publishes no XBRL/XML anywhere — these PDFs ARE the machine-readable source.
//
// ── Traps this module exists to absorb (all verified live, all silent-corruption class) ──
//  1. THE FILENAME YEAR IS FISCAL, NOT CALENDAR, and the fiscal calendar VARIES BY COMPANY.
//     `AAIC_2025_Q3` is the quarter 01/10/2025–31/12/2025 (AAIC's FY starts 1 April); GICI/BKMB are
//     Dec-31 filers. NEVER infer a period from ReportYear/NameEn. TitleEn carries the true period END
//     ("…for Quarter 3 ended on 2025-12-31"); the authoritative start+end live in FilingInformation.
//  2. SYMBOLS DRIFT. AAIC's own history files under AAIC (2021+), AAIT (2014–20) and 177 (2005–14).
//     NEVER construct a FileNameEn from the current ticker — always use the one the index hands back.
//  3. RESTATEMENTS ARE REAL. BKMB publishes `Yearly (Un-Audited)` (Jan) then `Yearly (Audited)` (Mar) for
//     the SAME period end. Both are distinct ReportIDs; audited supersedes. CategoryID ranks them.
//  4. TITLE FORMATS DRIFT pre-~2022 into free text ("Unaudited Financial Reports Q2 2021"), and a
//     `Q3 (Reviewed)` variant exists. parseReportPeriod returns nulls rather than guessing.
//  5. FileNameEn is DIRTY: real values contain spaces and at least one double space
//     ("AAIT  _2014_Yearly_e.zip"). Encode the segment; never trim into the name.
//
// Golden fixture: ingestion/fixtures/msx/financials-reports-BKMB.json (real live response, 118 reports).

/** Bump ⇒ downstream treats prior parses as replay-eligible. */
export const MSX_FINANCIALS_PARSER_VERSION = 1;

export const MSX_ORIGIN = 'https://www.msx.om';
const REPORTS_PATH = '/MSMDOCS/FinancialReports';

/** The ScriptService index endpoint (POST, JSON in / {d:[…]} out). */
export function msxFinancialsReportsUrl(): string {
  return `${MSX_ORIGIN}/snapshot.aspx/FinancialsReports`;
}

/** Request body for the index. `year` empty ⇒ the entire history for the symbol (the default, and what
 *  the live page itself issues on load). */
export function msxFinancialsReportsBody(symbol: string, year = ''): string {
  return JSON.stringify({ Symbol: symbol, Year: year });
}

/** FileNameEn → absolute artifact url. The name carries spaces/parens verbatim; encode the SEGMENT only
 *  (encodeURIComponent would eat the path separators, and the name is never a path). */
export function msxReportZipUrl(fileName: string): string {
  return `${MSX_ORIGIN}${REPORTS_PATH}/${encodeURIComponent(fileName)}`;
}

/** One statement filing from the index, with its period metadata parsed as far as is SAFE. */
export interface MsxFinancialReport {
  /** MSX's stable per-report id — the dedup / incremental-skip anchor. */
  reportId: string;
  /** `MSX-FS-{reportId}` — the public.filings (venue_code, source_ref) key. */
  sourceRef: string;
  /** Period label as filed, e.g. "Q3 (Un-Audited)" | "Yearly (Audited)" | "Q3 (Reviewed)". */
  nameEn: string;
  /** Full filed title, e.g. "Unaudited financial statements for Quarter 3 ended on 2025-12-31". */
  titleEn: string;
  /** MSX's FISCAL year label off the filename — NOT a calendar year. Metadata only. */
  reportYear: string;
  /** MSX period-category id: 1..3 = Q1..Q3, 6 = Yearly (Un-Audited), 7 = Yearly (Audited). */
  categoryId: string;
  /** English zip filename, e.g. "BKMB_2026_Q1 (Un-Audited)_e.zip". Use verbatim — do not reconstruct. */
  fileNameEn: string;
  /** Absolute url of the English zip. */
  zipUrl: string;
  /** 'YYYY-MM-DD' period end parsed from titleEn, or null when the title predates the structured format. */
  periodEnd: string | null;
  /** 'annual' | 'quarter' | null. */
  periodKind: 'annual' | 'quarter' | null;
  /** Whether this filing is the AUDITED cut of its period (CategoryID 7). Drives restatement ranking. */
  audited: boolean;
  /** Upload date as filed ("Apr 28, 2026") → 'YYYY-MM-DD', or null. The 5-year window anchor. */
  uploadDate: string | null;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse MSX's UploadDate ("Apr 28, 2026") to 'YYYY-MM-DD'. Pure string work — no Date construction, so no
 * timezone can shift the day. Returns null on any other shape.
 */
export function parseUploadDate(s: string): string | null {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS[(m[1] ?? '').toLowerCase()];
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || !Number.isFinite(day) || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Period parse from TitleEn. The modern (≈2022+) title format is structured and states the TRUE period
 * end regardless of the company's fiscal calendar:
 *   "Unaudited financial statements for Quarter 3 ended on 2025-12-31"
 *   "Audited financial statements for the year ended on 2026-03-31"
 *   "Financial statement for quarter ending 2021-09-30"        ← the 'ending', no-'on' variant
 *
 * Only an ISO date immediately following ended/ending is accepted. Pre-~2022 titles degrade to free text
 * ("Unaudited Financial Reports Q2 2021", "…for the year ended 31st March 2021") and those are DELIBERATELY
 * NOT parsed. Refusing to guess is the whole point: MSX fiscal calendars vary by issuer, so a month-name
 * heuristic would confidently produce a period that is wrong by a quarter for every non-Dec filer, and a
 * wrong period silently corrupts a statement row. ~15% of in-window reports (the 2021 tail) land null here;
 * that is fine — the AUTHORITATIVE period start+end live in each zip's FilingInformation document, which
 * the deferred extractor reads (DEF-MSX-STMT-EXTRACT). This field is a convenience hint, not a source.
 *
 * periodKind still resolves off NameEn/CategoryID (reliable across the whole history) even when the date
 * does not parse, so a caller can always tell annual from quarterly.
 */
export function parseReportPeriod(titleEn: string, nameEn: string): Pick<MsxFinancialReport, 'periodEnd' | 'periodKind'> {
  const m = /end(?:ed|ing)\s+(?:on\s+)?(\d{4})-(\d{2})-(\d{2})/i.exec(titleEn);
  const periodEnd = m ? `${m[1]}-${m[2]}-${m[3]}` : null;

  const label = `${nameEn} ${titleEn}`.toLowerCase();
  const periodKind: 'annual' | 'quarter' | null =
    /\byearly\b|\bannual\b|\bthe year\b/.test(label) ? 'annual'
      : /\bq[1-4]\b|\bquarter\b/.test(label) ? 'quarter'
        : null;

  return { periodEnd, periodKind };
}

/** Rows live under `d` (ScriptService envelope); tolerate a bare array. */
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    const d = payload['d'] ?? payload['D'];
    if (Array.isArray(d)) return d.filter(isObj);
    // ScriptService occasionally double-encodes `d` as a JSON string.
    if (typeof d === 'string') {
      try {
        const inner: unknown = JSON.parse(d);
        if (Array.isArray(inner)) return inner.filter(isObj);
      } catch {
        /* fall through to [] */
      }
    }
  }
  return [];
}

/**
 * PURE parser: FinancialsReports response bytes → MsxFinancialReport[] (newest first, as MSX orders them).
 * Malformed JSON, a missing envelope, or rows without a ReportID/FileNameEn yield [] or are skipped — a
 * CHANGED-but-unparseable body surfaces upstream as zero targets, never a crash. Rows are de-duplicated on
 * ReportID. Arabic-only reports (no FileNameEn) are dropped: we archive the English cut.
 */
export function parseMsxFinancialReports(body: Buffer | string): MsxFinancialReport[] {
  let payload: unknown;
  try {
    const text = (typeof body === 'string' ? body : body.toString('utf8')).replace(/^﻿/, '');
    payload = JSON.parse(text);
  } catch {
    return [];
  }

  const out: MsxFinancialReport[] = [];
  const seen = new Set<string>();

  for (const row of locateRows(payload)) {
    const reportId = str(row['ReportID'] ?? row['ReportId']);
    const fileNameEn = str(row['FileNameEn']);
    if (reportId === '' || fileNameEn === '') continue;
    if (seen.has(reportId)) continue;
    seen.add(reportId);

    const nameEn = str(row['NameEn']);
    const titleEn = str(row['TitleEn']);
    const categoryId = str(row['CategoryID'] ?? row['CategoryId']);
    const period = parseReportPeriod(titleEn, nameEn);

    out.push({
      reportId,
      sourceRef: `MSX-FS-${reportId}`,
      nameEn,
      titleEn,
      reportYear: str(row['ReportYear']),
      categoryId,
      fileNameEn,
      zipUrl: msxReportZipUrl(fileNameEn),
      periodEnd: period.periodEnd,
      periodKind: period.periodKind,
      // CategoryID 7 is the audited annual; 6 is the un-audited annual for the SAME period end.
      audited: categoryId === '7' || /\(audited\)/i.test(nameEn),
      uploadDate: parseUploadDate(str(row['UploadDate'])),
    });
  }

  return out;
}

/**
 * Keep only reports whose UploadDate falls on/after `sinceIso` ('YYYY-MM-DD'). UploadDate is the window
 * anchor rather than periodEnd because it is uniformly formatted across MSX's whole history, whereas
 * pre-2022 titles carry no parseable period. Rows with an unparseable UploadDate are DROPPED — they are
 * pre-2022 free-text-era filings, i.e. outside any recent window by construction.
 */
export function withinUploadWindow(reports: MsxFinancialReport[], sinceIso: string): MsxFinancialReport[] {
  return reports.filter((r) => r.uploadDate !== null && r.uploadDate >= sinceIso);
}
