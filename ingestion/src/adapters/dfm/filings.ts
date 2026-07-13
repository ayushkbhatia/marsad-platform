// DFM (Dubai Financial Market) — filings_list TaskSpec.
//
// DFM disclosures (eFsah) are served as JSON from api2.dfm.ae/efsah/v1/prototype_efsah. Verified
// live from the VPS (plain http 200, ~16KB): the response is a UTF-8-BOM-prefixed JSON object with
// the announcement rows nested under the key `root` (NOT data/items/…), each row carrying:
//   id                (uuid — stable per-filing external_id)
//   publication_date  ('Jul 13, 2026 17:17:28')
//   headline          (' Disclosure of material information ')
//   issuer_symbol     ('IFA')  / issuer  (full name)
//   announcement_type ('Disclosure')
//   resources[]       ({ description, r_path '/2026/Jul/13/<uuid>/<file>.pdf', category, language, type })
// The r_path is CDN-relative and prefixed with the api2.dfm.ae origin to form the PDF url.
//
// Golden fixture: ingestion/fixtures/dfm/filings-live.json (real prototype_efsah JSON, 20 rows,
// includes the leading UTF-8 BOM). The parser strips a leading BOM before JSON.parse.

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const DFM_FILINGS_PARSER_VERSION = 2;

// The api2.dfm.ae origin that serves both the JSON list and the resource (PDF) CDN paths.
const DFM_API_ORIGIN = 'https://api2.dfm.ae';

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pick(row: Json, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k) && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim();
}

/** Strip a leading UTF-8 BOM (EF BB BF → U+FEFF once decoded) so JSON.parse does not throw. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Locate the announcement-row array. eFsah nests rows under `root`; alternates kept for safety. */
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    for (const key of [
      'root', 'Root',
      'data', 'Data', 'result', 'Result',
      'items', 'Items', 'disclosures', 'Disclosures',
      'rows', 'Rows', 'list', 'List',
    ]) {
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

/** Resolve the first attachment's absolute PDF url from resources[].r_path (CDN-relative). */
function resolvePdfUrl(row: Json): string | undefined {
  const resources = row['resources'] ?? row['Resources'];
  if (!Array.isArray(resources)) return undefined;
  for (const r of resources) {
    if (!isObj(r)) continue;
    const rPath = str(pick(r, ['r_path', 'rPath', 'path', 'url', 'Url']));
    if (rPath === '') continue;
    if (/^https?:\/\//i.test(rPath)) return rPath;
    return `${DFM_API_ORIGIN}${rPath.startsWith('/') ? '' : '/'}${rPath}`;
  }
  return undefined;
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
      contentType: res.headers['content-type'] ?? 'application/json',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'DFM', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/** PURE parser. eFsah prototype_efsah JSON → NormalizedFilingRef[] for list-diff on external_id. */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  let payload: unknown;
  try {
    payload = JSON.parse(stripBom(snapshot.body.toString('utf8')));
  } catch {
    // Non-JSON (WAF challenge / HTML SPA page) → zero rows → PARSE_DRIFT on a changed snapshot.
    return { rows: [], parserVersion: DFM_FILINGS_PARSER_VERSION };
  }

  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  for (const r of locateRows(payload)) {
    const rawId = str(pick(r, ['id', 'Id', 'DisclosureId', 'disclosureId', 'AnnouncementId', 'Number', 'RefNo', 'ReferenceNumber']));
    if (rawId === '') continue;
    const externalId = `DFM-${rawId}`;
    if (seen.has(externalId)) continue;

    const title = str(pick(r, ['headline', 'Headline', 'HeadlineEn', 'Title', 'title', 'TitleEn', 'titleEn', 'Subject', 'subject', 'DisclosureTitle']));
    if (title === '') continue;

    const filedRaw = str(pick(r, ['publication_date', 'publicationDate', 'PublicationDate', 'Date', 'date', 'DisclosureDate', 'PublishDate', 'publishDate', 'CreatedDate', 'DateTime']));
    const filedAt = normalizeIso(filedRaw) ?? snapshot.fetchedAt;

    const pdfUrl = resolvePdfUrl(r);

    const ref: NormalizedFilingRef = {
      venue: 'DFM',
      externalId,
      sourceRef: externalId,
      title,
      filedAt,
      // No standalone detail page in the eFsah list — the PDF resource IS the detail artifact.
      detailUrl: pdfUrl ?? '',
    };
    if (pdfUrl !== undefined) ref.pdfUrl = pdfUrl;
    seen.add(externalId);
    rows.push(ref);
  }

  return { rows, parserVersion: DFM_FILINGS_PARSER_VERSION };
}

// DFM (Dubai) local offset — UTC+4, no DST. eFsah publication_date is a naive Dubai wall-clock.
const DFM_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

// 'Jul 13, 2026 17:17:28' → month index. Case-insensitive on the 3-letter English abbreviation.
const DFM_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort ISO normalization of common DFM date encodings; returns null if unparseable.
 * PURE: the naive 'MMM dd, yyyy HH:mm:ss' eFsah format carries no timezone, so it is parsed
 * explicitly as DFM-local (UTC+4) — never handed to `new Date(string)`, which interprets a naive
 * string in the HOST timezone and would make filedAt (and every downstream key/hash derived from
 * it) non-deterministic across machines (CONTRACT §2 parse purity / §10 golden replay).
 */
function normalizeIso(s: string): string | null {
  if (s === '') return null;
  // Epoch millis (e.g. "/Date(1752345600000)/" or a bare number).
  const epoch = /\/Date\((\d+)\)\/|^(\d{12,13})$/.exec(s);
  if (epoch) {
    const ms = Number(epoch[1] ?? epoch[2]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  // Naive eFsah 'MMM dd, yyyy HH:mm:ss' (Dubai wall-clock, no offset) → treat as UTC+4.
  const naive = /^([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (naive) {
    const mo = DFM_MONTHS[(naive[1] ?? '').slice(0, 3).toLowerCase()];
    if (mo !== undefined) {
      const utcMs =
        Date.UTC(Number(naive[3]), mo, Number(naive[2]), Number(naive[4]), Number(naive[5]), Number(naive[6])) -
        DFM_UTC_OFFSET_MS;
      if (Number.isFinite(utcMs)) return new Date(utcMs).toISOString();
    }
  }
  // ISO strings WITH an explicit offset (Z / ±hh:mm) are unambiguous — Date.parse is deterministic.
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export const dfmFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: DFM_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
