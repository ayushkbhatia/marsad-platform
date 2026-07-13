// MSX (Muscat Stock Exchange) — filings_list TaskSpec.
//
// MSX news/disclosures are server-rendered HTML at details.aspx?b1=News&t=News (endpoint is config
// in ctx.source). Detail links carry an id via snapshot.aspx?...&ni={NewsID} or details.aspx?i=...
// FIXTURE CAVEAT: the captured msx/snapshot-BKMB.html embeds the news list as a CLIENT-SIDE
// template (`${NewsID}`, `${TitleEN}` placeholders) — the real list rows are injected by JS, so the
// static fixture has no concrete announcement rows to golden-test against. This parser is written
// to the stable server-rendered list shape and MUST be revalidated on the VPS against a real
// details.aspx capture (add a golden then). MSX quotes (quotes.ts) are the golden-verified path.

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const MSX_FILINGS_PARSER_VERSION = 1;

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
      meta: { venue: 'MSX', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/**
 * PURE parser. Extracts news-detail anchors carrying a numeric NewsID (ni= or i=). Ignores the
 * `${NewsID}` client-template rows (they contain no digits, so the digit-requiring regex skips
 * them cleanly) so a JS-only fixture yields zero rows rather than a bogus `MSX-${NewsID}` id.
 */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const html = snapshot.body.toString('utf8');
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  const anchorRe =
    /<a\b[^>]*href="([^"]*\b(?:ni|i|newsid)=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const idNum = m[2];
    const inner = m[3];
    if (href === undefined || idNum === undefined || inner === undefined) continue;

    const externalId = `MSX-${idNum}`;
    if (seen.has(externalId)) continue;

    const title = clean(inner);
    if (title === '') continue;

    seen.add(externalId);
    rows.push({
      venue: 'MSX',
      externalId,
      sourceRef: externalId,
      title,
      filedAt: snapshot.fetchedAt, // authoritative filed_at set by filing_detail
      detailUrl: clean(href.replace(/<[^>]+>/g, '')),
    });
  }

  return { rows, parserVersion: MSX_FILINGS_PARSER_VERSION };
}

export const msxFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: MSX_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
