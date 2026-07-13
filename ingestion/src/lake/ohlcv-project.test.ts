import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedOhlcvToDailyRow,
  mapOhlcvBatch,
  projectOhlcvDaily,
  type OhlcvDailyRow,
} from './ohlcv-project.js';
import type { LakeSql, LakeTx } from './db.js';
import type { NormalizedOhlcv } from './contract-types.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function bar(partial: Partial<NormalizedOhlcv> & { tradeDate: string; close: number }): NormalizedOhlcv {
  return {
    venue: 'TDWL',
    ticker: '2222',
    open: 1,
    high: 2,
    low: 0.5,
    volume: 100,
    ...partial,
  };
}

/**
 * Minimal in-memory ohlcv_daily upsert fake: recognizes exactly the one INSERT …
 * ON CONFLICT (security_id, trade_date) DO UPDATE the writer issues, and enforces
 * the PK the real DDL enforces (one row per (security_id, trade_date), last write
 * wins the O/H/L/V/value_traded fields). Lets us assert idempotency without a DB.
 */
function makeFake(): { sql: LakeSql; table: Map<string, OhlcvDailyRow> } {
  const table = new Map<string, OhlcvDailyRow>();
  const run = async (strings: TemplateStringsArray, params: unknown[]): Promise<Record<string, unknown>[]> => {
    const text = strings.join('?');
    if (text.includes('insert into public.ohlcv_daily')) {
      const [securityId, tradeDate, open, high, low, close, volume, valueTraded] = params as [
        number, string, number | null, number | null, number | null, number, number | null, number | null,
      ];
      // enforce NOT NULL on close (the real DDL would reject a null close)
      assert.notEqual(close, null, 'close must not be null at the DB layer');
      table.set(`${securityId}:${tradeDate}`, { securityId, tradeDate, open, high, low, close, volume, valueTraded });
      return [];
    }
    throw new Error(`fake ohlcv_daily: unrecognized query: ${text.slice(0, 80)}`);
  };
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    run(strings, params)) as unknown as LakeSql;
  (sql as unknown as { begin: LakeSql['begin'] }).begin = async <T>(fn: (tx: LakeTx) => Promise<T>) =>
    fn(sql as unknown as LakeTx);
  return { sql, table };
}

// ── pure mapping ─────────────────────────────────────────────────────────────

test('maps a full bar to an ohlcv_daily row with resolved security_id', () => {
  const r = normalizedOhlcvToDailyRow(bar({ tradeDate: '2026-07-13', close: 27.35, valueTraded: 999 }), 42);
  assert.deepEqual(r, {
    securityId: 42,
    tradeDate: '2026-07-13',
    open: 1,
    high: 2,
    low: 0.5,
    close: 27.35,
    volume: 100,
    valueTraded: 999,
  });
});

test('drops a bar with no resolvable security_id (FK would fail)', () => {
  assert.equal(normalizedOhlcvToDailyRow(bar({ tradeDate: '2026-07-13', close: 10 }), null), null);
  assert.equal(normalizedOhlcvToDailyRow(bar({ tradeDate: '2026-07-13', close: 10 }), undefined), null);
});

test('drops a null / non-finite close bar (close is NOT NULL in ohlcv_daily)', () => {
  assert.equal(normalizedOhlcvToDailyRow(bar({ tradeDate: '2026-07-13', close: NaN }), 1), null);
  // simulate a malformed upstream row where close arrived as null despite the type
  const malformed = bar({ tradeDate: '2026-07-13', close: 1 });
  (malformed as { close: number | null }).close = null;
  assert.equal(normalizedOhlcvToDailyRow(malformed, 1), null);
});

test('missing open/high/low/volume/value_traded become null, not dropped', () => {
  const o: NormalizedOhlcv = { venue: 'QE', ticker: 'QNBK', tradeDate: '2026-07-13', close: 16.2 };
  const r = normalizedOhlcvToDailyRow(o, 7);
  assert.deepEqual(r, {
    securityId: 7, tradeDate: '2026-07-13', open: null, high: null, low: null,
    close: 16.2, volume: null, valueTraded: null,
  });
});

test('genuine zeros survive the finite guard', () => {
  const r = normalizedOhlcvToDailyRow(bar({ tradeDate: '2026-07-13', close: 5, volume: 0, low: 0 }), 1);
  assert.equal(r?.volume, 0);
  assert.equal(r?.low, 0);
});

// ── batch mapping + strictly-increasing dates (Yahoo backfill shape) ──────────

test('batch maps and preserves strictly-increasing trade dates; unresolved tickers dropped', () => {
  const rows: NormalizedOhlcv[] = [
    bar({ tradeDate: '2026-07-10', close: 25 }),
    bar({ tradeDate: '2026-07-11', close: 26 }),
    bar({ ticker: 'UNLISTED', tradeDate: '2026-07-12', close: 99 }),
    bar({ tradeDate: '2026-07-13', close: 27 }),
  ];
  const resolve = (_v: string, ticker: string) => (ticker === '2222' ? 42 : null);
  const mapped = mapOhlcvBatch(rows, resolve);
  assert.equal(mapped.length, 3); // UNLISTED dropped
  const dates = mapped.map((r) => r.tradeDate);
  assert.deepEqual(dates, ['2026-07-10', '2026-07-11', '2026-07-13']);
  // strictly increasing
  for (let i = 1; i < dates.length; i++) assert.ok(dates[i]! > dates[i - 1]!, 'dates strictly increasing');
});

// ── idempotent upsert ────────────────────────────────────────────────────────

test('projectOhlcvDaily upserts one row per (security_id, trade_date)', async () => {
  const fake = makeFake();
  const rows = mapOhlcvBatch(
    [bar({ tradeDate: '2026-07-10', close: 25 }), bar({ tradeDate: '2026-07-11', close: 26 })],
    () => 42,
  );
  const n = await projectOhlcvDaily(fake.sql, rows);
  assert.equal(n, 2);
  assert.equal(fake.table.size, 2);
});

test('re-running the same batch is idempotent (no duplicate rows)', async () => {
  const fake = makeFake();
  const rows = mapOhlcvBatch([bar({ tradeDate: '2026-07-10', close: 25 })], () => 42);
  await projectOhlcvDaily(fake.sql, rows);
  await projectOhlcvDaily(fake.sql, rows); // replay
  assert.equal(fake.table.size, 1, 'PK (security_id, trade_date) collapses the replay');
});

test('a later higher-fidelity source overwrites the same bar (last write wins O/H/L/V)', async () => {
  const fake = makeFake();
  // Yahoo bar first (no value_traded)
  await projectOhlcvDaily(fake.sql, mapOhlcvBatch([bar({ tradeDate: '2026-07-10', close: 25, valueTraded: null })], () => 42));
  // venue bulletin later, same day, carries value_traded and a corrected close
  await projectOhlcvDaily(fake.sql, mapOhlcvBatch([bar({ tradeDate: '2026-07-10', close: 25.1, valueTraded: 500_000 })], () => 42));
  assert.equal(fake.table.size, 1);
  const row = fake.table.get('42:2026-07-10')!;
  assert.equal(row.close, 25.1);
  assert.equal(row.valueTraded, 500_000);
});

test('empty batch writes nothing', async () => {
  const fake = makeFake();
  assert.equal(await projectOhlcvDaily(fake.sql, []), 0);
  assert.equal(fake.table.size, 0);
});
