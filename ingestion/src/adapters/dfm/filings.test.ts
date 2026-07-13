// DFM filings_list parser test. Golden-tested against the REAL api2.dfm.ae/efsah prototype_efsah
// JSON (ingestion/fixtures/dfm/filings-live.json, includes a leading UTF-8 BOM). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { dfmFilingsList } from './filings.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/dfm/filings-live.json');

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 5,
    venue: 'DFM',
    dataType: 'filings_list',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T18:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('DFM filings: parses the live eFsah fixture (BOM-prefixed) into announcement refs', () => {
  const body = readFileSync(fixturePath);
  const { rows, parserVersion } = dfmFilingsList.parse(snap(body));
  assert.equal(parserVersion, dfmFilingsList.parserVersion);
  assert.ok(rows.length >= 1, 'expected at least one announcement');
  assert.equal(rows.length, 20);

  const first = rows[0]!;
  assert.equal(first.venue, 'DFM');
  assert.ok(first.externalId.startsWith('DFM-'), 'external_id namespaced');
  assert.ok(first.title.length > 0, 'title present');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(first.filedAt), 'filedAt is ISO');
  // r_path resolves to an absolute api2.dfm.ae PDF url.
  assert.ok(first.pdfUrl?.startsWith('https://api2.dfm.ae/'), 'pdfUrl absolute');

  // Every row has a non-empty external_id + title (the drift-zero contract).
  for (const r of rows) {
    assert.ok(r.externalId !== '' && r.title !== '');
  }
  // external_ids are unique.
  assert.equal(new Set(rows.map((r) => r.externalId)).size, rows.length);
});

test('DFM filings: BOM is stripped so JSON.parse does not throw', () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ root: [{ id: 'abc', headline: 'X disclosure', publication_date: 'Jul 13, 2026 17:17:28' }] }))]);
  const { rows } = dfmFilingsList.parse(snap(withBom));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.externalId, 'DFM-abc');
  assert.equal(rows[0]!.title, 'X disclosure');
});

test('DFM filings: HTML SPA page (wrong bytes) yields zero rows, not a throw', () => {
  const { rows } = dfmFilingsList.parse(snap(Buffer.from('<html><body>disclosures</body></html>', 'utf8')));
  assert.equal(rows.length, 0);
});
