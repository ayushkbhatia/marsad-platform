// MSX (Muscat Stock Exchange) — filings_list TaskSpec.
//
// The details.aspx?b1=News&t=News page is a CLIENT-SIDE Kendo/jQuery.tmpl template — its grid data
// XHR does not fire on plain load, so the served HTML carries only `${NewsID}` placeholders and zero
// real rows. The reliable, server-rendered, no-JS/no-captcha source is the RSS feed:
//   GET https://www.msx.om/rss.aspx?t=Company   → text/xml, 20 <item> issuer announcements
// (rss.aspx?t=Circulars is the sibling for circulars; ?t=News and ?t=Disclosures return EMPTY.)
//
// Each <item> carries:
//   <title>        announcement headline
//   <pubDate>      '7/13/2026 3:58:37 PM'  (M/D/YYYY h:mm:ss AM/PM)
//   <Link>         absolute PDF url, e.g. https://www.msx.om//msmdocs/images/newsdocs/SSPW-13072026-35.pdf
//   <description>  HTML table (ignored at list stage)
// RSS has NO numeric NewsID, so the stable per-filing external_id is the PDF filename stem
// (e.g. 'SSPW-13072026-35'), falling back to a hash of title+pubDate.
//
// Golden fixture: ingestion/fixtures/msx/filings-live.xml (real rss.aspx?t=Company XML, 20 items).

import { createHash } from 'node:crypto';
import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const MSX_FILINGS_PARSER_VERSION = 2;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Pull the inner text of the first <tag>…</tag> (case-insensitive, CDATA-aware) in `block`. */
function tag(block: string, name: string): string {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(block);
  if (!m || m[1] === undefined) return '';
  let inner = m[1];
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(inner);
  if (cdata && cdata[1] !== undefined) inner = cdata[1];
  return inner.trim();
}

/** Derive the stable external id from the PDF <Link> filename stem, e.g. SSPW-13072026-35. */
function pdfStem(link: string): string | null {
  if (link === '') return null;
  // Take the last path segment, drop query/hash, drop a trailing .pdf (case-insensitive).
  const noQuery = link.split(/[?#]/)[0] ?? link;
  const segs = noQuery.split('/').filter((s) => s !== '');
  const last = segs[segs.length - 1];
  if (last === undefined || last === '') return null;
  const stem = last.replace(/\.pdf$/i, '').trim();
  return stem === '' ? null : stem;
}

/** Parse '7/13/2026 3:58:37 PM' (M/D/YYYY h:mm:ss AM/PM) to an ISO-8601 UTC string, or null. */
function parsePubDate(s: string): string | null {
  if (s === '') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(s.trim());
  if (m) {
    let hour = Number(m[4]);
    const ampm = (m[7] ?? '').toUpperCase();
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    const min = Number(m[5]);
    const sec = Number(m[6]);
    // Oman is UTC+4 (no DST). Convert the local wall-clock print to UTC.
    const utcMs = Date.UTC(year, month - 1, day, hour, min, sec) - 4 * 60 * 60 * 1000;
    if (Number.isFinite(utcMs)) return new Date(utcMs).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function fetchFilings(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const client = ctx.source.transport === 'http' ? ctx.http : ctx.browser;
  const res = await client.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'text/xml',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'MSX', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/** PURE parser. Parses RSS <item> blocks → NormalizedFilingRef[] for list-diff on external_id. */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const xml = snapshot.body.toString('utf8');
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    if (block === undefined) continue;

    const title = clean(tag(block, 'title'));
    if (title === '') continue;

    const link = decodeEntities(tag(block, 'Link') || tag(block, 'link')).trim();
    const pubRaw = clean(tag(block, 'pubDate'));

    const stem = pdfStem(link);
    const idBasis = stem ?? createHash('sha1').update(`${title}|${pubRaw}`).digest('hex').slice(0, 16);
    const externalId = `MSX-${idBasis}`;
    if (seen.has(externalId)) continue;

    const filedAt = parsePubDate(pubRaw) ?? snapshot.fetchedAt;

    const ref: NormalizedFilingRef = {
      venue: 'MSX',
      externalId,
      sourceRef: externalId,
      title,
      filedAt,
      // The RSS <Link> IS the PDF/detail artifact; no separate detail page.
      detailUrl: link,
    };
    if (link !== '') ref.pdfUrl = link;
    seen.add(externalId);
    rows.push(ref);
  }

  return { rows, parserVersion: MSX_FILINGS_PARSER_VERSION };
}

export const msxFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: MSX_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
