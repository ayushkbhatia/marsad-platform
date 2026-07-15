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

// Live board shape captured from the VPS (2026-07-15): a POST to marketwatch.dfm.ae/dapi/fetch
// returns [{ id, command:'stocks', data:[ ...securities... ] }] with lowercase DFM keys and the
// ticker in `id`. locateRows() must unwrap the group envelope; the pickers must read the new keys.
const LIVE_BOARD = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    command: 'stocks',
    data: [
      {
        id: 'EMAARDEV',
        openingprice: 13.5,
        previousclosingprice: 13.52,
        lastradeprice: 13.58,
        highestprice: 13.7,
        lowestprice: 13.45,
        totalvolume: 1200000,
        netchange: 0.06,
        changepercentage: 0.444,
        bidprice: 13.57,
        offerprice: 13.59,
        highestin52weeks: 17.26,
        lowestin52weeks: 10.16,
      },
      { id: 'DU', openingprice: 12.12, previousclosingprice: 12.1, lastradeprice: 12.2, totalvolume: 300 },
    ],
  },
];

test('DFM quotes: unwraps the live dapi/fetch group envelope + lowercase keys', () => {
  const { rows } = dfmQuotes.parse(snap(Buffer.from(JSON.stringify(LIVE_BOARD), 'utf8')));
  assert.equal(rows.length, 2);

  const e = rows.find((r) => r.ticker === 'EMAARDEV')!;
  assert.equal(e.venue, 'DFM');
  assert.equal(e.last, 13.58);
  assert.equal(e.open, 13.5);
  assert.equal(e.high, 13.7);
  assert.equal(e.low, 13.45);
  assert.equal(e.volume, 1200000);
  assert.equal(e.change, 0.06); // netchange verbatim
  assert.equal(e.changePct, 0.444); // changepercentage verbatim
  assert.equal(e.bid, 13.57);
  assert.equal(e.ask, 13.59);
  assert.equal(e.week52High, 17.26);
  assert.equal(e.week52Low, 10.16);

  // DU has no netchange ⇒ derived from lastradeprice - previousclosingprice (12.2 - 12.1).
  const du = rows.find((r) => r.ticker === 'DU')!;
  assert.equal(du.change, 0.1);
});
