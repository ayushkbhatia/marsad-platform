// ingestion/src/adapters/filings-detail.ts
//
// The filing_detail chain's PURE, venue-agnostic helpers + the per-venue PDF resolvers.
//
// The detail flow (01-ingestion.md §"Filing detail + PDFs"): the filings_list poll records each new
// announcement as a pending ingest.seen_items row carrying its detailUrl / pdfUrl; the
// filings_detail_poll handler drains them, downloads the PDF, stores it in the 'filings' Storage
// bucket, links public.filings, and enqueues ops.filing_extract_queue keyed by content sha256.
//
// MOST venues carry a direct pdfUrl on the list ref (DFM eFsah resources[], ADX urlEn, MSX RSS <Link>,
// TDWL attachmentUrl, QE fileUrl) → the drain downloads it directly, no resolver needed. Only venues
// whose list gives ONLY an HTML detail page (BHB SharePoint news page) need a resolver to extract the
// PDF href from that page. Resolvers are PURE (bytes in, url out) so they are golden-tested offline.

import type { VenueCode } from '../core/types.js';

/** A venue that exposes its PDF only behind an HTML detail page implements this. PURE. */
export interface FilingPdfResolver {
  /** Extract the first absolute PDF URL from a fetched detail-page body, or null if none. */
  extractPdfUrl(body: Buffer, contentType: string): string | null;
}

// ---------------------------------------------------------------------------
// Pure storage-key + content helpers (unit-tested in filings-detail.test.ts).
// ---------------------------------------------------------------------------

/** Content-type → file extension for the stored artifact. Defaults to 'pdf' (the dominant case). */
export function pdfExtFor(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('json')) return 'json';
  if (ct.includes('msword') || ct.includes('officedocument.wordprocessingml')) return 'doc';
  if (ct.includes('excel') || ct.includes('spreadsheetml')) return 'xlsx';
  return 'bin';
}

/** Whether a fetched response is itself the PDF (vs an HTML detail page we must scrape). */
export function isPdfResponse(contentType: string | undefined, body: Buffer): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('pdf')) return true;
  // Some CDNs mislabel; sniff the %PDF- magic as a fallback.
  return body.length >= 5 && body.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Sanitize one storage-path segment: keep [A-Za-z0-9._-], collapse the rest to '-'. */
export function sanitizeSeg(s: string): string {
  const cleaned = s.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? '_unmapped' : cleaned;
}

/**
 * Content-addressed 'filings' bucket key, mirroring the existing layout ({venue}/{ticker}/…): the
 * list feed carries no security id (0037 note), so the ticker segment is '_unmapped' until a later
 * security-resolution pass. sha256 in the filename makes a re-fetch of identical bytes idempotent
 * (upsert no-op) — the same anchor the extraction queue dedupes on.
 */
export function filingStorageKey(
  venue: VenueCode,
  ticker: string | null | undefined,
  sha256: string,
  ext: string,
): string {
  const t = ticker && ticker.trim() !== '' ? sanitizeSeg(ticker) : '_unmapped';
  return `${venue.toLowerCase()}/${t}/${sha256}.${ext}`;
}

// ---------------------------------------------------------------------------
// BHB — the list ref is the SharePoint news page (linkUrl), not a direct PDF. Extract the first PDF
// href. BHB documents live under /getattachment/… or a DAM path ending .pdf. Best-effort + safe: if
// no PDF href is present, return null and the drain marks the item 'nopdf' (clean terminal, no poison).
// ---------------------------------------------------------------------------

const BHB_ORIGIN = 'https://bahrainbourse.com';

export function bhbExtractPdfUrl(body: Buffer, _contentType: string): string | null {
  const html = body.toString('utf8');
  // Any href pointing at a .pdf (optionally with a query string), or a getattachment link.
  const re = /(?:href|src)\s*=\s*["']([^"']+?\.pdf(?:\?[^"']*)?)["']/i;
  const m = re.exec(html);
  if (m && m[1]) return toAbsolute(m[1]);
  const att = /(?:href|src)\s*=\s*["']([^"']*getattachment[^"']+)["']/i.exec(html);
  if (att && att[1]) return toAbsolute(att[1]);
  return null;
}

function toAbsolute(u: string): string {
  const url = u.trim();
  if (/^https?:\/\//i.test(url)) return url;
  const encoded = url.replace(/ /g, '%20');
  return `${BHB_ORIGIN}${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/** Per-venue resolvers. Absent ⇒ the venue carries a direct pdfUrl on the list ref (no scrape). */
export const FILING_PDF_RESOLVERS: Partial<Record<VenueCode, FilingPdfResolver>> = {
  BHB: { extractPdfUrl: bhbExtractPdfUrl },
};
