// Unit tests for the sector taxonomy mapper (07 §3.3). ZERO network.
//   node --import tsx --test src/lake/sector-taxonomy.test.ts
//
// Output vocabulary is public.sectors.key (securities.sector is a FK to sectors(key), verified live).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapSectorToTaxonomy, UNKNOWN_SECTOR, CANONICAL_SECTORS } from './sector-taxonomy.js';

// The 12 live public.sectors.key slugs — the taxonomy MUST only ever emit one of these (FK target).
const VALID_KEYS = new Set([...CANONICAL_SECTORS, UNKNOWN_SECTOR]);

test('banks/insurers keep the substrings the ratio engine regexes on', () => {
  // ratios-compute.ts sectorValidity uses /bank/i and /insur/i — the keys MUST match.
  assert.match(mapSectorToTaxonomy('Banks').sector, /bank/i);
  assert.match(mapSectorToTaxonomy('Insurance').sector, /insur/i);
});

test('bank wins over generic finance (order matters)', () => {
  assert.equal(mapSectorToTaxonomy('Commercial Banks').sector, 'banks');
  assert.equal(mapSectorToTaxonomy('Islamic Banking').sector, 'banks');
  assert.equal(mapSectorToTaxonomy('Takaful Insurance').sector, 'insurance');
  assert.equal(mapSectorToTaxonomy('Cooperative Insurance').sector, 'insurance');
});

test('GCC / GICS-ish venue strings map onto the sectors.key taxonomy', () => {
  const cases: Array<[string, string]> = [
    ['Real Estate Mgt & Dev’t', 'real_estate'],
    ['REITs', 'real_estate'],
    ['Energy', 'energy'],
    ['Oil & Gas', 'energy'],
    ['Materials', 'materials'],
    ['Petrochemicals', 'materials'],
    ['Utilities', 'utilities'],
    ['Telecommunication Services', 'telecom'],
    ['Health Care Equipment & Services', 'healthcare'],
    // TDWL IT filers (7200/7201/7202/7203/7211 share the first string, 9524 the second) — previously
    // fell to 'unknown' before the 'technology' key existed (migration 20260716190059).
    ['Information Technology | IT Services / Software', 'technology'],
    ['Information Technology | Electronic Equipment, Instruments and Components', 'technology'],
    ['Software & Services', 'technology'],
    ['Semiconductors & Semiconductor Equipment', 'technology'],
    ['Technology Hardware & Equipment', 'technology'],
    ['Capital Goods', 'industrials'],
    ['Transportation', 'industrials'],
    ['Commercial & Professional Services', 'industrials'],
    ['Food & Beverages', 'consumer'],
    ['Retailing', 'consumer'],
    ['Consumer Durables & Apparel', 'consumer'],
    ['Diversified Financials', 'financials'],
    ['Investment', 'financials'],
  ];
  for (const [raw, expected] of cases) {
    const m = mapSectorToTaxonomy(raw);
    assert.equal(m.sector, expected, `"${raw}" → ${m.sector} (expected ${expected})`);
    assert.equal(m.mapped, true, `"${raw}" should be mapped`);
    assert.equal(m.rawSector, raw);
    assert.ok(VALID_KEYS.has(m.sector), `${m.sector} must be a valid public.sectors.key`);
  }
});

test('technology ordering: biotech stays healthcare, IT wins over industrials/consumer', () => {
  // 'technology' sits AFTER healthcare so the shared 'technolog' stem never steals biotech.
  assert.equal(mapSectorToTaxonomy('Biotechnology').sector, 'healthcare');
  assert.equal(mapSectorToTaxonomy('Pharmaceuticals, Biotechnology & Life Sciences').sector, 'healthcare');
  // …and BEFORE industrials/consumer so IT strings resolve to technology, not the broad buckets.
  assert.equal(mapSectorToTaxonomy('IT Services / Software').sector, 'technology');
  assert.equal(mapSectorToTaxonomy('Electronic Equipment, Instruments & Components').sector, 'technology');
});

test('every mapped result is a valid public.sectors.key (FK safety)', () => {
  for (const raw of ['Banks', 'Oil', 'Zorble', '', 'Software & Services']) {
    assert.ok(VALID_KEYS.has(mapSectorToTaxonomy(raw).sector));
  }
});

test('unmappable string → unknown fallback (LOGGED, raw preserved) — never silent', () => {
  const m = mapSectorToTaxonomy('Zorble Widgets Inc');
  assert.equal(m.sector, UNKNOWN_SECTOR);
  assert.equal(m.mapped, false);
  assert.equal(m.rawSector, 'Zorble Widgets Inc'); // raw retained for audit + the caller logs it
});

test('blank/absent input → unknown with null rawSector', () => {
  for (const v of [null, undefined, '', '   ']) {
    const m = mapSectorToTaxonomy(v as string | null | undefined);
    assert.equal(m.sector, UNKNOWN_SECTOR);
    assert.equal(m.mapped, false);
    assert.equal(m.rawSector, null);
  }
});

test('case-insensitive + whitespace-tolerant matching', () => {
  assert.equal(mapSectorToTaxonomy('  ENERGY  ').sector, 'energy');
  assert.equal(mapSectorToTaxonomy('real   estate').sector, 'real_estate');
});
