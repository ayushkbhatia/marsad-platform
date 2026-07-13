// DFM quotes parser test. NO real fixture exists (DFM board is SPA-over-JSON on a WAF host that the
// build sandbox could not capture). We test against an INLINE shape-sample built to the standard
// api2.dfm.ae/mw/v1 market-watch payload — the TDWL shape-sample convention. This asserts the
// parser's field resolution + change derivation; it MUST be re-pointed at a real golden once the
// VPS captures one. Zero network. Run with: node --test (or tsx --test) from ingestion/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dfmQuotes } from './quotes.js';
import type { StoredSnapshot } from '../../core/types.js';

// Shape-sample: two rows in the DFM mw/v1 style. Field names mirror the historically observed
// casing; the parser also accepts several alternates (see quotes.ts pick() lists).
const SHAPE_SAMPLE = {
  data: [
    {
      Symbol: 'EMAAR',
      CompanyName: 'Emaar Properties',
      Price: 8.12,
      PreviousClose: 8.0,
      Open: 8.05,
      High: 8.2,
      Low: 8.01,
      Volume: 4521000,
      BidPrice: 8.11,
      AskPrice: 8.13,
    },
    {
      Symbol: 'DIB',
      CompanyName: 'Dubai Islamic Bank',
      Price: 6.5,
      Change: -0.1,
      PercentChange: -1.5152,
      Open: 6.6,
      High: 6.62,
      Low: 6.48,
      Volume: 2100000,
    },
  ],
};

function snap(body: Buffer): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: 'DFM',
    dataType: 'quotes',
    contentType: 'application/json',
    externalId: null,
    body,
    fetchedAt: '2026-07-13T11:00:00.000Z',
    meta: { lang: 'en' },
  };
}

test('DFM quotes: parses the shape-sample board with derived change', () => {
  const { rows, parserVersion } = dfmQuotes.parse(snap(Buffer.from(JSON.stringify(SHAPE_SAMPLE), 'utf8')));
  assert.equal(parserVersion, dfmQuotes.parserVersion);
  assert.equal(rows.length, 2);

  const emaar = rows.find((r) => r.ticker === 'EMAAR')!;
  assert.equal(emaar.venue, 'DFM');
  assert.equal(emaar.last, 8.12);
  assert.equal(emaar.open, 8.05);
  assert.equal(emaar.high, 8.2);
  assert.equal(emaar.low, 8.01);
  assert.equal(emaar.volume, 4521000);
  assert.equal(emaar.bid, 8.11);
  assert.equal(emaar.ask, 8.13);
  // change/pct derived from Price - PreviousClose (8.12 - 8.00).
  assert.equal(emaar.change, 0.12);
  assert.equal(emaar.changePct, 1.5); // 0.12 / 8.00 * 100

  const dib = rows.find((r) => r.ticker === 'DIB')!;
  assert.equal(dib.change, -0.1); // taken verbatim (present in payload)
  assert.equal(dib.changePct, -1.5152);
  assert.equal(dib.asOf, '2026-07-13T11:00:00.000Z');
});

test('DFM quotes: accepts a bare-array payload and lowercase field names', () => {
  const bare = [{ symbol: 'SALIK', price: '4.20', open: '4.10', volume: '1,000,000' }];
  const { rows } = dfmQuotes.parse(snap(Buffer.from(JSON.stringify(bare), 'utf8')));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ticker, 'SALIK');
  assert.equal(rows[0]!.last, 4.2);
  assert.equal(rows[0]!.volume, 1000000); // comma-stripped
});

test('DFM quotes: non-JSON body yields zero rows (PARSE_DRIFT), not a throw', () => {
  const { rows } = dfmQuotes.parse(snap(Buffer.from('<html>waf challenge</html>', 'utf8')));
  assert.equal(rows.length, 0);
});
