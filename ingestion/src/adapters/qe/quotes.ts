// QE (Qatar Stock Exchange) — quotes TaskSpec.
//
// fetch  = impure: the LIVE board is a POST to www.qe.com.qa/wp/mw_app/mw.php with a
//          form body (f=MarketWatch); endpoint/method/body come from ctx.source, never
//          hardcoded. (The legacy /pps/qse_files/MarketWatch.txt path is a STALE static
//          file — Last-Modified Oct 2025, byte-identical intraday — so it was repointed
//          to mw.php; migration 20260715085252. The fetch honors cfg.method for both.)
// parse  = PURE: bytes of a stored snapshot -> NormalizedQuote[]. No I/O, no Date.now(), replayable.
//
// Fixture: ingestion/fixtures/qe/marketwatch.txt (real, verbatim, 107 rows, HTTP 200).
// mw.php returns the SAME schema: { total,page,records, rows:[ {...} ] } (clean JSON despite a
// text/plain-ish content-type). Field map is per CONTRACT.md §6.1 (QE field map, verbatim).

import type {
  FetchContext,
  FetchResult,
  NormalizedQuote,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const QE_QUOTES_PARSER_VERSION = 1;

/** One row of the QE MarketWatch.txt board. All numeric fields arrive as strings. */
interface QeRow {
  Symbol?: string;
  CompanyEN?: string;
  LastPrice?: string;
  Change?: string;
  PercentChange?: string;
  OpenPrice?: string;
  High?: string;
  Low?: string;
  Volume?: string;
  PrevClosing?: string;
  W52High?: string;
  W52Low?: string;
  BidPrice?: string;
  OfferPrice?: string;
  Value?: string;
  CompType?: string;
  StateEN?: string;
}

interface QeBoard {
  rows?: QeRow[];
}

/**
 * Parse a plain QE number. Keeps genuine zeros AND genuine negatives (Change/PercentChange can be
 * legitimately -1.000), mapping only blank/missing/non-finite to null. Do NOT apply the missing-value
 * sentinel here — a Change of exactly -1.000 is a real move, not "no value".
 */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a QE *price-level* field (Last/Open/High/Low/W52High/W52Low/Bid/Offer). On these level
 * fields QE encodes "no value" as the string "-1.000" — the same sentinel it uses on ReferencePrice
 * for thinly-traded/non-priced securities. A price level of -1 is never real, so we map it to null;
 * genuine zeros are still kept via num(). NOT used on signed deltas (Change/PercentChange) or Volume,
 * where -1 can be a real value.
 *
 * FIRST-VPS-RUN CAVEAT: the captured fixture carries -1.000 only on ReferencePrice (unmapped), so no
 * MAPPED field exercises this branch in the golden test — confirm the sentinel convention against a
 * fuller live board before trusting week52-high/low or last on thinly-traded securities.
 */
function price(v: string | undefined): number | null {
  const n = num(v);
  if (n === null) return null;
  return n === -1 ? null : n; // QE "-1.000" missing-value sentinel on price-level fields
}

/**
 * Fetch the QE board. The URL/method/headers are config (ctx.source.endpointConfig); this adapter
 * only knows the *shape* (a single GET returning the whole board). meta records lang + provenance.
 */
async function fetchQuotes(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  // The live board (www.qe.com.qa/wp/mw_app/mw.php) is a POST with a form body
  // (f=MarketWatch); the legacy static MarketWatch.txt was a GET. Honor the
  // configured method so one adapter serves both. Slow origin (intermittently
  // >15s) → honor the source's timeout override (paired with the fetcher's 30s
  // connect ceiling) so the native board doesn't silently drop onto Yahoo.
  const opts = {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
    ...(cfg.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
  };
  const res =
    (cfg.method ?? 'GET') === 'POST'
      ? await ctx.http.request(url, { method: 'POST', body: cfg.body ?? '', ...opts })
      : await ctx.http.get(url, opts);
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'text/plain',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'QE', dataType: 'quotes', lang: 'en' },
    },
  ];
}

/**
 * PURE parser. asOf is derived deterministically from the stored snapshot's fetchedAt (the exchange
 * board carries no per-row timestamp; the delayed print time is the fetch time, and delay_minutes
 * is stamped by the writer, per §6.1). No Date.now() — replayable.
 */
function parseQuotes(snapshot: StoredSnapshot): ParseResult<NormalizedQuote> {
  let board: QeBoard;
  try {
    board = JSON.parse(snapshot.body.toString('utf8')) as QeBoard;
  } catch {
    // Malformed/HTML-error body on a CHANGED snapshot => zero rows => PARSE_DRIFT upstream.
    return { rows: [], parserVersion: QE_QUOTES_PARSER_VERSION };
  }

  const rawRows = Array.isArray(board.rows) ? board.rows : [];
  const asOf = snapshot.fetchedAt;
  const rows: NormalizedQuote[] = [];

  for (const r of rawRows) {
    const ticker = (r.Symbol ?? '').trim();
    if (ticker === '') continue; // skip header/spacer rows with no symbol

    const last = price(r.LastPrice);
    let change = num(r.Change);
    const prevClose = price(r.PrevClosing);
    // If Change is absent but we have last + prevClose, compute it (§6.1: PrevClosing→compute change).
    if (change === null && last !== null && prevClose !== null) {
      change = Number((last - prevClose).toFixed(6));
    }

    rows.push({
      venue: 'QE',
      ticker,
      last,
      change,
      changePct: num(r.PercentChange),
      open: price(r.OpenPrice),
      high: price(r.High),
      low: price(r.Low),
      volume: num(r.Volume),
      week52High: price(r.W52High),
      week52Low: price(r.W52Low),
      bid: price(r.BidPrice),
      ask: price(r.OfferPrice),
      asOf,
    });
  }

  return { rows, parserVersion: QE_QUOTES_PARSER_VERSION };
}

export const qeQuotes: TaskSpec<NormalizedQuote> = {
  dataType: 'quotes',
  parserVersion: QE_QUOTES_PARSER_VERSION,
  fetch: fetchQuotes,
  parse: parseQuotes,
};
