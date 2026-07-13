// BHB (Bahrain Bourse) — eod_bulletin TaskSpec. EOD SOURCE OF RECORD for BHB.
//
// BHB publishes a Daily Trading Summary as an XLSX (route: Daily-Trading-Summary.aspx; the XLSX
// download link is pinned on the VPS into endpoint_config). Parsing the workbook directly avoids all
// HTML fragility — this is the GCC's easiest EOD ingestion (01-ingestion §2.6).
//
// STRUCTURE: the XLSX byte-decode requires the SheetJS `xlsx` package (declared in the ingestion
// package.json dependencies — `npm install` on the VPS/CI resolves it; not run by this builder). To
// keep the mapping logic pure + unit-testable
// WITHOUT the binary lib or a captured workbook, the transform is split:
//   * decodeWorkbook()  — thin, impure-ish: xlsx.read(buffer) -> sheet -> array-of-record rows.
//   * mapBulletinRows() — PURE: array-of-record rows -> NormalizedOhlcv[]. This is what the golden
//                          test exercises (inline rows), and what a real workbook flows through.
// No real XLSX fixture was capturable in the build sandbox; FIRST VPS RUN MUST capture a real
// Daily-Trading-Summary workbook into ingestion/fixtures/bhb/ and add a byte-level golden.

import type {
  FetchContext,
  FetchResult,
  NormalizedOhlcv,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const BHB_EOD_PARSER_VERSION = 1;

/** A generic worksheet row after header-keying: header label -> cell value. */
export type SheetRow = Record<string, string | number | null>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Case/space-insensitive header lookup across a small set of accepted BHB column labels. */
function cell(row: SheetRow, keys: string[]): string | number | null {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = new Set(keys.map(norm));
  for (const [k, v] of Object.entries(row)) {
    if (wanted.has(norm(k)) && v !== null && v !== '') return v;
  }
  return null;
}

function num(v: string | number | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = v.replace(/,/g, '').trim();
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function text(v: string | number | null): string {
  return v === null ? '' : String(v).trim();
}

/**
 * PURE. Map header-keyed BHB Daily-Trading-Summary rows -> NormalizedOhlcv[].
 * tradeDate is passed in (the bulletin is for a single trade date, supplied by the EOD sweep handler
 * from EodSweepPayload.tradeDate) so the parse stays a pure function of (snapshot rows, tradeDate).
 */
export function mapBulletinRows(rows: SheetRow[], tradeDate: string): NormalizedOhlcv[] {
  const out: NormalizedOhlcv[] = [];
  for (const r of rows) {
    const ticker = text(cell(r, ['Symbol', 'Code', 'Ticker', 'SymbolCode', 'ISIN']));
    if (ticker === '') continue;

    const close = num(cell(r, ['Close', 'ClosingPrice', 'ClosePrice', 'LastPrice', 'Price']));
    if (close === null) continue; // close is NOT NULL in ohlcv_daily; skip non-traded rows

    const row: NormalizedOhlcv = {
      venue: 'BHB',
      ticker,
      tradeDate,
      close,
      open: num(cell(r, ['Open', 'OpenPrice', 'OpeningPrice'])),
      high: num(cell(r, ['High', 'HighPrice', 'DayHigh'])),
      low: num(cell(r, ['Low', 'LowPrice', 'DayLow'])),
      volume: num(cell(r, ['Volume', 'TradedVolume', 'Quantity', 'SharesTraded', 'Shares'])),
      valueTraded: num(cell(r, ['Value', 'TradedValue', 'Turnover', 'ValueBD', 'ValueTraded'])),
    };
    out.push(row);
  }
  return out;
}

/**
 * Decode the XLSX bytes into header-keyed rows. Kept isolated so mapBulletinRows stays pure and
 * lib-free. Uses SheetJS lazily (dynamic import) so the binary lib stays out of the pure parse path;
 * `xlsx` is a declared dependency and resolves after `npm install`. A load failure surfaces as zero
 * rows (PARSE_DRIFT) rather than a crash, and the golden test never touches it.
 */
async function decodeWorkbook(body: Buffer): Promise<SheetRow[]> {
  let xlsx: typeof import('xlsx');
  try {
    // Lazy import to keep the binary lib off the pure parse path; `xlsx` is a declared dependency.
    xlsx = (await import('xlsx')) as unknown as typeof import('xlsx');
  } catch {
    return [];
  }
  const wb = xlsx.read(body, { type: 'buffer' });
  const first = wb.SheetNames[0];
  if (first === undefined) return [];
  const sheet = wb.Sheets[first];
  if (sheet === undefined) return [];
  const json = xlsx.utils.sheet_to_json(sheet, { defval: null, raw: true }) as unknown[];
  return json.filter(isObj) as SheetRow[];
}

async function fetchEod(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const res = await ctx.http.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType:
        res.headers['content-type'] ??
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'BHB', dataType: 'eod_bulletin', lang: 'en' },
    },
  ];
}

/**
 * PURE parser entrypoint. Because the XLSX decode is async (lazy lib import) but TaskSpec.parse is
 * synchronous, parse() decodes any pre-materialized rows placed on snapshot.meta.sheetRows by the
 * handler's decode step; if absent, it returns zero rows and the handler is expected to have run
 * decodeWorkbook() first. This preserves the frozen synchronous parse() signature while keeping the
 * binary decode out of the pure path. tradeDate comes from snapshot.meta.tradeDate.
 */
function parseEod(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const tradeDate =
    typeof snapshot.meta['tradeDate'] === 'string'
      ? (snapshot.meta['tradeDate'] as string)
      : snapshot.fetchedAt.slice(0, 10);
  const pre = snapshot.meta['sheetRows'];
  const rows = Array.isArray(pre) ? (pre.filter(isObj) as SheetRow[]) : [];
  return { rows: mapBulletinRows(rows, tradeDate), parserVersion: BHB_EOD_PARSER_VERSION };
}

export const bhbEodBulletin: TaskSpec<NormalizedOhlcv> = {
  dataType: 'eod_bulletin',
  parserVersion: BHB_EOD_PARSER_VERSION,
  fetch: fetchEod,
  parse: parseEod,
};

// Exposed for the worker handler to run the binary decode before parse(), and for future replay.
export { decodeWorkbook };
