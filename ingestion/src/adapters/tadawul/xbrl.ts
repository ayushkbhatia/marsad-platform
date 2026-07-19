/**
 * Tadawul XBRL_DOCS parser — the FREE, deterministic financials source (no LLM, exact figures).
 * The company-profile "Financial Statements and Reports" list links an XBRL `.html` per filing
 * (`/Resources/XBRL_DOCS/{issuer}_{symbol}_{date}_Eng.html`). It renders the full IFRS statements as
 * `<table class='gridtable'>` blocks: a two-row date header (Start Date / End Date, one column per
 * period incl. the prior-period comparative) then hierarchical IFRS-labelled data rows
 * (`label | value_p1 | value_p2 | noteNo`), values in ACTUAL units, comma-grouped.
 *
 * PURE — html string in, `ExtractedFinancials` out (the SAME contract the LLM path emits), so it flows
 * through the identical `validateExtraction` gate + `assembleFromExtraction` + `fn_financials_project`.
 * Preferred over the PDF+LLM path wherever XBRL exists; the LLM path covers pre-XBRL filings.
 *
 * ALSO exposes `parseTadawulProfile` (2026-07-16): the SAME filing's `[100010] Filing information` block
 * carries the entity identity — ISIN, sector/industry — which the current extractor drops. Emitting it
 * as a NormalizedProfile fills DEF-SECTOR-DATA's TDWL half Mubasher-free (the fields ride XBRL the cron
 * already fetches). shares_outstanding is genuinely NOT in the XBRL, so it stays null (the Mubasher/ADX
 * shares producer is unaffected — the projection coalesces, never wipes).
 *
 * PROVENANCE: recovered 2026-07-16 from the live VPS build (dist/adapters/tadawul/xbrl.js). parseTadawulXbrl
 * is reconstructed byte-behaviour-identical (golden-verified against a real SABIC filing).
 */
import { mapSectorToTaxonomy } from '../../lake/sector-taxonomy.js';
import type { ExtractedFinancials, ExtractedStatement } from '../../lake/statement-extraction.js';
import type { PeriodKind, StatementType } from '../../lake/statement-normalizer.js';
import type { NormalizedProfile } from '../../core/types.js';

// ── html helpers (dependency-free) ──
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
const rowsOf = (table: string): string[] => table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
const cellsOf = (tr: string): string[] => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test((s || '').trim());
/** '1,549,146,837' → 1549146837 ; '-75,250,331' → -75250331 ; '' / non-numeric → null. */
function num(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/,/g, '').replace(/[()]/g, (m) => (m === '(' ? '-' : '')).trim();
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
// 160 (was 80): at 80, SABIC's two "share of OCI of associates … that will / will not be reclassified
// to profit or loss" rows truncate onto ONE key and the second value silently overwrites nothing (Phase B).
const snake = (label: string): string => label.toLowerCase().replace(/\[abstract\]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160);

