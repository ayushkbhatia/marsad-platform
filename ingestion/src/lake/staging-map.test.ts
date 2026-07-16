/**
 * Unit tests for the ingestion→lake staging mapper (runtime.mapRowsToStaging, CONTRACT §6.5).
 *
 * These assert the properties cross-check depends on:
 *   - natural_key is deterministic + stable across re-maps (drives candidate gathering per key);
 *   - source_rank propagates from the source archetype (primary-wins ordering);
 *   - content_hash (the LakeStagingEmitter idempotency key) is deterministic — the SAME row
 *     re-mapped yields an identical hash — and is the sha256 of the canonicalized payload.
 *
 * The mapper itself does not compute content_hash (LakeStagingEmitter does, on insert, from
 * row.payload via lake/canonical.contentHash). So we assert the emitter's key by hashing each
 * mapped row's payload with the SAME helper — proving determinism/idempotency end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapRowsToStaging } from '../runtime.js';
import { contentHash } from './canonical.js';
import type {
  SourceRecord,
  NormalizedQuote,
  NormalizedOhlcv,
  NormalizedFiling,
  NormalizedFilingRef,
  NormalizedStatementRow,
  Logger,
  TaskSpec,
} from '../core/types.js';

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

// A TaskSpec is only used as an opaque marker by the mapper (it dispatches on row shape), so a
// minimal stub is enough.
const stubTask = { dataType: 'quotes', parserVersion: 1 } as unknown as TaskSpec<unknown>;

function source(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 42,
    venue: 'TDWL',
    dataType: 'quotes',
    entryUrl: 'https://saudiexchange.sa/market-watch',
    endpointConfig: { responseKind: 'json' },
    normalizeRules: [],
    transport: 'http_bootstrap',
    robotsStatus: 'allowed',
    active: true,
    lastContentHash: null,
    ...over,
  };
}

const SNAP_ID = 1001;
const SNAP_FETCHED_AT = '2026-07-13T13:05:00.000Z';

function quote(over: Partial<NormalizedQuote> = {}): NormalizedQuote {
  return {
    venue: 'TDWL',
    ticker: '2222',
    last: 27.35,
    change: 0.15,
    changePct: 0.55,
    open: 27.2,
    high: 27.5,
    low: 27.1,
    volume: 5_120_000,
    asOf: '2026-07-13T12:59:00.000Z',
    ...over,
  };
}

test('quote → QUOTE.LAST staging row: natural_key, numeric_value, rank, extracted_at', () => {
  const rows = mapRowsToStaging(source(), stubTask, SNAP_ID, [quote()], noopLogger, SNAP_FETCHED_AT);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.objectType, 'QUOTE.LAST');
  // venue+ticker+trade session (date part of asOf).
  assert.equal(r.naturalKey, 'QUOTE.LAST:TDWL:2222:2026-07-13');
  assert.equal(r.venue, 'TDWL');
  assert.equal(r.sourceId, 42);
  assert.equal(r.snapshotId, SNAP_ID);
  assert.equal(r.externalId, null); // quote boards dedupe on (source_id, NULL, content_hash)
  assert.equal(r.sourceRank, 20); // exchange archetype
  assert.equal(r.numericValue, 27.35); // = last
  assert.equal(r.effectiveDate, '2026-07-13');
  assert.equal(r.priceSensitive, false);
  assert.equal(r.extractedAt, '2026-07-13T12:59:00.000Z'); // the quote's own business time, not the clock
});

test('natural_key is STABLE across a re-map of the same row (deterministic)', () => {
  const q = quote();
  const a = mapRowsToStaging(source(), stubTask, SNAP_ID, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  const b = mapRowsToStaging(source(), stubTask, SNAP_ID, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  assert.equal(a.naturalKey, b.naturalKey);
  assert.equal(a.objectType, b.objectType);
});

test('content_hash is DETERMINISTIC + IDEMPOTENT: same row re-mapped ⇒ identical hash', () => {
  const q = quote();
  const first = mapRowsToStaging(source(), stubTask, SNAP_ID, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  // A retry: different snapshot id, but identical parsed payload.
  const retry = mapRowsToStaging(source(), stubTask, SNAP_ID + 7, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  const h1 = contentHash(first.payload);
  const h2 = contentHash(retry.payload);
  assert.equal(h1, h2, 'identical payload must hash identically (dedupe key)');
  // And the hash is the sha256 of the canonicalized payload (64 hex chars).
  assert.match(h1, /^[0-9a-f]{64}$/);
  // Key insensitive to object key order (canonicalization) — reordered clone hashes equal.
  const reordered: NormalizedQuote = {
    asOf: q.asOf, low: q.low, high: q.high, open: q.open,
    volume: q.volume, changePct: q.changePct, change: q.change,
    last: q.last, ticker: q.ticker, venue: q.venue,
  };
  assert.equal(contentHash(reordered), h1);
});

test('content_hash CHANGES when the payload changes (a genuine revision)', () => {
  const a = mapRowsToStaging(source(), stubTask, SNAP_ID, [quote({ last: 27.35 })], noopLogger, SNAP_FETCHED_AT)[0]!;
  const b = mapRowsToStaging(source(), stubTask, SNAP_ID, [quote({ last: 27.4 })], noopLogger, SNAP_FETCHED_AT)[0]!;
  assert.notEqual(contentHash(a.payload), contentHash(b.payload));
});

test('source_rank PROPAGATES the exchange archetype for every mapped shape', () => {
  const q = mapRowsToStaging(source(), stubTask, SNAP_ID, [quote()], noopLogger, SNAP_FETCHED_AT)[0]!;
  assert.equal(q.sourceRank, 20);
});

test('two independent sources for the same quote key ⇒ same natural_key, distinct source_id', () => {
  const q = quote();
  const s1 = mapRowsToStaging(source({ id: 1 }), stubTask, SNAP_ID, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  const s2 = mapRowsToStaging(source({ id: 2 }), stubTask, SNAP_ID, [q], noopLogger, SNAP_FETCHED_AT)[0]!;
  assert.equal(s1.naturalKey, s2.naturalKey); // cross-check gathers them together
  assert.notEqual(s1.sourceId, s2.sourceId); // and they are independent
  assert.equal(contentHash(s1.payload), contentHash(s2.payload)); // agreeing on the same value
});

test('EOD ohlcv → OHLCV.CLOSE keyed by venue+ticker+tradeDate; close is numeric_value', () => {
  const eodSource = source({ id: 7, dataType: 'eod_bulletin' });
  const ohlcv: NormalizedOhlcv = {
    venue: 'TDWL',
    ticker: '2222',
    tradeDate: '2026-07-13',
    open: 27.2,
    high: 27.5,
    low: 27.1,
    close: 27.35,
    volume: 5_120_000,
    valueTraded: 139_000_000,
  };
  const rows = mapRowsToStaging(eodSource, stubTask, SNAP_ID, [ohlcv], noopLogger, SNAP_FETCHED_AT);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.objectType, 'OHLCV.CLOSE');
  assert.equal(r.naturalKey, 'OHLCV.CLOSE:TDWL:2222:2026-07-13');
  assert.equal(r.numericValue, 27.35);
  assert.equal(r.effectiveDate, '2026-07-13');
  assert.equal(r.externalId, null);
  assert.equal(r.extractedAt, SNAP_FETCHED_AT); // OHLCV has no self-timestamp ⇒ snapshot fetch time
});

test('filing_detail → FILING.<TYPE> keyed by venue+externalId; price-sensitive for RESULTS', () => {
  const filingSource = source({ id: 9, venue: 'TDWL', dataType: 'filing_detail' });
  const filing: NormalizedFiling = {
    venue: 'TDWL',
    externalId: 'CG-1-2026-4471',
    sourceRef: 'CG-1-2026-4471',
    securityTicker: '2222',
    filingType: 'RESULTS',
    title: 'Q2 2026 interim financial results',
    filedAt: '2026-07-13T10:30:00.000Z',
  };
  const rows = mapRowsToStaging(filingSource, stubTask, SNAP_ID, [filing], noopLogger, SNAP_FETCHED_AT);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.objectType, 'FILING.RESULTS');
  assert.equal(r.naturalKey, 'FILING:TDWL:CG-1-2026-4471'); // identity = venue + external id
  assert.equal(r.externalId, 'CG-1-2026-4471'); // ⇒ dedupe/list-diff on the announcement id
  assert.equal(r.priceSensitive, true); // RESULTS is a 33b human-confirm fact
  assert.equal(r.effectiveDate, '2026-07-13'); // date part of filedAt
  assert.equal(r.extractedAt, '2026-07-13T10:30:00.000Z'); // filing's own filedAt
  // re-map ⇒ identical natural_key + payload hash (idempotent)
  const again = mapRowsToStaging(filingSource, stubTask, SNAP_ID, [filing], noopLogger, SNAP_FETCHED_AT)[0]!;
  assert.equal(again.naturalKey, r.naturalKey);
  assert.equal(contentHash(again.payload), contentHash(r.payload));
});

test('filings_list ref → FILING.REF keyed by venue+externalId; not misread as a detail filing', () => {
  const listSource = source({ id: 8, venue: 'TDWL', dataType: 'filings_list' });
  const ref: NormalizedFilingRef = {
    venue: 'TDWL',
    externalId: 'CG-1-2026-4471',
    sourceRef: 'CG-1-2026-4471',
    title: 'Board recommends interim dividend',
    filedAt: '2026-07-13T10:30:00.000Z',
    detailUrl: 'https://saudiexchange.sa/announcement/CG-1-2026-4471',
  };
  const rows = mapRowsToStaging(listSource, stubTask, SNAP_ID, [ref], noopLogger, SNAP_FETCHED_AT);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.objectType, 'FILING.REF'); // NOT FILING.<type> — the detail path owns that
  assert.equal(r.naturalKey, 'FILING.REF:TDWL:CG-1-2026-4471');
  assert.equal(r.externalId, 'CG-1-2026-4471');
  assert.equal(r.numericValue, null);
});

test('financials → FILING.FINANCIALS keyed by venue+ticker+statementType+basis+fiscalPeriod', () => {
  const finSource = source({ id: 11, venue: 'TDWL', dataType: 'financials' });
  const stmt: NormalizedStatementRow = {
    venue: 'TDWL',
    ticker: '2222',
    statementType: 'income',
    basis: 'consolidated',
    periodKind: 'annual',
    fiscalPeriod: 'FY2025',
    periodEnd: '2025-12-31',
    currency: 'SAR',
    lineItems: { revenue: 100, net_income: 40, total_assets: 2516431000 },
  };
  const rows = mapRowsToStaging(finSource, stubTask, SNAP_ID, [stmt], noopLogger, SNAP_FETCHED_AT);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.objectType, 'FILING.FINANCIALS');
  assert.equal(r.naturalKey, 'FILING.FINANCIALS:TDWL:2222:income:consolidated:FY2025');
  assert.equal(r.externalId, null); // no per-row id ⇒ dedupe on (source_id, NULL, content_hash)
  assert.equal(r.numericValue, null); // a period is a bag of line items, not one scalar
  assert.equal(r.unit, 'SAR');
  assert.equal(r.effectiveDate, '2025-12-31'); // period_end
  assert.equal(r.priceSensitive, false); // bulk facts, not a 33b human-confirm gate
  assert.equal(r.extractedAt, SNAP_FETCHED_AT); // no self-timestamp ⇒ snapshot fetch time
  // WIRE CONTRACT: payload is SNAKE_CASE (what lake.fn_financials_project reads) + carries
  // venue/ticker for security_id resolution — NOT the camelCase NormalizedStatementRow fields.
  const p = r.payload as Record<string, unknown>;
  assert.equal(p.statement_type, 'income');
  assert.equal(p.period_kind, 'annual');
  assert.equal(p.fiscal_period, 'FY2025');
  assert.equal(p.period_end, '2025-12-31');
  assert.equal(p.venue, 'TDWL');
  assert.equal(p.ticker, '2222');
  assert.deepEqual(p.line_items, { revenue: 100, net_income: 40, total_assets: 2516431000 });
  assert.equal(p.statementType, undefined); // no camelCase leakage
  // A RESTATEMENT (same period, changed numbers) keys IDENTICALLY but hashes differently —
  // the whole mechanism the versioning projection keys off.
  const restated = mapRowsToStaging(
    finSource, stubTask, SNAP_ID + 1,
    [{ ...stmt, lineItems: { ...stmt.lineItems, net_income: 41 } }],
    noopLogger, SNAP_FETCHED_AT,
  )[0]!;
  assert.equal(restated.naturalKey, r.naturalKey); // same object key
  assert.notEqual(contentHash(restated.payload), contentHash(r.payload)); // distinct content ⇒ new revision
});

test('empty batch ⇒ no rows; unknown shape ⇒ dropped, none fabricated', () => {
  assert.deepEqual(mapRowsToStaging(source(), stubTask, SNAP_ID, [], noopLogger, SNAP_FETCHED_AT), []);
  const junk = [{ foo: 'bar', baz: 1 }];
  assert.deepEqual(mapRowsToStaging(source(), stubTask, SNAP_ID, junk, noopLogger, SNAP_FETCHED_AT), []);
});
