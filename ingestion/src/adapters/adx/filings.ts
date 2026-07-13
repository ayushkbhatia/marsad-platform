// ingestion/src/adapters/adx/filings.ts
//
// ADX news & disclosures → NormalizedFilingRef[] (list) + NormalizedFiling (detail).
//
// Transport: http_bootstrap (Playwright request-context) — same WAF as ADX quotes.
//
// ENDPOINT + SHAPE DISCOVERY — TODO resolved on first VPS run. Like ADX quotes, the disclosures JSON
// path and field names are unknown until a real browser session observes them. So the list parser is
// config-driven via endpointConfig.filingFieldMap (copied onto snapshot.meta.filingFieldMap by the
// worker). This keeps parse() pure and makes an ADX field rename a data fix.
//
// The detail parser mirrors TDWL's: the snapshot is the PDF (or detail JSON); parse() records
// metadata + provenance from the list-handoff meta and does NOT extract PDF text (a lake step).

import type {
  FetchContext,
  FetchResult,
  NormalizedFiling,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
  VenueCode,
} from "../../core/types.js";
import { getPath, browserOpts } from "./quotes.js";

const VENUE: VenueCode = "ADX";
export const ADX_FILINGS_LIST_PARSER_VERSION = 1;
export const ADX_FILING_DETAIL_PARSER_VERSION = 1;

export interface AdxFilingFieldMap {
  rowsPath?: string; // default "data"
  externalId: string; // required — the announcement/disclosure id
  title?: string;
  filedAt?: string;
  filedAtKind?: "iso" | "epoch_ms" | "epoch_s";
  detailUrl?: string;
  pdfUrl?: string;
  symbol?: string; // issuer symbol when the notice is company-specific
  category?: string;
  formCode?: string;
}

const DEFAULT_FILING_MAP: AdxFilingFieldMap = {
  rowsPath: "data",
  externalId: "id",
  title: "title",
  filedAt: "date",
  filedAtKind: "iso",
  detailUrl: "detailUrl",
  pdfUrl: "attachmentUrl",
  symbol: "symbol",
  category: "category",
};

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function asOfToUtc(v: unknown, kind: AdxFilingFieldMap["filedAtKind"]): string {
  if (v === null || v === undefined) return "";
  if (kind === "epoch_ms" || kind === "epoch_s") {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return "";
    const ms = kind === "epoch_s" ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const s = String(v).trim();
  if (s === "") return "";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

export function classifyAdxCategory(category: string | null): NormalizedFiling["filingType"] {
  const c = (category ?? "").toLowerCase();
  if (/(dividend|distribution|profit)/.test(c)) return "DIVIDEND";
  if (/(interim|annual|financial|results|earnings|statement)/.test(c)) return "RESULTS";
  if (/(rating|credit)/.test(c)) return "RATING";
  if (/(board|governance|agm|egm|assembly|resolution)/.test(c)) return "GOVERNANCE";
  if (/(capital|capex|expansion|invest|acquisition|project)/.test(c)) return "CAPEX";
  if (/(contract|award|tender|agreement|mou)/.test(c)) return "CONTRACT";
  if (/(prospectus|ipo|offering|subscription|listing)/.test(c)) return "PROSPECTUS";
  if (/(operation|production|update)/.test(c)) return "OPS";
  return "OTHER";
}

export function parseAdxFilingsList(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const text = snapshot.body.toString("utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `ADX filings_list parse: snapshot ${snapshot.snapshotId} not valid JSON: ${(err as Error).message}`,
    );
  }
  const metaMap = (snapshot.meta?.filingFieldMap as Partial<AdxFilingFieldMap> | undefined) ?? {};
  const fm: AdxFilingFieldMap = { ...DEFAULT_FILING_MAP, ...metaMap };

  const rowsRaw = getPath(doc, fm.rowsPath ?? "data");
  if (!Array.isArray(rowsRaw)) {
    throw new Error(
      `ADX filings_list parse: snapshot ${snapshot.snapshotId} has no rows array at '${fm.rowsPath ?? "data"}'`,
    );
  }
  const rows: NormalizedFilingRef[] = [];
  for (const raw of rowsRaw) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const externalId = asStr(getPath(row, fm.externalId));
    if (externalId === null) continue;
    const ref: NormalizedFilingRef = {
      venue: VENUE,
      externalId,
      sourceRef: externalId,
      title: asStr(getPath(row, fm.title ?? "")) ?? externalId,
      filedAt: asOfToUtc(getPath(row, fm.filedAt ?? ""), fm.filedAtKind ?? "iso"),
      detailUrl: asStr(getPath(row, fm.detailUrl ?? "")) ?? "",
    };
    const pdfUrl = asStr(getPath(row, fm.pdfUrl ?? ""));
    if (pdfUrl !== null) ref.pdfUrl = pdfUrl;
    const formCode = asStr(getPath(row, fm.formCode ?? ""));
    if (formCode !== null) ref.formCode = formCode;
    rows.push(ref);
  }
  return { rows, parserVersion: ADX_FILINGS_LIST_PARSER_VERSION };
}