// ── label → §3.1 canonical key (exact-ish IFRS labels; additive to the raw line_items) ──
const CANON: ReadonlyArray<[RegExp, string]> = [
  [/^total assets$/i, 'total_assets'],
  [/^total liabilities$/i, 'total_liabilities'],
  [/^total equity$/i, 'equity'],
  [/^total equity attributable to (owners|equity holders)/i, 'equity_attributable_to_parent'],
  [/^total current liabilities$/i, 'current_liabilities'],
  [/^total current assets$/i, 'total_current_assets'],
  [/^(bank balances and cash|cash and cash equivalents)$/i, 'cash'],
  [/^(revenue|revenues|total revenues)$/i, 'revenue'],
  [/^total operating income$/i, 'total_operating_income'],
  [/^gross profit( \(loss\))?$/i, 'gross_profit'],
  [/^cost of (sales|revenue)$/i, 'cost_of_sales'],
  [/^operating profit( \(loss\))?$/i, 'ebit'],
  [/^finance costs$/i, 'finance_costs'],
  [/^finance income$/i, 'finance_income'],
  [/^profit \(loss\) for( the)? (period|year)$/i, 'net_income'],
  [/^profit \(loss\), attributable to (owners|equity holders) of( the)? parent/i, 'net_income_attributable_to_parent'],
  [/^total (basic )?earnings \(loss\) per share$/i, 'eps_basic'],
  [/^total diluted earnings \(loss\) per share$/i, 'eps_diluted'],
  [/^net cash flows from \(used in\) operating activities$/i, 'cfo'],
  [/^net cash flows from \(used in\) investing activities$/i, 'cfi'],
  [/^net cash flows from \(used in\) financing activities$/i, 'cff'],
  [/depreciation.*(property, plant|impairment)/i, 'dep_amort'],
  [/^purchase of property, plant and equipment$/i, 'capex'],
  [/^dividends paid/i, 'dividends_paid'],
];
const canonKey = (label: string): string | null => { for (const [re, k] of CANON) if (re.test(label)) return k; return null; };
const PER_SHARE = /per share/i;

/** Classify a statement table by its title/abstract rows. Returns null for notes/equity/non-core tables
 *  (the dimensional changes-in-equity table is detected separately — see parseEquityTable). */
