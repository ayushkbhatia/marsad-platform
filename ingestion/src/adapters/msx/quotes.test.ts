// Golden test for the MSX quotes parser against the real per-security snapshot.aspx fixture.
// Zero network. Run with: node --test (or tsx --test) from ingestion/.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { msxQuotes } from './quotes.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/msx/snapshot-BKMB.html');

function loadSnapshot(externalId: string | null): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'MSX',
    dataType: 'quotes',
    contentType: 'text/html',
    externalId,
    body: readFileSync(fixturePath),
    fetchedAt: '2026-07-13T09:30:00.000Z',
    meta: externalId ? { symbol: externalId, lang: 'en' } : { lang: 'en' },
  };
}

test('MSX quotes: parses one sane quote from the BKMB snapshot page', () => {
  const { rows, parserVersion } = msxQuotes.parse(loadSnapshot('BKMB'));
  assert.equal(parserVersion, msxQuotes.parserVersion);
  assert.equal(rows.length, 1);
  const q = rows[0]!;
  assert.equal(q.venue, 'MSX');
  assert.equal(q.ticker, 'BKMB');
  assert.equal(q.last, 0.397); // LTPLabel
  assert.equal(q.open, 0.4); // OpenLabel
  assert.equal(q.high, 0.4); // ChartDataHigh
  assert.equal(q.low, 0.395); // ChartDataLow
  assert.equal(q.volume, 8431620); // ChartDataVolume, thousands-separated in source
  assert.equal(q.changePct, -0.5); // ChangeLabel "-0.50%"
  // change derived from last - prevClose (0.397 - 0.399), matching the fixture's "(-0.002)".
  assert.equal(q.change, -0.002);
  assert.equal(q.asOf, '2026-07-13T09:30:00.000Z');
});

test('MSX quotes: falls back to CompanySymbolLabel when externalId is absent', () => {
  const { rows } = msxQuotes.parse(loadSnapshot(null));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ticker, 'BKMB'); // from "(BKMB)" label
});

test('MSX quotes: empty/suspended stub yields zero rows (no bogus quote)', () => {
  const snap: StoredSnapshot = {
    snapshotId: 2,
    sourceId: 1,
    venue: 'MSX',
    dataType: 'quotes',
    contentType: 'text/html',
    externalId: 'XXXX',
    body: Buffer.from('<html><body>no data</body></html>', 'utf8'),
    fetchedAt: '2026-07-13T09:30:00.000Z',
    meta: { symbol: 'XXXX' },
  };
  const { rows } = msxQuotes.parse(snap);
  assert.equal(rows.length, 0);
});
