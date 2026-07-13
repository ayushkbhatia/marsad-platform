// MSX filings_list parser test. Golden-tested against the REAL msx.om/rss.aspx?t=Company XML
// (ingestion/fixtures/msx/filings-live.xml). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { msxFilingsList } from './filings.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/msx/filings-live.xml');

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 14,
    venue: 'MSX',
    dataType: 'filings_list',
    contentType: 'text/xml',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T18:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('MSX filings: parses the live RSS fixture into announcement refs', () => {
  const body = readFileSync(fixturePath);
  const { rows, parserVersion } = msxFilingsList.parse(snap(body));
  assert.equal(parserVersion, msxFilingsList.parserVersion);
  assert.ok(rows.length >= 1, 'expected at least one item');
  assert.equal(rows.length, 20);

  const first = rows[0]!;
  assert.equal(first.venue, 'MSX');
  // external_id derives from the PDF filename stem (e.g. MSX-SSPW-13072026-35).
  assert.ok(first.externalId.startsWith('MSX-'), 'external_id namespaced');
  assert.ok(first.title.length > 0, 'title present');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(first.filedAt), 'filedAt is ISO');
  assert.ok(first.pdfUrl?.startsWith('https://www.msx.om/'), 'pdfUrl from <Link>');

  for (const r of rows) {
    assert.ok(r.externalId !== '' && r.title !== '');
  }
  assert.equal(new Set(rows.map((r) => r.externalId)).size, rows.length);
});

test('MSX filings: pubDate M/D/YYYY h:mm:ss AM/PM → UTC (Oman UTC+4)', () => {
  const xml =
    '<rss><channel><item><title>Test</title><pubDate>7/13/2026 3:58:37 PM</pubDate>' +
    '<Link>https://www.msx.om//msmdocs/images/newsdocs/SSPW-13072026-35.pdf</Link></item></channel></rss>';
  const { rows } = msxFilingsList.parse(snap(Buffer.from(xml, 'utf8')));
  assert.equal(rows.length, 1);
  // 3:58:37 PM Oman (UTC+4) = 11:58:37 UTC.
  assert.equal(rows[0]!.filedAt, '2026-07-13T11:58:37.000Z');
  assert.equal(rows[0]!.externalId, 'MSX-SSPW-13072026-35');
});

test('MSX filings: an item with no PDF Link falls back to a stable hashed id', () => {
  const xml = '<rss><channel><item><title>No link filing</title><pubDate>7/13/2026 1:00:00 PM</pubDate></item></channel></rss>';
  const { rows } = msxFilingsList.parse(snap(Buffer.from(xml, 'utf8')));
  assert.equal(rows.length, 1);
  assert.ok(/^MSX-[0-9a-f]{16}$/.test(rows[0]!.externalId), 'hashed fallback id');
});

test('MSX filings: the JS-template details.aspx HTML (no <item>) yields zero rows', () => {
  const html = '<html><script>${NewsID}</script></html>';
  const { rows } = msxFilingsList.parse(snap(Buffer.from(html, 'utf8')));
  assert.equal(rows.length, 0);
});
