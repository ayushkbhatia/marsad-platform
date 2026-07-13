// QE (Qatar Stock Exchange) — filings_list TaskSpec.
//
// STATUS: PARTIALLY PINNED. The market-wide disclosures page of record is
//   https://www.qe.com.qa/q-disclosure
// a Liferay React/Clay portlet that renders its list client-side from a portlet RESOURCE XHR whose
// exact URL was NOT captured in recon (it did not fire within the headless capture window). The QE
// origin also BLOCKS plain curl/undici from the VPS (TLS stall) while a real headless Chromium loads
// fine — so QE filings MUST run http_bootstrap (Playwright), and the resource URL is discovered at
// runtime via endpoint_config.actionDiscovery (network_capture). ONE more VPS headless capture is
// required to pin the feed URL and add a golden fixture; until then QE filings ingestion is
// best-effort and will emit zero rows (→ PARSE_DRIFT / Desk item) rather than garbage.
//
// This parser is written to survive BOTH plausible shapes the pinned feed may take:
//   (1) a Liferay portlet JSON resource (rows under a data/items/disclosures array), and
//   (2) a server-rendered HTML anchor list (detail link carrying an id query param + title),
// selected by sniffing the snapshot bytes. Field access for the JSON shape is config-driven via an
// optional endpoint_config.filingFieldMap copied onto snapshot.meta by the worker, so a QE field
// rename is a data fix, not a code change.

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const QE_FILINGS_PARSER_VERSION = 2;

const QE_ORIGIN = 'https://www.qe.com.qa';

export interface QeFilingFieldMap {
  rowsPath?: string;       // dotted path to the row array (default: sniffed common keys)
  externalId?: string;     // id field (default: sniffed common keys)
  title?: string;
  filedAt?: string;
  detailUrl?: string;
  pdfUrl?: string;
  symbol?: string;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}
