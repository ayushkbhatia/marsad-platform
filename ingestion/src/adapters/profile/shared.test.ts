// Golden + unit tests for the config-driven profile parser (07 §3.3/§P1.7e-I). ZERO network.
//   node --import tsx --test src/adapters/profile/shared.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapProfileDoc,
  parseProfileDoc,
  profileShares,
  type ProfileFieldMap,
} from './shared.js';
import type { StoredSnapshot } from '../../core/types.js';

// A synthetic ADX-style nested company doc (Next.js SSR shape) exercising rowsPath + nested paths.
const ADX_DOC = {
  pageProps: {
    overview: {
      companySymbol: 'ALDAR',
      sectorNameEn: 'Real Estate',
      subSectorNameEn: 'Real Estate Mgt & Dev’t',
      isin: 'AEA002401019',
      numberOfShares: '7,862,626,657',
    },
  },
};
const ADX_MAP: ProfileFieldMap = {
  rowsPath: 'pageProps.overview',
  sector: 'sectorNameEn',
  industry: 'subSectorNameEn',
  isin: 'isin',
  shares: 'numberOfShares',
  symbol: 'companySymbol',
};

function snapshot(body: unknown, meta: Record<string, unknown>): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: (meta.venue as StoredSnapshot['venue']) ?? 'ADX',
    dataType: 'securities_profile',
    contentType: 'application/json',
    externalId: (meta.ticker as string) ?? null,
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'),
    fetchedAt: '2026-07-16T10:00:00.000Z',
    meta,
  };
}

test('mapProfileDoc: nested doc → sector(taxonomy key) + isin + shares', () => {
  const p = mapProfileDoc(ADX_DOC, ADX_MAP, 'ADX', 'ALDAR');
  assert.ok(p);
  assert.equal(p!.venue, 'ADX');
  assert.equal(p!.ticker, 'ALDAR');
  assert.equal(p!.sector, 'real_estate'); // taxonomy-mapped to public.sectors.key
  assert.equal(p!.rawSector, 'Real Estate'); // original preserved
  assert.equal(p!.isin, 'AEA002401019');
  assert.equal(p!.sharesOutstanding, 7_862_626_657); // comma-grouped string parsed
  assert.equal(p!.industry, 'Real Estate Mgt & Dev’t');
});

test('parseProfileDoc: end-to-end from snapshot bytes + meta.profileFieldMap', () => {
  const snap = snapshot(ADX_DOC, { venue: 'ADX', ticker: 'ALDAR', profileFieldMap: ADX_MAP });
  const { rows } = parseProfileDoc(snap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sector, 'real_estate');
  assert.equal(rows[0]!.sharesOutstanding, 7_862_626_657);
});

test('flat doc (rowsPath="") + unmappable sector → unknown key, raw kept, still stages', () => {
  const flat = { Symbol: 'XYZ', Sector: 'Miscellaneous Widgets', ISIN: 'OM000001', ListedShares: 1000000 };
  const map: ProfileFieldMap = { rowsPath: '', sector: 'Sector', isin: 'ISIN', shares: 'ListedShares' };
  const p = mapProfileDoc(flat, map, 'MSX', 'XYZ');
  assert.ok(p);
  assert.equal(p!.sector, 'unknown'); // FK-valid fallback; the caller logs it (never silent)
  assert.equal(p!.rawSector, 'Miscellaneous Widgets');
  assert.equal(p!.isin, 'OM000001');
  assert.equal(p!.sharesOutstanding, 1_000_000);
});

test('bank sector keeps the /bank/ substring the ratio engine needs', () => {
  const doc = { Symbol: 'BKMB', Sector: 'Commercial Banks', ListedShares: 500 };
  const map: ProfileFieldMap = { rowsPath: '', sector: 'Sector', shares: 'ListedShares' };
  const p = mapProfileDoc(doc, map, 'MSX', 'BKMB');
  assert.match(p!.sector, /bank/i);
});

test('all-null profile (no sector/isin/shares recoverable) → 0 rows (never stage empty)', () => {
  const doc = { Symbol: 'NONE', somethingElse: 42 };
  const map: ProfileFieldMap = { rowsPath: '', sector: 'Sector', isin: 'ISIN', shares: 'ListedShares' };
  assert.equal(mapProfileDoc(doc, map, 'MSX', 'NONE'), null);
  const snap = snapshot(doc, { venue: 'MSX', ticker: 'NONE', profileFieldMap: map });
  assert.equal(parseProfileDoc(snap).rows.length, 0);
});

test('sharesMultiplier: shares reported in millions', () => {
  assert.equal(profileShares('1,234.5', 1_000_000), 1_234_500_000);
  assert.equal(profileShares(2000, 1), 2000);
  assert.equal(profileShares('0', 1), null); // a 0-share company is bad data, not a fact
  assert.equal(profileShares('', 1), null);
  assert.equal(profileShares('n/a', 1), null);
});

test('parseProfileDoc: unknown venue / non-JSON / blank ticker → 0 rows, no throw', () => {
  assert.equal(parseProfileDoc(snapshot(ADX_DOC, { venue: 'XX', ticker: 'A', profileFieldMap: ADX_MAP })).rows.length, 0);
  assert.equal(parseProfileDoc(snapshot('not json{', { venue: 'ADX', ticker: 'A', profileFieldMap: ADX_MAP })).rows.length, 0);
  assert.equal(parseProfileDoc(snapshot(ADX_DOC, { venue: 'ADX', ticker: '', profileFieldMap: ADX_MAP })).rows.length, 0);
});
