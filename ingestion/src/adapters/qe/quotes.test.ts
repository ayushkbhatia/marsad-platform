// Golden test for the QE quotes parser. Zero network: reads the captured fixture bytes and asserts
// the pure parse() yields sane quotes. Run with: node --test (or tsx --test) from ingestion/.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qeQuotes } from './quotes.js';
import type { StoredSnapshot } from '../../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/qe/marketwatch.txt');

function loadSnapshot(): StoredSnapshot {
  const body = readFileSync(fixturePath);
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'QE',
    dataType: 'quotes',
    contentType: 'text/plain',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T13:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('QE quotes: parses >=1 quote with sane fields from the real fixture', () => {
  const { rows, parserVersion } = qeQuotes.parse(loadSnapshot());
  assert.equal(parserVersion, qeQuotes.parserVersion);
  assert.ok(rows.length >= 1, 'expected at least one quote');
  assert.ok(rows.length >= 100, `expected the full ~107-row board, got ${rows.length}`);

  // Every row carries a venue + non-empty ticker.
  for (const q of rows) {
    assert.equal(q.venue, 'QE');
    assert.ok(q.ticker.length > 0, 'ticker must be non-empty');
    assert.equal(q.asOf, '2026-07-13T13:00:00.000Z');
  }

  // Spot-check the first fixture row (QNBK) against verbatim fixture values.
  const qnbk = rows.find((r) => r.ticker === 'QNBK');
  assert.ok(qnbk, 'QNBK must be present');
  assert.equal(qnbk!.last, 18.61);
  assert.equal(qnbk!.change, 0.28);
  assert.equal(qnbk!.changePct, 1.53);
  assert.equal(qnbk!.open, 18.33);
  assert.equal(qnbk!.high, 18.63);
  assert.equal(qnbk!.low, 18.24);
  assert.equal(qnbk!.volume, 1873521);
  assert.equal(qnbk!.week52High, 18.5);
  assert.equal(qnbk!.week52Low, 15.11);
});

test('QE quotes: computes change from PrevClosing when Change field is missing', () => {
  // Synthetic board exercising the compute-change branch (no Change key present).
  const body = Buffer.from(
    JSON.stringify({
      rows: [{ Symbol: 'TEST', LastPrice: '10.50', PrevClosing: '10.00' }],
    }),
    'utf8',
  );
  const snap: StoredSnapshot = {
    snapshotId: 2,
    sourceId: 1,
    venue: 'QE',
    dataType: 'quotes',
    contentType: 'text/plain',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T13:00:00.000Z',
    meta: {},
  };
  const { rows } = qeQuotes.parse(snap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.change, 0.5);
});

test('QE quotes: malformed body yields zero rows (PARSE_DRIFT signal), not a throw', () => {
  const snap: StoredSnapshot = {
    snapshotId: 3,
    sourceId: 1,
    venue: 'QE',
    dataType: 'quotes',
    contentType: 'text/html',
    externalId: null,
    body: Buffer.from('<html>error</html>', 'utf8'),
    fetchedAt: '2026-07-13T13:00:00.000Z',
    meta: {},
  };
  const { rows } = qeQuotes.parse(snap);
  assert.equal(rows.length, 0);
});
