// ingestion/src/adapters/tdwl/filings.ts
//
// TDWL issuer-news / announcements — the T+9-min filings path.
//
//   filingsList  → NormalizedFilingRef[]  (paginated JSON list; list-diff on external_id like
//                  "CG-1-2026-4471" → ingest.seen_items; new items enqueue filing_detail @ prio 1)
//   filingDetail → NormalizedFiling       (per-announcement detail + attached EN PDF snapshot)
//
// Transport: http_bootstrap (Playwright request-context) — same Akamai WAF as TDWL quotes, so the
// list/detail JSON is fetched through the browser context. The PDF is fetched the same way and its
// raw bytes are snapshotted (filing_detail is snapshot-first: the PDF blob → Storage 'lake-raw' via
// SnapshotStore, and the writer moves the extracted EN text into public.filings.pdf_en_path).
//
// parse() is PURE: JSON bytes → typed rows. PDF text extraction (poppler pdftotext) is NOT done in
// parse() — it is a writer/lake step; parse() only records the pdfUrl / provenance. Golden-tested
// against a hand-built list fixture (real golden captured on the VPS Playwright run).

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

const VENUE: VenueCode = "TDWL";

export const TDWL_FILINGS_LIST_PARSER_VERSION = 1;
export const TDWL_FILING_DETAIL_PARSER_VERSION = 1;

// ---------------------------------------------------------------------------
// List response shape. Field names follow the issuer-news JSON list; unknown-but-present rows are
// tolerated (extra keys ignored). The portal wraps items under `data` (mirrors the quotes board).
// ---------------------------------------------------------------------------

interface TdwlAnnouncementRow {
  announcementId?: string | number | null; // → externalId / sourceRef, e.g. "CG-1-2026-4471"
  newsId?: string | number | null; // alt id field seen on some portal builds
  title?: string | null;
  titleEn?: string | null;
  companySymbol?: string | null; // acrynomName / symbol when the notice is issuer-specific
  companyRef?: string | number | null;
  category?: string | null; // portal category label → mapped to filingType heuristically
  categoryCode?: string | null;
  publishDate?: string | null; // AST wall-clock "MMM D, YYYY h:mm:ss AM/PM"
  disclosureDate?: string | null;
  detailUrl?: string | null;
  pdfUrl?: string | null;
  attachmentUrl?: string | null;
}

interface TdwlListResponse {
  data?: TdwlAnnouncementRow[] | null;
  totalCount?: number | null;
}

// Reuse the TDWL AST timestamp parser + browser option builder (shared, pure).
import { parseTdwlTimestampToUtc, browserOpts } from "./quotes.js";

function firstNonEmpty(...vals: Array<string | number | null | undefined>): string | null {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== "") return s;
  }
  return null;
}

/**
 * Heuristic category → filing taxonomy. TDWL category labels vary; the lake refines this from the
 * PDF, but the list parser tags a best-effort filingType so downstream routing/priority works.
 * Exact enum per CONTRACT §6.4 NormalizedFiling.filingType.
 */
export function classifyTdwlCategory(
  category: string | null,
): NormalizedFiling["filingType"] {
  const c = (category ?? "").toLowerCase();
  if (/(dividend|distribution|profit)/.test(c)) return "DIVIDEND";
  if (/(interim|annual|financial|results|earnings|statement)/.test(c)) return "RESULTS";
  if (/(rating|credit)/.test(c)) return "RATING";
  if (/(board|governance|agm|egm|assembly|resolution)/.test(c)) return "GOVERNANCE";
  if (/(capital|capex|expansion|invest|acquisition|project)/.test(c)) return "CAPEX";
  if (/(contract|award|tender|agreement|mou)/.test(c)) return "CONTRACT";
  if (/(prospectus|ipo|offering|subscription)/.test(c)) return "PROSPECTUS";
  if (/(operation|production|update)/.test(c)) return "OPS";
  return "OTHER";
}

/**
 * Pure parser for the issuer-news list. Emits one NormalizedFilingRef per announcement with a
 * stable externalId (the announcement id). detailUrl/pdfUrl provenance is carried through so the
 * worker can enqueue filing_detail @ priority 1 (event-driven, CONTRACT §8). Rows without an
 * externalId are dropped (cannot diff/dedup them).
 */
