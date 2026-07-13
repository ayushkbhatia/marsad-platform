// BHB parser tests. NO real fixture (BHB board is SPA-over-JSON; XLSX not captured in sandbox).
// Quotes tested against an inline webapi-shape sample; EOD tested against inline sheet rows. Both
// MUST be re-pointed at real goldens once the VPS captures them. Zero network.
// Run with: node --test (or tsx --test) from ingestion/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bhbQuotes } from './quotes.js';
import { mapBulletinRows, type SheetRow } from './eod.js';
import type { StoredSnapshot } from '../../core/types.js';

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'BHB',
    dataType: 'quotes',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T10:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('BHB quotes: parses a webapi-shape board with derived change', () => {
  const board = {
    data: [
      { Symbol: 'AUB', LastPrice: 0.98, PreviousClose: 0.96, Open: 0.965, High: 0.99, Low: 0.96, Volume: 1200000 },
      { Symbol: 'BATELCO', LastPrice: 0.52, Change: -0.01, PercentChange: -1.8868, Volume: 340000 },
    ],
  };
  const { rows, parserVersion } = bhbQuotes.parse(snap(Buffer.from(JSON.stringify(board), 'utf8')));
  assert.equal(parserVersion, bhbQuotes.parserVersion);
  assert.equal(rows.length, 2);

  const aub = rows.find((r) => r.ticker === 'AUB')!;
  assert.equal(aub.venue, 'BHB');
  assert.equal(aub.last, 0.98);
  assert.equal(aub.high, 0.99);
  assert.equal(aub.volume, 1200000);
  assert.equal(aub.change, 0.02); // 0.98 - 0.96
  assert.equal(aub.changePct, 2.0833); // 0.02/0.96*100 rounded to 4dp

  const bat = rows.find((r) => r.ticker === 'BATELCO')!;
  assert.equal(bat.change, -0.01);
  assert.equal(bat.changePct, -1.8868);
  assert.equal(bat.asOf, '2026-07-13T10:00:00.000Z');
});

test('BHB quotes: non-JSON body yields zero rows (PARSE_DRIFT), not a throw', () => {
  const { rows } = bhbQuotes.parse(snap(Buffer.from('<html>spa shell</html>', 'utf8')));
  assert.equal(rows.length, 0);
});

test('BHB EOD: mapBulletinRows maps Daily-Trading-Summary rows to NormalizedOhlcv', () => {
  // Inline header-keyed rows as decodeWorkbook() would emit from the XLSX.
  const sheetRows: SheetRow[] = [
    { Symbol: 'AUB', Open: '0.965', High: '0.990', Low: '0.960', Close: '0.980', Volume: '1,200,000', Value: '1,176,000' },
    { Symbol: 'GFH', Open: 0.32, High: 0.33, Low: 0.315, Close: 0.325, Volume: 5000000, Value: 1625000 },
    { Symbol: 'NOTRADE', Close: '' }, // non-traded row: no close -> skipped (close is NOT NULL)
  ];
  const out = mapBulletinRows(sheetRows, '2026-07-13');
  assert.equal(out.length, 2);

  const aub = out.find((r) => r.ticker === 'AUB')!;
  assert.equal(aub.venue, 'BHB');
  assert.equal(aub.tradeDate, '2026-07-13');
  assert.equal(aub.close, 0.98);
  assert.equal(aub.open, 0.965);
  assert.equal(aub.high, 0.99);
  assert.equal(aub.low, 0.96);
  assert.equal(aub.volume, 1200000); // comma-stripped
  assert.equal(aub.valueTraded, 1176000);

  const gfh = out.find((r) => r.ticker === 'GFH')!;
  assert.equal(gfh.close, 0.325);
  assert.equal(gfh.volume, 5000000);
});
