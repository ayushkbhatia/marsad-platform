// BHB (Bahrain Bourse) — CompanyProfile "Statements" tab: the financial-statement PDF INDEX.
//
// The CompanyProfile page's Statements tab is backed by a plain JSON webapi (same host + same dynamic
// `Authorization: Bearer <APIKey>` as BHB quotes/filings — verified live 2026-07-16, DIRECT from the VPS,
// no browser / proxy / SharePoint attachment resolver):
//   GET https://webapi.bahrainbourse.com/api/data/GetCompanyFinancialStatements
//        ?listUrl=%2Fen%2Fcompany%2F{SYMBOL}%2FLists%2FFinancial%2520Statements%2F&websiteID=bhb
//   → { status:1, data:[ { title, fileColl:[ { title, linkUrl } ] } ], message:"" }
// where `title` is a period label ("Financial Statements for the period ended 31 December 2025"),
// `fileColl[].title` is a link label ("View" | "View (PDF)" | "Annual Report") and `fileColl[].linkUrl`
// is a site-relative PDF path (`/Documents/.../*.pdf` or `/resources/files/*.pdf`) that downloads direct
// (200, application/pdf). ALBH returns 10 years (2016..2025).
//
// This module is the PURE, testable index parser + URL builder. It does NOT fetch or extract — the
// fundamental backfill runs as a systemd researcher (scripts/researchers/bhb-financials.mjs, the cheap-
// HTTP analogue of tadawul-gapfill: no headed Chromium, no residential proxy — BHB is not WAF-walled).
// The researcher imports this module (compiled to dist) to turn the index JSON into download targets, then
// downloads each PDF direct → pdftotext → `claude -p` → extractToStatements('BHB', …) → lake.objects
// (FILING.FINANCIALS, source_rank 20) → public.financial_statements, and archives the PDF to the `filings`
// bucket + catalogues public.filings. See docs/architecture/08-worker-fleet.md (Class-B researchers).
//
// Golden fixture: ingestion/fixtures/bhb/financials-live.json (real ALBH GetCompanyFinancialStatements).

import { createHash } from 'node:crypto';

/** Bump ⇒ downstream treats prior extractions as replay-eligible. */
export const BHB_FINANCIALS_PARSER_VERSION = 1;

export const BHB_WEBAPI_ORIGIN = 'https://webapi.bahrainbourse.com';
const BHB_ORIGIN = 'https://bahrainbourse.com';

