// DFM (Dubai Financial Market) — filings_list TaskSpec.
//
// DFM disclosures (eFsah) are served as JSON from api2.dfm.ae/efsah/v1 (route pinned on VPS via
// endpoint_config actionDiscovery; ^https://api2\.dfm\.ae/efsah/v1/). No real JSON fixture was
// capturable in the build sandbox (WAF + SPA), so there is NO golden for DFM filings yet — the
// parser is written to the standard eFsah disclosure list shape and unit-tested against an inline
// shape-sample. FIRST VPS RUN MUST capture a real /efsah/v1 list and promote it to a golden.

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const DFM_FILINGS_PARSER_VERSION = 1;

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
function locateRows(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload.filter(isObj);
  if (isObj(payload)) {
    for (const key of ['data', 'Data', 'result', 'Result', 'items', 'Items', 'disclosures', 'Disclosures', 'rows', 'Rows', 'list', 'List']) {
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

/** PURE parser. eFsah disclosure list JSON -> NormalizedFilingRef[] for list-diff on external_id. */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  let payload: unknown;
  try {
    payload = JSON.parse(snapshot.body.toString('utf8'));
  } catch {
    return { rows: [], parserVersion: DFM_FILINGS_PARSER_VERSION };
  }

  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  for (const r of locateRows(payload)) {
    const rawId = str(pick(r, ['Id', 'id', 'DisclosureId', 'disclosureId', 'AnnouncementId', 'Number', 'RefNo', 'ReferenceNumber']));
    if (rawId === '') continue;
    const externalId = `DFM-${rawId}`;
    if (seen.has(externalId)) continue;

    const title = str(pick(r, ['Title', 'title', 'TitleEn', 'titleEn', 'Subject', 'subject', 'Headline', 'DisclosureTitle']));
    if (title === '') continue;

    const filedRaw = str(pick(r, ['Date', 'date', 'DisclosureDate', 'PublishDate', 'publishDate', 'CreatedDate', 'DateTime']));
    const filedAt = normalizeIso(filedRaw) ?? snapshot.fetchedAt;

    const detailUrl = str(pick(r, ['DetailUrl', 'Url', 'url', 'Link', 'link', 'DisclosureUrl']));
    const pdfUrl = str(pick(r, ['PdfUrl', 'pdfUrl', 'AttachmentUrl', 'FileUrl', 'DocumentUrl', 'Attachment']));

    const ref: NormalizedFilingRef = {
      venue: 'DFM',
      externalId,
      sourceRef: externalId,
      title,
      filedAt,
      detailUrl: detailUrl === '' ? snapshot.meta['entryUrl'] as string ?? '' : detailUrl,
    };
    if (pdfUrl !== '') ref.pdfUrl = pdfUrl;
    seen.add(externalId);
    rows.push(ref);
  }

  return { rows, parserVersion: DFM_FILINGS_PARSER_VERSION };
}

/** Best-effort ISO normalization of common DFM date encodings; returns null if unparseable. */
function normalizeIso(s: string): string | null {
  if (s === '') return null;
  // Epoch millis (e.g. "/Date(1752345600000)/" or a bare number).
  const epoch = /\/Date\((\d+)\)\/|^(\d{12,13})$/.exec(s);
  if (epoch) {
    const ms = Number(epoch[1] ?? epoch[2]);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const dfmFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: DFM_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