export function parseTdwlFilingsList(
  snapshot: StoredSnapshot,
): ParseResult<NormalizedFilingRef> {
  const text = snapshot.body.toString("utf8");
  let doc: TdwlListResponse;
  try {
    doc = JSON.parse(text) as TdwlListResponse;
  } catch (err) {
    throw new Error(
      `TDWL filings_list parse: snapshot ${snapshot.snapshotId} not valid JSON: ${(err as Error).message}`,
    );
  }
  if (doc === null || typeof doc !== "object" || !Array.isArray(doc.data)) {
    throw new Error(
      `TDWL filings_list parse: snapshot ${snapshot.snapshotId} missing top-level {data:[...]}`,
    );
  }

  const rows: NormalizedFilingRef[] = [];
  for (const raw of doc.data) {
    if (raw === null || typeof raw !== "object") continue;
    const externalId = firstNonEmpty(raw.announcementId, raw.newsId);
    if (externalId === null) continue; // no stable id → cannot list-diff

    const title = firstNonEmpty(raw.titleEn, raw.title) ?? externalId;
    const filedAt =
      parseTdwlTimestampToUtc(raw.publishDate ?? raw.disclosureDate ?? null) ?? "";
    const detailUrl = firstNonEmpty(raw.detailUrl) ?? "";
    const pdfUrl = firstNonEmpty(raw.pdfUrl, raw.attachmentUrl);

    const ref: NormalizedFilingRef = {
      venue: VENUE,
      externalId,
      sourceRef: externalId, // TDWL uses the announcement id as the human source ref
      title,
      filedAt,
      detailUrl,
    };
    const formCode = firstNonEmpty(raw.categoryCode);
    if (formCode !== null) ref.formCode = formCode;
    if (pdfUrl !== null) ref.pdfUrl = pdfUrl;
    rows.push(ref);
  }
  return { rows, parserVersion: TDWL_FILINGS_LIST_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// filing_detail. The snapshot for a detail job is the PDF bytes (responseKind 'pdf') when a PDF is
// attached, else the detail JSON. parse() records the filing metadata + provenance; it does NOT
// extract PDF text (that is the lake extraction step). meta carries the list-derived fields the
// fetcher passed through (externalId, sourceRef, title, category, pdfUrl, filedAt).
// ---------------------------------------------------------------------------

export function parseTdwlFilingDetail(
  snapshot: StoredSnapshot,
): ParseResult<NormalizedFiling> {
  const meta = snapshot.meta ?? {};
  const externalId =
    snapshot.externalId ??
    (typeof meta.externalId === "string" ? meta.externalId : null);
  if (externalId === null || externalId === "") {
    throw new Error(
      `TDWL filing_detail parse: snapshot ${snapshot.snapshotId} has no externalId (list handoff meta missing)`,
    );
  }
  const sourceRef =
    (typeof meta.sourceRef === "string" && meta.sourceRef) || externalId;
  const title = (typeof meta.title === "string" && meta.title) || externalId;
  const category = typeof meta.category === "string" ? meta.category : null;
  const filedAt = typeof meta.filedAt === "string" ? meta.filedAt : "";
  const securityTicker =
    typeof meta.companySymbol === "string" && meta.companySymbol.trim() !== ""
      ? meta.companySymbol.trim()
      : null;

  const isPdf = snapshot.contentType.toLowerCase().includes("pdf");
  const filing: NormalizedFiling = {
    venue: VENUE,
    externalId,
    sourceRef,
    securityTicker,
    filingType: classifyTdwlCategory(category),
    title,
    filedAt,
  };
  if (typeof meta.formCode === "string") filing.formCode = meta.formCode;
  // The stored PDF's Storage key is set by SnapshotStore.put() and passed back to the writer; the
  // parser records only that a PDF snapshot exists. fullTextEn/extractedFacts are lake outputs.
  if (isPdf && typeof meta.pdfStoragePath === "string") {
    filing.pdfStoragePath = meta.pdfStoragePath;
  }

  return { rows: [filing], parserVersion: TDWL_FILING_DETAIL_PARSER_VERSION };
}

// ---------------------------------------------------------------------------
// fetch() impls. list = single paginated JSON board through the browser context. detail = fetch
// the announcement's PDF (or detail JSON) through the browser context, carrying the list row's
// fields forward as meta so the pure detail parser has its natural key + title without re-fetching
// the list. Pagination + URL template come from source.endpointConfig — never hardcoded.
// ---------------------------------------------------------------------------

async function fetchTdwlFilingsList(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, logger, now } = ctx;
  const discovery = source.endpointConfig.actionDiscovery;
  if (!discovery) {
    throw new Error(
      `TDWL filings_list fetch: source ${source.id} missing endpoint_config.actionDiscovery`,
    );
  }
  const boot = await browser.bootstrap(discovery);
  const results: FetchResult[] = [];

  const pag = source.endpointConfig.pagination;
  const pages = pag ? [pag.start] : [0]; // first page only per poll; deeper pages on backfill runs
  for (const page of pages) {
    const url = boot.resolvedUrl.replace(/\{page\}/g, String(page));
    // BrowserClient.get owns the WAF-challenge retry + typed FetchError on persistent failure.
    const resp = await browser.get(url, browserOpts(source.endpointConfig.headers));
    results.push({
      url: resp.url,
      contentType: resp.headers["content-type"] ?? "text/html",
      httpStatus: resp.status,
      body: resp.body,
      fetchedAt: now(),
      meta: { lang: "en", page },
    });
  }
  logger.info("TDWL filings_list fetched", { sourceId: source.id, pages: results.length });
  return results;
}

/**
 * filing_detail fetch. The worker enqueues this with the list row's fields in the job payload; the
 * FetchContext carries them via source.endpointConfig.headers-free meta. Here we resolve the
 * announcement PDF URL from the source config's urlTemplate ({externalId} placeholder) and fetch
 * the PDF bytes through the browser context. The list-derived fields ride along on FetchResult.meta
 * so the pure parser has the natural key + title without any list re-fetch.
 */
async function fetchTdwlFilingDetail(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, browser, now } = ctx;
  const tmpl = source.endpointConfig.urlTemplate;
  const detailMeta =
    (source.endpointConfig as unknown as { detail?: Record<string, unknown> }).detail ?? {};
  const externalId =
    typeof detailMeta.externalId === "string" ? detailMeta.externalId : "";
  if (!tmpl) {
    throw new Error(
      `TDWL filing_detail fetch: source ${source.id} missing endpoint_config.urlTemplate`,
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

export const tdwlFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: "filings_list",
  parserVersion: TDWL_FILINGS_LIST_PARSER_VERSION,
  fetch: fetchTdwlFilingsList,
  parse: parseTdwlFilingsList,
};

export const tdwlFilingDetail: TaskSpec<NormalizedFiling> = {
  dataType: "filing_detail",
  parserVersion: TDWL_FILING_DETAIL_PARSER_VERSION,
  fetch: fetchTdwlFilingDetail,
  parse: parseTdwlFilingDetail,
};
