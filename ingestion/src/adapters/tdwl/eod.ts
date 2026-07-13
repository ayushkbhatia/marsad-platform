// ingestion/src/adapters/tdwl/eod.ts
//
// TDWL EOD market-report bulletin → NormalizedOhlcv[] (the ohlcv_daily source of record).
//
// Transport: http_bootstrap (Playwright request-context) — the market-reports archive sits behind
// the same Akamai WAF, so the XLSX is fetched through the browser context and snapshotted verbatim
// BEFORE parsing (snapshot-first). responseKind 'xlsx'.
//
// The exact workbook layout (sheet name, header row, column order) is UNKNOWN until the first VPS
// capture — TDWL is 403 to this build sandbox. So parseTdwlEod is written against a documented,
// config-driven column map (source.endpointConfig carries the sheet + header hints) and is
// defensive: it resolves columns by header label, not fixed index. The real golden
// (market-report.golden.xlsx) is captured on the VPS and this parser hardened against it then.
//
// XLSX decoding is done with the `xlsx` package (listed as an ingestion dep in the report). To keep
// this module free of a hard dependency until the golden lands, the workbook is decoded via a small
// injected reader passed on FetchResult.meta by the worker's xlsx harness; parse() stays PURE (it
// receives already-decoded rows in the snapshot meta OR decodes from bytes via the shared xlsx util
// re-exported by core/parsers). Here we decode from bytes using the shared util at call time.

import type {
  FetchContext,
  FetchResult,
  NormalizedOhlcv,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from "../../core/types.js";
import { browserOpts } from "./quotes.js";

const VENUE: VenueCode = "TDWL";
export const TDWL_EOD_PARSER_VERSION = 1;

/**
 * Column resolution hints, defaulted here and overridable from source.endpointConfig so a bulletin
 * layout change is a data fix. Header matching is case-insensitive substring on the decoded header
 * row. `tradeDateCell` names a single-cell date (bulletins put the trade date in a title cell, not
 * per-row) — resolved from meta.tradeDate (job payload) when the sheet omits it.
 */
interface TdwlEodColumnMap {
  symbol: string[];
  close: string[];
  open: string[];
  high: string[];
  low: string[];
  volume: string[];
  valueTraded: string[];
}

const DEFAULT_COLUMNS: TdwlEodColumnMap = {
  symbol: ["symbol", "code", "company"],
  close: ["close", "closing", "last"],
  open: ["open", "opening"],
  high: ["high"],
  low: ["low"],
  volume: ["volume", "traded volume", "qty"],
  valueTraded: ["value", "turnover", "value traded"],
};

/** A decoded worksheet row keyed by (normalized) header label. Produced by the xlsx harness. */
export type DecodedRow = Record<string, string | number | null>;

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveCol(row: DecodedRow, candidates: string[]): string | number | null {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const want = normHeader(cand);
    const hit = keys.find((k) => normHeader(k).includes(want));
    if (hit) return row[hit] ?? null;
  }
  return null;
}

function toNum(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure parser. Expects the xlsx harness to have decoded the workbook into rows on snapshot.meta
 * (`meta.decodedRows: DecodedRow[]`, `meta.tradeDate: 'YYYY-MM-DD'`) — keeping parse() free of the
 * binary xlsx dependency and fully replayable from a stored, decoded snapshot. If decodedRows is
 * absent the parser throws (harness contract violation), which the parse-harness records as error.
 */
export function parseTdwlEod(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const meta = snapshot.meta ?? {};
  const decoded = meta.decodedRows;
  const tradeDate = typeof meta.tradeDate === "string" ? meta.tradeDate : null;
  if (!Array.isArray(decoded)) {
    throw new Error(
      `TDWL eod parse: snapshot ${snapshot.snapshotId} has no meta.decodedRows (xlsx harness must decode workbook → rows before parse)`,
    );
  }
  if (tradeDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error(
      `TDWL eod parse: snapshot ${snapshot.snapshotId} missing meta.tradeDate (YYYY-MM-DD)`,
    );
  }

  const cols = { ...DEFAULT_COLUMNS, ...(meta.columnMap as Partial<TdwlEodColumnMap> | undefined) };
  const rows: NormalizedOhlcv[] = [];
  for (const raw of decoded as DecodedRow[]) {
    if (raw === null || typeof raw !== "object") continue;
    const symRaw = resolveCol(raw, cols.symbol);
    const ticker = symRaw === null ? "" : String(symRaw).trim();
    const close = toNum(resolveCol(raw, cols.close));
    if (ticker === "" || close === null) continue; // close is NOT NULL in ohlcv_daily
    rows.push({
      venue: VENUE,
      ticker,
      tradeDate,
      open: toNum(resolveCol(raw, cols.open)),
      high: toNum(resolveCol(raw, cols.high)),
      low: toNum(resolveCol(raw, cols.low)),
      close,
      volume: toNum(resolveCol(raw, cols.volume)),
      valueTraded: toNum(resolveCol(raw, cols.valueTraded)),
    });
  }
  return { rows, parserVersion: TDWL_EOD_PARSER_VERSION };
}

async function fetchTdwlEod(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, now } = ctx;
  const tmpl = source.endpointConfig.urlTemplate;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!tmpl && !discovery) {
    throw new Error(
      `TDWL eod fetch: source ${source.id} needs endpoint_config.urlTemplate or actionDiscovery`,
    );
  }
  let url: string;
  if (discovery) {
    const boot = await browser.bootstrap(discovery);
    url = boot.resolvedUrl;
  } else {
    url = tmpl!.replace(/\{epochMs\}/g, String(Date.parse(now()) || 0));
  }
  const resp = await browser.get(url, browserOpts(source.endpointConfig.headers, 30_000));
  return [
    {
      url: resp.url,
      contentType:
        resp.headers["content-type"] ??
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", responseKind: "xlsx" },
    },
  ];
}

export const tdwlEodBulletin: TaskSpec<NormalizedOhlcv> = {
  dataType: "eod_bulletin",
  parserVersion: TDWL_EOD_PARSER_VERSION,
  fetch: fetchTdwlEod,
  parse: parseTdwlEod,
};
