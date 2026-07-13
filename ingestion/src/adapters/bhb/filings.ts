// BHB (Bahrain Bourse) — filings_list TaskSpec.
//
// BHB news & announcements are served as an HTML list (bahrainbourse.com/en/news-announcements) or,
// where exposed, the webapi JSON host. The captured bhb/market.html is the SPA homepage and does NOT
// contain the announcements list, so there is NO golden for BHB filings yet. This parser targets the
// stable server-rendered announcement-anchor shape (detail link carrying a numeric id + title) and
// MUST be revalidated on the VPS against a real news-announcements capture (add a golden then).
// BHB's golden-verified data paths are quotes (quotes.ts shape-sample) and the EOD XLSX (eod.ts).

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const BHB_FILINGS_PARSER_VERSION = 1;

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFilings(ctx: FetchContext): Promise<FetchResult[]> {
  const cfg = ctx.source.endpointConfig;
  const url = cfg.urlTemplate ?? ctx.source.entryUrl;
  const res = await ctx.http.get(url, {
    ...(cfg.headers ? { headers: cfg.headers } : {}),
  });
  return [
    {
      url: res.url,
      contentType: res.headers['content-type'] ?? 'text/html',
      httpStatus: res.status,
      body: res.body,
      fetchedAt: ctx.now(),
      meta: { venue: 'BHB', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/** PURE parser. Anchor rows -> NormalizedFilingRef; conservative (unknown layout => zero rows). */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const html = snapshot.body.toString('utf8');
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  const anchorRe =
    /<a\b[^>]*href="([^"]*\b(?:id|newsid|announcementid|nid)=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const idNum = m[2];
    const inner = m[3];
    if (href === undefined || idNum === undefined || inner === undefined) continue;

    const externalId = `BHB-${idNum}`;
    if (seen.has(externalId)) continue;

    const title = clean(inner);
    if (title === '') continue;

    seen.add(externalId);
    rows.push({
      venue: 'BHB',
      externalId,
      sourceRef: externalId,
      title,
      filedAt: snapshot.fetchedAt,
      detailUrl: clean(href.replace(/<[^>]+>/g, '')),
    });
  }

  return { rows, parserVersion: BHB_FILINGS_PARSER_VERSION };
}

export const bhbFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: BHB_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