function classify(table: string): StatementType | null {
  const head = stripTags(table).slice(0, 400);
  if (/statement of financial position/i.test(head)) return 'balance';
  if (/statement of cash flows/i.test(head)) return 'cashflow';
  // OCI — ordered BEFORE income and matched on TITLE, never code ([300300] is SABIC's income code but
  // Al Rajhi's OCI code). Only the PURE other-comprehensive-income table: "other" or a tax qualifier.
  // A bare "statement of comprehensive income" is left unclassified (ambiguous — often the combined P&L).
  if (/statement of other comprehensive income|statement of comprehensive income,? (before|after) tax/i.test(head)) return 'oci';
  // income: the P&L — INCLUDING the combined "profit or loss and other comprehensive income" single
  // statement (the pre-Phase-B lookahead excluded it, so combined-statement filers were dropped entirely).
  if (/statement of (income|profit or loss)/i.test(head)) return 'income';
  return null;
}
function periodKindOf(start: string, end: string): 'annual' | 'quarter' {
  const ms = (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60 * 24 * 30.4);
  return ms >= 10.5 ? 'annual' : 'quarter';
}
/** period_end + kind → the fiscal_period token (matches the LLM path: annual '2025', quarter 'Q4 2025'). */
function fiscalPeriodOf(end: string, kind: 'annual' | 'quarter'): string {
  const d = new Date(end);
  const y = d.getUTCFullYear();
  if (kind === 'annual') return String(y);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${y}`;
}
/** Read the filer-declared presentation scale ("Level of rounding used in financial statements":
 *  Actuals | Thousands | Millions | Billions). Filers differ (Arabian Drilling=Actuals, Al Rajhi=Thousands)
 *  → hardcoding 'units' makes thousands-filers 1000× too small. Default 'units' if the row is absent. */
function detectScale(html: string): ExtractedFinancials['scale'] {
  const m = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').match(/Level of rounding used in financial statements\s+([A-Za-z]+)/i);
  const v = (m?.[1] || '').toLowerCase();
  if (v.startsWith('thousand')) return 'thousands';
  if (v.startsWith('million')) return 'millions';
  if (v.startsWith('billion')) return 'billions';
  return 'units';
}

interface XbrlPeriodCol { idx: number; start: string; end: string; kind: 'annual' | 'quarter'; fp: string; comparative: boolean }

// ─────────────────────────────────────────────────────────────────────────────
// Changes-in-equity (Phase B) — the DIMENSIONAL table the date-grid model can't read.
// Shape (verified on SABIC): row 0 = one blank label cell + N member cells each
// `colspan=P` ("Share capital [member]" … "Total equity [member]") + a Note cell;
// then Start Date / End Date rows with P dates per member; then data rows of
// 1 + N×P values. Column i ⇒ (member = expanded[i], period = endDates[i]).
// ─────────────────────────────────────────────────────────────────────────────

/** Raw cell strings WITH attributes (cellsOf strips tags — colspan would be lost). */
const rawCellsOf = (tr: string): string[] => tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
const colspanOf = (cell: string): number => {
  const m = /colspan=['"]?(\d+)/i.exec(cell);
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
};
const MEMBER_SUFFIX = /\s*\[member\]\s*$/i;
const SKIP_LABEL = /\[abstract\]$|\[line items\]$/i;

/** Detect + parse one changes-in-equity table into per-period ExtractedStatements.
 *  Returns [] when the table is not an equity table. Encoding: every (row, member)
 *  value lands under `${snake(row)}__${snake(member)}`; the "Total equity" member
 *  ALSO lands under the bare `${snake(row)}` key — the roll-forward headline a
 *  reader/agent wants (`dividends_and_others`, `equity_balance_at_end_of_period`) —
 *  and only bare keys enter `presentation` (so every presentation key resolves). */
function parseEquityTable(table: string): ExtractedStatement[] {
  if (!/\[member\]/i.test(table)) return [];
  if (!/statement of changes in equity/i.test(stripTags(table).slice(0, 3000))) return [];

  const rawRows = rowsOf(table);
  // Member header = the first row carrying [member] cells.
  const memberRowIdx = rawRows.findIndex((r) => /\[member\]/i.test(r));
  if (memberRowIdx < 0) return [];
  const memberCells = rawCellsOf(rawRows[memberRowIdx]!);
  // Expand by colspan; drop the leading label column. A non-member trailing cell ("Note No.")
  // expands too and is excluded by the member-suffix test per column.
  const memberByCol: (string | null)[] = [];
  for (let c = 1; c < memberCells.length; c++) {
    const raw = memberCells[c]!;
    const text = stripTags(raw);
    const isMember = MEMBER_SUFFIX.test(text);
    const name = isMember ? text.replace(MEMBER_SUFFIX, '').trim() : null;
    for (let k = 0; k < colspanOf(raw); k++) memberByCol.push(name);
  }

  const rows = rawRows.map(cellsOf);
  const startRow = rows.find((c) => /^start date$/i.test(c[0] || ''));
  const endRow = rows.find((c) => /^end date$/i.test(c[0] || ''));
  if (!startRow || !endRow) return [];

  // Column i (0-based over value columns) ⇒ endRow[i+1] / startRow[i+1] / memberByCol[i].
  const nCols = Math.min(memberByCol.length, endRow.length - 1);
  const newestEnd = endRow.slice(1, nCols + 1).filter(isDate).sort().pop() || '';

  const acc = new Map<string, ExtractedStatement>();
  const presSeen = new Map<string, Set<string>>();

  for (const row of rows) {
    const label = row[0] || '';
    if (!label || SKIP_LABEL.test(label) || /^(start|end) date$/i.test(label)) continue;
    const bare = snake(label);
    if (!bare) continue;
    for (let i = 0; i < nCols; i++) {
      const member = memberByCol[i];
      if (!member) continue; // Note column / non-member spans
      const end = endRow[i + 1];
      if (!isDate(end)) continue;
      const v = num(row[i + 1]);
      if (v === null) continue;
      const start = isDate(startRow[i + 1]) ? startRow[i + 1] : `${end.slice(0, 4)}-01-01`;
      const kind = periodKindOf(start, end);
      let st = acc.get(end);
      if (!st) {
        st = { statement_type: 'equity_change', period_kind: kind, fiscal_period: fiscalPeriodOf(end, kind), period_end: end, is_comparative: end !== newestEnd, line_items: {}, presentation: [] };
        acc.set(end, st);
        presSeen.set(end, new Set());
      }
      const li = st.line_items as Record<string, number>;
      const mk = `${bare}__${snake(member)}`;
      if (li[mk] === undefined) li[mk] = v;
      if (/^total equity$/i.test(member)) {
        if (li[bare] === undefined) li[bare] = v;
        const seen = presSeen.get(end)!;
        if (!seen.has(bare)) {
          seen.add(bare);
          st.presentation!.push({ key: bare, label, depth: 0, is_subtotal: /^total\b/i.test(label) });
        }
      }
    }
  }
  return [...acc.values()].filter((s) => Object.keys(s.line_items).length > 0);
}

/**
 * PURE. Parse a Tadawul XBRL_DOCS `.html` into ExtractedFinancials (actual units, scale from the header).
 * `currency` defaults to SAR (Tadawul); override via opts if a non-SAR filing appears.
 */
export function parseTadawulXbrl(html: string, opts: { currency?: string } = {}): ExtractedFinancials {
  const currency = opts.currency || 'SAR';
  const scale = detectScale(html);
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  // Collect per (statement_type, period_end) → line_items, so multiple table fragments merge cleanly.
  const acc = new Map<string, ExtractedStatement>();
  // Presentation capture (Phase A): printed label + document order per statement, dedup by key.
  // depth stays 0 — the XBRL_DOCS HTML carries no indent markup (plain <td>, no padding/style).
  const presSeen = new Map<string, Set<string>>();
  for (const table of tables) {
    const stype = classify(table);
    if (!stype) {
      // Phase B: the dimensional changes-in-equity table has no classifiable title in its head
      // (row 0 is the member header) — detect + parse it separately, merge into the same acc.
      for (const st of parseEquityTable(table)) {
        const key = `${st.statement_type}|${st.period_end}`;
        const prior = acc.get(key);
        if (!prior) {
          acc.set(key, st);
        } else {
          // Fragment merge: first value wins per key (mirrors the grid path).
          for (const [k, v] of Object.entries(st.line_items)) {
            if ((prior.line_items as Record<string, number | null>)[k] === undefined) (prior.line_items as Record<string, number | null>)[k] = v;
          }
          const seen = new Set((prior.presentation || []).map((r) => r.key));
          for (const r of st.presentation || []) if (!seen.has(r.key)) { seen.add(r.key); prior.presentation!.push(r); }
        }
      }
      continue;
    }
    const rows = rowsOf(table).map(cellsOf);
    const startRow = rows.find((c) => /^start date$/i.test(c[0] || ''));
    const endRow = rows.find((c) => /^end date$/i.test(c[0] || ''));
    if (!startRow || !endRow) continue;
    // Period columns = the date cells in the End Date row (index 1..k). Start dates align by index.
    const periods: XbrlPeriodCol[] = [];
    for (let i = 1; i < endRow.length; i++) {
      if (!isDate(endRow[i])) continue;
      const end = endRow[i];
      const start = isDate(startRow[i]) ? startRow[i] : `${end.slice(0, 4)}-01-01`;
      const kind = periodKindOf(start, end);
      periods.push({ idx: i, start, end, kind, fp: fiscalPeriodOf(end, kind), comparative: periods.length > 0 });
    }
    if (!periods.length) continue;
    for (const row of rows) {
      const label = row[0] || '';
      if (!label || /\[abstract\]$/i.test(label)) continue; // section header, no values
      const ck = canonKey(label);
      const sk = snake(label);
      if (!sk) continue;
      for (const p of periods) {
        const v = num(row[p.idx]);
        if (v === null) continue;
        const key = `${stype}|${p.end}`;
        let st = acc.get(key);
        if (!st) {
          st = { statement_type: stype, period_kind: p.kind, fiscal_period: p.fp, period_end: p.end, is_comparative: p.comparative, line_items: {}, presentation: [] };
          acc.set(key, st);
          presSeen.set(key, new Set());
        }
        const seen = presSeen.get(key)!;
        if (!seen.has(sk)) {
          seen.add(sk);
          st.presentation!.push({ key: sk, label, depth: 0, is_subtotal: /^total\b/i.test(label) });
        }
        const li = st.line_items as Record<string, number>;
        // raw label always; canonical key when matched (per-share values pass through unscaled downstream)
        if (li[sk] === undefined) li[sk] = v;
        if (ck && li[ck] === undefined) li[ck] = v;
        // if only basic EPS exists, also satisfy the ratio engine's eps_diluted
        if (ck === 'eps_basic' && li['eps_diluted'] === undefined && PER_SHARE.test(label)) li['eps_diluted'] = v;
      }
    }
  }
  const statements = [...acc.values()].filter((s) => Object.keys(s.line_items).length > 0);
  return { currency, scale, statements };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity profile (ISIN + sector/industry) — the `[100010] Filing information` block classify() drops.
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-6166: 2 alpha country + 9 alnum + 1 check digit (e.g. 'SA0007879121'). */
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
/** Boomerang/mPulse JS is injected into some (bank) value cells — reject a value that is really a script. */
const CELL_JS = /function\s*\(|BOOMR|go-mpulse|mpulse|boomerang|<script/i;
/** The two compound `[100010]` rows we read (whitespace around the pipe varies filer-to-filer). */
const L_SYMBOL_ISIN = /^company symbol code\s*\|\s*isin code$/;
const L_SECTOR_INDUSTRY = /^sector\s*\|\s*industry group$/;

/**
 * PURE. Extract the entity identity from a Tadawul XBRL filing's `[100010] Filing information` block.
 * Returns a NormalizedProfile (venue TDWL) or null if the filing carries no identity block.
 *
 * DETECTION: the `[100010]` bracket code appears only in a title/nav table with no value rows, so we scan
 * EVERY table's rows and match the LABEL cell (whitespace-collapsed) — the real data is in a date-headered
 * table. SECTOR: the raw cell is "Sector | Industry" (e.g. "Financials | Banks"); we feed the WHOLE string
 * to mapSectorToTaxonomy so the more-specific industry token wins the ordered rules — "Financials | Banks"
 * → `/bank/` → 'banks' (the sector cell alone, 'Financials', would mis-map to 'financials' and file every
 * bank under the wrong ratio set + Score cohort). shares_outstanding is NOT in the XBRL → stays null.
 */
export function parseTadawulProfile(html: string, ticker: string): NormalizedProfile | null {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  // First non-empty, non-JS value cell of the first row whose label matches.
  const findValue = (labelRe: RegExp): string | null => {
    for (const table of tables) {
      for (const cells of rowsOf(table).map(cellsOf)) {
        const label = (cells[0] || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!labelRe.test(label)) continue;
        for (let i = 1; i < cells.length; i++) {
          const v = (cells[i] || '').trim();
          if (v && !CELL_JS.test(v)) return v;
        }
      }
    }
    return null;
  };

  const symbolIsin = findValue(L_SYMBOL_ISIN);   // "2010 | SA0007879121"
  const sectorIndustry = findValue(L_SECTOR_INDUSTRY); // "Materials | Chemicals"

  let isin: string | null = null;
  if (symbolIsin) {
    const cand = (symbolIsin.split('|')[1] || '').trim().toUpperCase();
    if (ISIN_RE.test(cand)) isin = cand;
  }

  let sector = 'unknown';
  let rawSector: string | null = null;
  let industry: string | null = null;
  if (sectorIndustry) {
    rawSector = sectorIndustry.trim();
    sector = mapSectorToTaxonomy(sectorIndustry).sector; // combined string → industry token wins
    industry = (sectorIndustry.split('|')[1] || '').trim() || null;
  }

  // No identity fields at all ⇒ not a profile-bearing filing (don't stage an empty object).
  if (isin === null && rawSector === null) return null;

  return { venue: 'TDWL', ticker, sector, rawSector, isin, sharesOutstanding: null, industry };
}
