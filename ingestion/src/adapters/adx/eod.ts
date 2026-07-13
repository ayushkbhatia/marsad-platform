// ingestion/src/adapters/adx/eod.ts
//
// ADX daily trading report → NormalizedOhlcv[] (the ohlcv_daily source of record for ADX).
//
// Transport: http_bootstrap. Report layout unknown until first VPS capture, so — like TDWL EOD —
// the parser is header-driven and expects the xlsx harness to decode the workbook into
// snapshot.meta.decodedRows before the pure parse() runs. Column labels are resolved by
// case-insensitive substring against configurable candidates (endpointConfig.columnMap override).

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

const VENUE: VenueCode = "ADX";
export const ADX_EOD_PARSER_VERSION = 1;

export type DecodedRow = Record<string, string | number | null>;

interface AdxEodColumnMap {
  symbol: string[];
  close: string[];
  open: string[];
  high: string[];
  low: string[];
  volume: string[];
  valueTraded: string[];
}

const DEFAULT_COLUMNS: AdxEodColumnMap = {
  symbol: ["symbol", "code", "security", "company"],
  close: ["close", "closing", "last"],
  open: ["open", "opening"],
  high: ["high"],
  low: ["low"],
  volume: ["volume", "traded volume", "shares"],
  valueTraded: ["value", "turnover", "value traded"],
};

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

export function parseAdxEod(snapshot: StoredSnapshot): ParseResult<NormalizedOhlcv> {
  const meta = snapshot.meta ?? {};
  const decoded = meta.decodedRows;
  const tradeDate = typeof meta.tradeDate === "string" ? meta.tradeDate : null;
  if (!Array.isArray(decoded)) {
    throw new Error(
      `ADX eod parse: snapshot ${snapshot.snapshotId} has no meta.decodedRows (xlsx harness must decode before parse)`,
    );
  }
  if (tradeDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error(`ADX eod parse: snapshot ${snapshot.snapshotId} missing meta.tradeDate (YYYY-MM-DD)`);
  }
  const cols = { ...DEFAULT_COLUMNS, ...(meta.columnMap as Partial<AdxEodColumnMap> | undefined) };
  const rows: NormalizedOhlcv[] = [];
  for (const raw of decoded as DecodedRow[]) {
    if (raw === null || typeof raw !== "object") continue;
    const symRaw = resolveCol(raw, cols.symbol);
    const ticker = symRaw === null ? "" : String(symRaw).trim();
    const close = toNum(resolveCol(raw, cols.close));
    if (ticker === "" || close === null) continue;
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
  return { rows, parserVersion: ADX_EOD_PARSER_VERSION };
}

async function fetchAdxEod(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, now } = ctx;
  const tmpl = source.endpointConfig.urlTemplate;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!tmpl && !discovery) {
    throw new Error(`ADX eod fetch: source ${source.id} needs urlTemplate or actionDiscovery`);
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

export const adxEodBulletin: TaskSpec<NormalizedOhlcv> = {
  dataType: "eod_bulletin",
  parserVersion: ADX_EOD_PARSER_VERSION,
  fetch: fetchAdxEod,
  parse: parseAdxEod,
};
