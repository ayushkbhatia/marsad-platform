// QE (Qatar Stock Exchange) — filings_list TaskSpec.
//
// QE serves disclosures as a server-rendered HTML list at the company-news page (endpoint is
// config in ctx.source). We parse announcement rows into NormalizedFilingRef for list-diff on
// external_id (ingest.seen_items); the filing_detail fetch is enqueued event-driven downstream.
//
// NOTE ON FIXTURES: the captured qe/homepage.html is the SPA of record and does NOT contain a
// rendered announcements list (the list route was not captured in recon). This parser is written
// against the stable QE announcements markup shape (anchor rows carrying an id= query param + a
// date + a title). It MUST be re-validated on the VPS against a real company-news capture, and a
// golden fixture added, before QE filings ingestion is trusted. Until then filings_list for QE is
// best-effort. Quotes (quotes.ts) are the fully golden-verified QE path.

import type {
  FetchContext,
  FetchResult,
  NormalizedFilingRef,
  ParseResult,
  StoredSnapshot,
  TaskSpec,
} from '../../core/types.js';

export const QE_FILINGS_PARSER_VERSION = 1;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
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
      meta: { venue: 'QE', dataType: 'filings_list', lang: 'en' },
    },
  ];
}

/**
 * PURE parser. Extracts anchor rows that link to a news-detail page carrying a numeric id, plus the
 * nearest title text. Deliberately conservative: an unrecognized layout yields zero rows (=>
 * PARSE_DRIFT on a changed snapshot), which is the correct "site redesigned under us" signal rather
 * than emitting garbage external_ids into seen_items.
 */
function parseFilings(snapshot: StoredSnapshot): ParseResult<NormalizedFilingRef> {
  const html = snapshot.body.toString('utf8');
  const rows: NormalizedFilingRef[] = [];
  const seen = new Set<string>();

  // Match anchors pointing at a news/announcement detail that carries an id query param.
  const anchorRe =
    /<a\b[^>]*href="([^"]*\b(?:id|newsid|announcementid)=(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const idNum = m[2];
    const inner = m[3];
    if (href === undefined || idNum === undefined || inner === undefined) continue;

    const externalId = `QE-${idNum}`;
    if (seen.has(externalId)) continue;

    const title = stripTags(inner);
    if (title === '') continue; // skip icon-only / empty anchors

    seen.add(externalId);
    const detailUrl = decodeEntities(href);
    rows.push({
      venue: 'QE',
      externalId,
      sourceRef: externalId,
      title,
      // filedAt: the list-page timestamp is layout-specific; the authoritative filed_at is set by
      // filing_detail. We stamp the snapshot fetch time as a stable, replayable placeholder.
      filedAt: snapshot.fetchedAt,
      detailUrl,
    });
  }

  return { rows, parserVersion: QE_FILINGS_PARSER_VERSION };
}

export const qeFilingsList: TaskSpec<NormalizedFilingRef> = {
  dataType: 'filings_list',
  parserVersion: QE_FILINGS_PARSER_VERSION,
  fetch: fetchFilings,
  parse: parseFilings,
};
