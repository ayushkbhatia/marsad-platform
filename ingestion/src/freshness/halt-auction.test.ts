import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectSecurityStates, deriveVenueOverride } from './halt-auction.js';
import type { BoardRow } from './halt-auction.js';

const rows = (r: BoardRow[]) => r;

test('halt detected from board status token', () => {
  const facts = detectSecurityStates({
    venue: 'TDWL',
    rows: rows([
      { ticker: '2222' },
      { ticker: '1120', boardStatus: 'HALTED' },
      { ticker: '7010', boardStatus: 'suspended' }, // case-insensitive
    ]),
  });
  const halted = facts.filter((f) => f.state === 'halted').map((f) => f.ticker);
  assert.deepEqual(halted.sort(), ['1120', '7010']);
});

test('unknown status token is not a halt', () => {
  const facts = detectSecurityStates({
    venue: 'QE',
    rows: rows([{ ticker: 'QNBK', boardStatus: 'NORMAL' }]),
  });
  assert.equal(facts.length, 0);
});

test('extra venue-specific halt token honored', () => {
  const facts = detectSecurityStates(
    { venue: 'MSX', rows: rows([{ ticker: 'BKMB', boardStatus: 'SUSP' }]) },
    { extraHaltTokens: ['SUSP'] },
  );
  assert.equal(facts[0]?.state, 'halted');
});

test('auction derived from session window; halt still beats auction', () => {
  const facts = detectSecurityStates({
    venue: 'ADX',
    rows: rows([
      { ticker: 'FAB', hasIndicativePrice: true },
      { ticker: 'ADCB', boardStatus: 'HALTED' }, // halted overrides auction
    ]),
    auctionWindow: { kind: 'pre_open', resumeAt: '2026-07-13T06:00:00Z' },
  });
  const byTicker = Object.fromEntries(facts.map((f) => [f.ticker, f.state]));
  assert.equal(byTicker['FAB'], 'auction');
  assert.equal(byTicker['ADCB'], 'halted');
  // auction fact carries resumeAt from the window
  assert.equal(facts.find((f) => f.ticker === 'FAB')?.resumeAt, '2026-07-13T06:00:00Z');
});

test('no auction window ⇒ no auction facts', () => {
  const facts = detectSecurityStates({
    venue: 'DFM',
    rows: rows([{ ticker: 'EMAAR', hasIndicativePrice: true }]),
    auctionWindow: null,
  });
  assert.equal(facts.length, 0);
});

test('stale: present-before, absent-now', () => {
  const facts = detectSecurityStates({
    venue: 'BHB',
    rows: rows([{ ticker: 'AUB' }, { ticker: 'BATELCO' }]),
    previousTickers: ['AUB', 'BATELCO', 'GFH'], // GFH vanished
  });
  const stale = facts.filter((f) => f.state === 'stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.ticker, 'GFH');
});

test('no previous board ⇒ no stale detection (first snapshot of session)', () => {
  const facts = detectSecurityStates({
    venue: 'BHB',
    rows: rows([{ ticker: 'AUB' }]),
    previousTickers: [],
  });
  assert.equal(facts.length, 0);
});

test('deriveVenueOverride: market-wide halt > auction > none', () => {
  assert.equal(deriveVenueOverride({ marketWideHalt: true }), 'halted');
  assert.equal(deriveVenueOverride({ auctionWindow: { kind: 'pre_close' } }), 'auction');
  assert.equal(deriveVenueOverride({}), null);
});
