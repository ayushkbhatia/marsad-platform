// BHB (Bahrain Bourse) — filings_list TaskSpec.
//
// The company-announcements list of record is loaded from a JSON webapi:
//   GET https://webapi.bahrainbourse.com/api/data/GetAllAnnouncements?variationTitle=en&itemcount=30
//       &websiteID=bhb&cid=0&month=-1&year=<currentYear>&pagenum=1
//   → { status:1, data:{ totalRows, Announcements:[ { symbol, title, messageDate, linkUrl } ] } }
// where messageDate = 'Monday, July 13, 2026 01:09 PM' and linkUrl carries the stable per-filing
// external id as an `itemid=<n>` query param (e.g. itemid=541). filedAt = messageDate, title=title,
// ticker=symbol.
//
// TRANSPORT (verified live): the BHB origin is IP-geofenced/Akamai-blocked from the plain VPS IP, and
// the webapi returns 200 only for the request the SharePoint page itself issues on load (referer /
// session seated by the page) — a bare re-fetch 401s. So BHB filings MUST run http_bootstrap +
// use_proxy=true (both already set on the source): navigate the COMPANYANNOUNCEMENTS page through the
// GCC proxy and capture the GetAllAnnouncements response via endpoint_config.actionDiscovery
// (network_capture). The host is non-www bahrainbourse.com.
//
// Golden fixture: ingestion/fixtures/bhb/filings-live.json (real GetAllAnnouncements, 30 rows).

import { createHash } from 'node:crypto';
import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const BHB_FILINGS_PARSER_VERSION = 2;

const BHB_ORIGIN = 'https://bahrainbourse.com';

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}
function pick(row: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}

/** Rows live under data.Announcements; alternates kept for safety. */
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    const data = payload['data'] ?? payload['Data'] ?? payload;
    const container = isObj(data) ? data : payload;
    for (const key of ['Announcements', 'announcements', 'items', 'Items', 'rows', 'Rows', 'list', 'List', 'data', 'Data']) {
      const v = (container as Json)[key];
      if (Array.isArray(v)) return v.filter(isObj);
    }
  }
  return [];
}

/** Extract the stable itemid from a BHB linkUrl query string. */
function itemIdFromLink(link: string): string | null {
  const m = /[?&]itemid=(\d+)/i.exec(link);
  return m && m[1] !== undefined ? m[1] : null;
}

function absoluteUrl(u: string): string {
  if (u === '') return '';
  if (/^https?:\/\//i.test(u)) return u;
  // linkUrl paths contain spaces ('/en/News and Events/…'); encode them.
  const encoded = u.replace(/ /g, '%20');
  return `${BHB_ORIGIN}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/** Parse 'Monday, July 13, 2026 01:09 PM' to ISO-8601 UTC (Bahrain is UTC+3, no DST), or fallback. */
function parseMessageDate(s: string, fallback: string): string {
  if (s === '') return fallback;
  // Drop a leading weekday name ('Monday, ').
  const cleaned = s.replace(/^[A-Za-z]+,\s*/, '').trim();
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(cleaned);
  if (m) {
    const months: Record<string, number> = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    };
    const mo = months[(m[1] ?? '').toLowerCase()];
    if (mo !== undefined) {
      let hour = Number(m[4]);
      const ampm = (m[6] ?? '').toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      const utcMs = Date.UTC(Number(m[3]), mo, Number(m[2]), hour, Number(m[5]), 0) - 3 * 60 * 60 * 1000;
      if (Number.isFinite(utcMs)) return new Date(utcMs).toISOString();
    }
  }
  const ms = Date.parse(cleaned);
  return Number.isNaN(ms) ? fallback : new Date(ms).toISOString();
}

async function fetchFilings(ctx: FetchContext): Promise<FetchResult[]> {
  const { source, http, browser, now } = ctx;
  const cfg = source.endpointConfig;
  const useBrowser = source.transport === 'http_bootstrap' || source.transport === 'headless';
  let url = cfg.urlTemplate ?? source.entryUrl;
  if (useBrowser && cfg.actionDiscovery) {
    const boot = await browser.bootstrap(cfg.actionDiscovery);
    // The GetAllAnnouncements URL is captured at runtime (session/referer must be seated by the page).
    if (!cfg.urlTemplate) {
      if (!boot.resolvedUrl) {
        throw new Error(
          `BHB filings_list fetch: source ${source.id} has no urlTemplate and bootstrap resolved no URL`,
        );
      }
      url = boot.resolvedUrl;
    }
  }
  const client = useBrowser ? browser : http;
  const res = await client.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: now(),
      meta: { venue: 'BHB', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/** PURE parser. GetAllAnnouncements JSON → NormalizedFilingRef[] for list-diff on external_id. */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.body.toString('utf8').replace(/^﻿/, ''));
  } catch {
    return { rows: [], parserVersion: BHB_FILINGS_PARSER_VERSION };
  }

  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  for (const r of locateRows(payload)) {
    const title = str(pick(r, ['title', 'Title', 'headline', 'Headline']));
    if (title === '') continue;

    const link = str(pick(r, ['linkUrl', 'LinkUrl', 'url', 'Url', 'link', 'Link']));
    const symbol = str(pick(r, ['symbol', 'Symbol', 'ticker', 'Ticker']));
    const explicitId = str(pick(r, ['itemid', 'itemId', 'id', 'Id', 'announcementId', 'AnnouncementId']));
    // BHB itemid is a PER-COMPANY counter (the same itemid recurs across issuers), so the stable
    // external_id namespaces itemid under the issuer symbol. Fall back to a title+date hash.
    const itemId = itemIdFromLink(link) ?? (explicitId !== '' ? explicitId : null);
    const idBasis =
      itemId !== null
        ? symbol !== ''
          ? `${symbol}-${itemId}`
          : itemId
        : createHash('sha1')
            .update(`${title}|${str(pick(r, ['messageDate', 'MessageDate']))}`)
            .digest('hex')
            .slice(0, 16);
    const externalId = `BHB-${idBasis}`;
    if (seen.has(externalId)) continue;

    const filedRaw = str(pick(r, ['messageDate', 'MessageDate', 'date', 'Date', 'publishDate', 'PublishDate']));
    const filedAt = parseMessageDate(filedRaw, snapshot.fetchedAt);
    const detailUrl = absoluteUrl(link);

    const ref: NormalizedFilingRef = {
      venue: 'BHB',
      externalId,
      sourceRef: externalId,
      title,
      filedAt,
      detailUrl,
    };
    seen.add(externalId);
    rows.push(ref);
  }

  return { rows, parserVersion: BHB_FILINGS_PARSER_VERSION };
}

export const bhbFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: BHB_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
