import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filingStorageKey,
  pdfExtFor,
  isPdfResponse,
  sanitizeSeg,
  bhbExtractPdfUrl,
  FILING_PDF_RESOLVERS,
} from './filings-detail.js';

test('filingStorageKey: {venue}/{ticker}/{sha}.{ext}, lowercased venue', () => {
  assert.equal(filingStorageKey('TDWL', '2222', 'abc123', 'pdf'), 'tdwl/2222/abc123.pdf');
});

test('filingStorageKey: null/blank ticker ⇒ _unmapped segment (list feed has no security id)', () => {
  assert.equal(filingStorageKey('DFM', null, 'deadbeef', 'pdf'), 'dfm/_unmapped/deadbeef.pdf');
  assert.equal(filingStorageKey('DFM', '   ', 'deadbeef', 'pdf'), 'dfm/_unmapped/deadbeef.pdf');
});

test('sanitizeSeg: keeps safe chars, collapses the rest, never empty', () => {
  assert.equal(sanitizeSeg('AB/CD 12'), 'AB-CD-12');
  assert.equal(sanitizeSeg('7010'), '7010');
  assert.equal(sanitizeSeg('///'), '_unmapped');
});

test('pdfExtFor: content-type → extension, defaults to bin', () => {
  assert.equal(pdfExtFor('application/pdf'), 'pdf');
  assert.equal(pdfExtFor('application/pdf; charset=binary'), 'pdf');
  assert.equal(pdfExtFor('text/html'), 'html');
  assert.equal(pdfExtFor('text/xml'), 'xml');
  assert.equal(pdfExtFor(undefined), 'bin');
});

test('isPdfResponse: content-type OR %PDF- magic bytes', () => {
  assert.equal(isPdfResponse('application/pdf', Buffer.from('anything')), true);
  // mislabeled content-type but real PDF bytes ⇒ sniffed true
  assert.equal(isPdfResponse('application/octet-stream', Buffer.from('%PDF-1.7\n...')), true);
  // genuine HTML ⇒ false (never stored as a PDF)
  assert.equal(isPdfResponse('text/html', Buffer.from('<!doctype html><html>')), false);
});

test('bhbExtractPdfUrl: first .pdf href → absolute; getattachment fallback; none → null', () => {
  assert.equal(
    bhbExtractPdfUrl(Buffer.from('<a href="/en/docs/ann.pdf">view</a>'), 'text/html'),
    'https://bahrainbourse.com/en/docs/ann.pdf',
  );
  assert.equal(
    bhbExtractPdfUrl(Buffer.from('<a href="https://cdn.bhb/x.pdf?t=1">x</a>'), 'text/html'),
    'https://cdn.bhb/x.pdf?t=1',
  );
  assert.equal(
    bhbExtractPdfUrl(Buffer.from('<a href="/getattachment/abc/file">g</a>'), 'text/html'),
    'https://bahrainbourse.com/getattachment/abc/file',
  );
  assert.equal(bhbExtractPdfUrl(Buffer.from('<p>no attachment</p>'), 'text/html'), null);
});

test('no venue is wired to an HTML PDF resolver (all live venues carry a direct pdfUrl on the ref)', () => {
  // BHB was the only HTML-scrape candidate but its real attachment loads via JS (chrome-only .pdf
  // hrefs in static HTML), so it is deliberately unwired — BHB filings are list-only. DFM/ADX/MSX/TDWL
  // carry a direct per-announcement pdfUrl, so they need no resolver.
  assert.equal(Object.keys(FILING_PDF_RESOLVERS).length, 0);
  assert.equal(FILING_PDF_RESOLVERS.BHB, undefined);
});