export function parseAdxFilingDetail(snapshot: StoredSnapshot): ParseResult<NormalizedFiling> {
  const meta = snapshot.meta ?? {};
  const externalId =
    snapshot.externalId ?? (typeof meta.externalId === "string" ? meta.externalId : null);
  if (externalId === null || externalId === "") {
    throw new Error(
      `ADX filing_detail parse: snapshot ${snapshot.snapshotId} has no externalId (list handoff meta missing)`,
    );
  }
  const sourceRef = (typeof meta.sourceRef === "string" && meta.sourceRef) || externalId;
  const title = (typeof meta.title === "string" && meta.title) || externalId;
  const category = typeof meta.category === "string" ? meta.category : null;
  const filedAt = typeof meta.filedAt === "string" ? meta.filedAt : "";
  const securityTicker =
    typeof meta.symbol === "string" && meta.symbol.trim() !== "" ? meta.symbol.trim() : null;
  const isPdf = snapshot.contentType.toLowerCase().includes("pdf");

  const filing: NormalizedFiling = {
    venue: VENUE,
    externalId,
    sourceRef,
    securityTicker,
    filingType: classifyAdxCategory(category),
    title,
    filedAt,
  };
  if (typeof meta.formCode === "string") filing.formCode = meta.formCode;
  if (isPdf && typeof meta.pdfStoragePath === "string") filing.pdfStoragePath = meta.pdfStoragePath;

  return { rows: [filing], parserVersion: ADX_FILING_DETAIL_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// fetch() impls (browser context; discovery + fieldMap from source config).
// ---------------------------------------------------------------------------

async function fetchAdxFilingsList(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, now } = ctx;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!discovery) {
    throw new Error(
      `ADX filings_list fetch: source ${source.id} missing endpoint_config.actionDiscovery`,
    );
  }
  const boot = await browser.bootstrap(discovery);
  const resp = await browser.get(boot.resolvedUrl, browserOpts(source.endpointConfig.headers));
  const filingFieldMap =
    (source.endpointConfig as unknown as { filingFieldMap?: AdxFilingFieldMap }).filingFieldMap ??
    DEFAULT_FILING_MAP;
  return [
    {
      url: resp.url,
      contentType: resp.headers["content-type"] ?? "application/json",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", filingFieldMap },
    },
  ];
}

async function fetchAdxFilingDetail(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, now } = ctx;
  const tmpl = source.endpointConfig.urlTemplate;
  const detailMeta =
    (source.endpointConfig as unknown as { detail?: Record<string, unknown> }).detail ?? {};
  const externalId = typeof detailMeta.externalId === "string" ? detailMeta.externalId : "";
  if (!tmpl) {
    throw new Error(
      `ADX filing_detail fetch: source ${source.id} missing endpoint_config.urlTemplate`,
    );
  }
  // NOTE: filing_detail is event-driven — potentially many per poll. We deliberately do NOT
  // bootstrap() per announcement: the persistent request-context is seated ONCE (by the preceding
  // filings_list poll in the same worker session) and reused. If this detail fetch hits a cold or
  // WAF-challenged context, BrowserClient.get() self-seats via its built-in one-free-retry
  // re-bootstrap (core/browser.ts refreshIfChallenged, CONTRACT §10 WAF_CHALLENGE) — so a page
  // navigation only happens when actually challenged, not once per item. This keeps the
  // ≤300 req/day/host + headless-Chromium budget from being inflated by high announcement volume.
  const url = tmpl
    .replace(/\{externalId\}/g, encodeURIComponent(externalId))
    .replace(/\{epochMs\}/g, String(Date.parse(now()) || 0));
  const resp = await browser.get(url, browserOpts(source.endpointConfig.headers, 30_000));
  const result: FetchResult = {
    url: resp.url,
    contentType: resp.headers["content-type"] ?? "application/pdf",
    httpStatus: resp.status,
    body: resp.body,
    fetchedAt: now(),
    meta: { lang: "en", ...detailMeta },
  };
  if (externalId) result.externalId = externalId;
  return [result];
}

export const adxFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: "filings_list",
  parserVersion: ADX_FILINGS_LIST_PARSER_VERSION,
  fetch: fetchAdxFilingsList,
  parse: parseAdxFilingsList,
};

export const adxFilingDetail: TaskSpec<NormalizedFiling> = {
  dataType: "filing_detail",
  parserVersion: ADX_FILING_DETAIL_PARSER_VERSION,
  fetch: fetchAdxFilingDetail,
  parse: parseAdxFilingDetail,
};