function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
function pick(row: Json, path: string | undefined, fallbacks: string[]): unknown {
  if (path) {
    const v = getPath(row, path);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  for (const k of fallbacks) {
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function normalizeIso(s: string, fallback: string): string {
  if (s === '') return fallback;
  const epoch = /\/Date\((\d+)\)\/|^(\d{12,13})$/.exec(s);
  if (epoch) {
    const ms = Number(epoch[1] ?? epoch[2]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

function absoluteUrl(u: string): string {
  if (u === '') return '';
  if (/^https?:\/\//i.test(u)) return u;
  return `${QE_ORIGIN}${u.startsWith('/') ? '' : '/'}${u}`;
}

function locateRows(payload: unknown, rowsPath: string | undefined): Json[] {
  if (rowsPath) {
    const v = getPath(payload, rowsPath);
    if (Array.isArray(v)) return v.filter(isObj);
  }
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    for (const key of ['data', 'Data', 'items', 'Items', 'disclosures', 'Disclosures', 'result', 'Result', 'rows', 'Rows', 'list', 'List']) {
      const v = payload[key];
      if (Array.isArray(v)) return v.filter(isObj);
      if (isObj(v)) {
        for (const k2 of ['items', 'Items', 'disclosures', 'Disclosures', 'rows', 'Rows', 'list', 'List']) {
          const v2 = (v as Json)[k2];
          if (Array.isArray(v2)) return v2.filter(isObj);
        }
      }
    }
  }
  return [];
}

function parseJsonShape(payload: unknown, snapshot: StoredSnapshot, fm: QeFilingFieldMap): NormalizedFilingRef[] {
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();
  for (const r of locateRows(payload, fm.rowsPath)) {
    const rawId = str(pick(r, fm.externalId, ['id', 'Id', 'disclosureId', 'DisclosureId', 'newsId', 'NewsId', 'announcementId', 'AnnouncementId', 'refNo', 'RefNo']));
    if (rawId === '') continue;
    const externalId = `QE-${rawId}`;
    if (seen.has(externalId)) continue;

    const title = str(pick(r, fm.title, ['title', 'Title', 'titleEn', 'TitleEn', 'headline', 'Headline', 'subject', 'Subject']));
    if (title === '') continue;

    const filedRaw = str(pick(r, fm.filedAt, ['date', 'Date', 'publishDate', 'PublishDate', 'disclosureDate', 'DisclosureDate', 'createdDate', 'newsDate', 'NewsDate']));
    const filedAt = normalizeIso(filedRaw, snapshot.fetchedAt);

    const detail = absoluteUrl(str(pick(r, fm.detailUrl, ['detailUrl', 'DetailUrl', 'url', 'Url', 'link', 'Link'])));
    const pdf = absoluteUrl(str(pick(r, fm.pdfUrl, ['pdfUrl', 'PdfUrl', 'attachmentUrl', 'AttachmentUrl', 'fileUrl', 'FileUrl', 'documentUrl', 'DocumentUrl'])));

    const ref: NormalizedFilingRef = {
      venue: 'QE',
      externalId,
      sourceRef: externalId,
      title,
      filedAt,
      detailUrl: detail !== '' ? detail : pdf,
    };
    if (pdf !== '') ref.pdfUrl = pdf;
    seen.add(externalId);
    rows.push(ref);
  }
  return rows;
}

function parseHtmlShape(html: string, snapshot: StoredSnapshot): NormalizedFilingRef[] {
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();
  const anchorRe =
    /<a\b[^>]*href="([^"]*\b(?:id|newsid|announcementid|disclosureid|itemid)=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const idNum = m[2];
    const inner = m[3];
    if (href === undefined || idNum === undefined || inner === undefined) continue;

    const externalId = `QE-${idNum}`;
    if (seen.has(externalId)) continue;

    const title = stripTags(inner);
    if (title === '') continue;

    seen.add(externalId);
    rows.push({
      venue: 'QE',
      externalId,
      sourceRef: externalId,
      title,
      filedAt: snapshot.fetchedAt,
      detailUrl: absoluteUrl(decodeEntities(href)),
    });
  }
  return rows;
}

async function fetchFilings(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, http, browser, now } = ctx;
  const cfg = source.endpointConfig;
  // QE origin TLS-stalls plain undici from the VPS → prefer the browser client for http_bootstrap.
  const useBrowser = source.transport === 'http_bootstrap' || source.transport === 'headless';
  let url = cfg.urlTemplate ?? source.entryUrl;
  if (useBrowser && cfg.actionDiscovery) {
    const boot = await browser.bootstrap(cfg.actionDiscovery);
    // Prefer a pinned urlTemplate; else use the runtime-captured resource URL.
    if (!cfg.urlTemplate) url = boot.resolvedUrl;
  }
  const client = useBrowser ? browser : http;
  const res = await client.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  const fieldMap =
    (cfg as unknown as { filingFieldMap?: QeFilingFieldMap }).filingFieldMap ?? {};
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'text/html',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: now(),
      meta: { venue: 'QE', dataType: 'filings_list', lang: 'en', filingFieldMap: fieldMap },
    },
  ];
}

/**
 * PURE parser. Sniffs JSON vs HTML and dispatches to the matching extractor. An unrecognized layout
 * yields zero rows (→ PARSE_DRIFT on a changed snapshot), the correct "feed not yet pinned / site
 * redesigned" signal rather than emitting garbage external_ids into seen_items.
 */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const body = snapshot.body.toString('utf8');
  const trimmed = body.replace(/^﻿/, '').trimStart();
  const fm = (snapshot.meta['filingFieldMap'] as QeFilingFieldMap | undefined) ?? {};

  let rows: NormalizedFilingRef[] = [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      rows = parseJsonShape(JSON.parse(trimmed), snapshot, fm);
    } catch {
      rows = [];
    }
  }
  if (rows.length === 0) {
    rows = parseHtmlShape(body, snapshot);
  }
  return { rows, parserVersion: QE_FILINGS_PARSER_VERSION };
}

export const qeFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: QE_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
