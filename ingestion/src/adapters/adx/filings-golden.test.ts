// ADX filings_list golden test against the REAL apigateway.adx.ae/adx/tradings/1.1/news JSON
// (ingestion/fixtures/adx/filings-live.json, 25 disclosure rows under response.news[]). This
// exercises DEFAULT_FILING_MAP (the live field map). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseAdxFilingsList } from './filings.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/adx/filings-live.json');

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 8,
    venue: 'ADX',
    dataType: 'filings_list',
    contentType: 'application/json',
    externalId: null,
    body,
    // no filingFieldMap in meta ⇒ DEFAULT_FILING_MAP (the real ADX field names) applies.
    fetchedAt: '2026-07-13T18:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('ADX filings: parses the live news fixture via DEFAULT_FILING_MAP', () => {
  const body = readFileSync(fixturePath);
  const { rows } = parseAdxFilingsList(snap(body));
  assert.ok(rows.length >= 1, 'expected at least one disclosure');
  assert.equal(rows.length, 25);

  const first = rows[0]!;
  assert.equal(first.venue, 'ADX');
  // external_id = exPara (e.g. '20260713174448-ALPHADHABI').
  assert.ok(/-[A-Z]/.test(first.externalId), 'exPara-shaped external_id');
  assert.ok(first.title.length > 0, 'title present');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(first.filedAt), 'filedAt is ISO');
  // urlEn is the apigateway CDN download.
  assert.ok(first.pdfUrl?.startsWith('https://apigateway.adx.ae/'), 'pdfUrl from urlEn');

  for (const r of rows) {
    assert.ok(r.externalId !== '' && r.title !== '');
  }
  assert.equal(new Set(rows.map((r) => r.externalId)).size, rows.length);
});

test('ADX filings: naive publishedDate is parsed as ADX-local (UTC+4), deterministically', () => {
  const payload = { response: { news: [{ exPara: '20260713174448-X', titleEn: 'X disclosure', urlEn: 'https://apigateway.adx.ae/adx/cdn/1.0/content/download/1', publishedDate: '2026-07-13 18:00:00.0' }] } };
  const { rows } = parseAdxFilingsList({ ...snap(Buffer.from(JSON.stringify(payload), 'utf8')) });
  assert.equal(rows.length, 1);
  // 18:00 ADX (UTC+4) = 14:00 UTC.
  assert.equal(rows[0]!.filedAt, '2026-07-13T14:00:00.000Z');
});