/** One downloadable statement PDF, flattened from data[].fileColl[] with its parsed period metadata. */
export interface BhbStatementDoc {
  /** Raw period label from data[].title, e.g. "Financial Statements for the period ended 31 December 2025". */
  periodTitle: string;
  /** Link label from fileColl[].title, e.g. "View" | "View (PDF)" | "Annual Report". */
  label: string;
  /** Absolute, space-encoded PDF url on bahrainbourse.com. */
  url: string;
  /** Stable per-file id derived from the (decoded) link path — the incremental skip / source_ref anchor. */
  fileId: string;
  /** `BHB-FS-{fileId}` — the public.filings (venue_code, source_ref) key. */
  sourceRef: string;
  /** 'FY2025' | '2025-Q3' | null (coarse — extractToStatements reads the REAL periods from the PDF). */
  fiscalPeriod: string | null;
  /** 'annual' | 'quarter' | null. */
  periodKind: 'annual' | 'quarter' | null;
  /** 'YYYY-MM-DD' period end derived from the title date, or null. */
  periodEnd: string | null;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

/**
 * Build the CompanyProfile Statements-tab index URL for a RAW BHB ticker. The listUrl query value is the
 * SharePoint list path `/en/company/{SYMBOL}/Lists/Financial Statements/` with its space pre-encoded to
 * %20, then the whole value URL-encoded — so the space arrives double-encoded (%2520), exactly as the
 * live site issues it.
 */
export function companyFinancialStatementsUrl(symbol: string): string {
  const listUrl = `/en/company/${symbol}/Lists/Financial%20Statements/`;
  return `${BHB_WEBAPI_ORIGIN}/api/data/GetCompanyFinancialStatements?listUrl=${encodeURIComponent(listUrl)}&websiteID=bhb`;
}

/** Stable per-file id from a link path: sha1 of the decoded path, first 16 hex — collision-resistant and
 *  identical across runs (the incremental "owned" anchor, computed BEFORE any download). */
export function statementFileId(linkUrl: string): string {
  let decoded = linkUrl;
  try {
    decoded = decodeURIComponent(linkUrl);
  } catch {
    /* keep raw on malformed %-escape */
  }
  return createHash('sha1').update(decoded.toLowerCase()).digest('hex').slice(0, 16);
}

/** Site-relative link path → absolute, space-encoded bahrainbourse.com url. */
function absoluteUrl(u: string): string {
  if (u === '') return '';
  if (/^https?:\/\//i.test(u)) return u;
  const encoded = u.replace(/ /g, '%20');
  return `${BHB_ORIGIN}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Coarse period parse from a data[].title. Pulls the last "{day} {Month} {year}" from the label and maps
 * the month to a fiscal period: December ⇒ annual FY{year}; Mar/Jun/Sep ⇒ quarter {year}-Q{1,2,3}; any
 * other month falls back to a quarter keyed off the calendar quarter of that month. periodEnd is the
 * literal day/month/year from the title (a string build — no Date construction, no tz math). Returns all
 * nulls when no date is present. This is metadata only: the researcher persists the REAL periods that
 * extractToStatements reads from the PDF, so a coarse/failed parse never corrupts a statement row.
 */
export function parseStatementPeriod(title: string): Pick<BhbStatementDoc, 'fiscalPeriod' | 'periodKind' | 'periodEnd'> {
  const none = { fiscalPeriod: null, periodKind: null, periodEnd: null } as const;
  const re = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(title)) !== null) last = m;
  if (!last) return { ...none };

  const day = Number(last[1]);
  const month = MONTHS[(last[2] ?? '').toLowerCase()];
  const year = Number(last[3]);
  if (!month || !Number.isFinite(year) || !Number.isFinite(day)) return { ...none };

  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (month === 12) {
    return { fiscalPeriod: `FY${year}`, periodKind: 'annual', periodEnd };
  }
  const quarter = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  return { fiscalPeriod: `${year}-Q${quarter}`, periodKind: 'quarter', periodEnd };
}

/** Rows live under data[] (an array of {title, fileColl}); tolerate the odd top-level array. */
function locateGroups(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    const data = payload['data'] ?? payload['Data'];
    if (Array.isArray(data)) return data.filter(isObj);
  }
  return [];
}

/**
 * PURE parser: GetCompanyFinancialStatements JSON bytes → flat BhbStatementDoc[] (one entry per
 * downloadable PDF, newest first as the site orders them). status!=1, malformed JSON, or a missing
 * fileColl yield [] (never throw) — a CHANGED-but-unparseable body surfaces as zero targets upstream, not
 * a crash. Duplicate link paths (same fileId) are de-duplicated.
 */
export function parseCompanyFinancialStatements(body: Buffer | string): BhbStatementDoc[] {
  let payload: unknown;
  try {
    const text = (typeof body === 'string' ? body : body.toString('utf8')).replace(/^﻿/, '');
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  if (isObj(payload) && payload['status'] !== undefined && Number(payload['status']) !== 1) return [];

  const out: BhbStatementDoc[] = [];
  const seen = new Set<string>();

  for (const group of locateGroups(payload)) {
    const periodTitle = str(group['title'] ?? group['Title']);
    const period = parseStatementPeriod(periodTitle);
    const files = group['fileColl'] ?? group['FileColl'] ?? group['files'];
    if (!Array.isArray(files)) continue;

    for (const f of files) {
      if (!isObj(f)) continue;
      const link = str(f['linkUrl'] ?? f['LinkUrl'] ?? f['url'] ?? f['Url']);
      if (link === '' || !/\.pdf(\?|$)/i.test(link)) continue; // statement links are PDFs
      const fileId = statementFileId(link);
      if (seen.has(fileId)) continue;
      seen.add(fileId);

      out.push({
        periodTitle,
        label: str(f['title'] ?? f['Title']) || 'View',
        url: absoluteUrl(link),
        fileId,
        sourceRef: `BHB-FS-${fileId}`,
        fiscalPeriod: period.fiscalPeriod,
        periodKind: period.periodKind,
        periodEnd: period.periodEnd,
      });
    }
  }

  return out;
}
