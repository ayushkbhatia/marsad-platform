/**
 * sources.seed.test.ts — unit tests for the ingest.sources / ingest.schedules seed.
 *
 * Zero dependencies: uses the Node built-in test runner (`node --test`, Node ≥22).
 * Run: `npm test` (package src test glob) or
 *      `tsx --test ingestion/src/config/sources.seed.test.ts`.
 *
 * Two jobs:
 *  1. Assert the seed's structural invariants against the CONTRACT §8 spec + the 0005 DDL CHECKs.
 *  2. Cross-check the TS mirror (sources.ts) against the SQL migration so they cannot drift —
 *     every (venue, data_type) pair, transport, cadence, session_only, and offset must match.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  SOURCE_SEED,
  VENUES,
  findSource,
  type SourceSeed,
  type VenueCode,
  type DataType,
  type Transport,
} from './sources.seed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  HERE,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '20260713000017_ingest_sources.sql',
);

const ALLOWED_TRANSPORT: readonly Transport[] = ['http', 'http_bootstrap', 'headless'];
const ALLOWED_RESPONSE_KIND = ['json', 'html', 'txt_json', 'xlsx', 'pdf'];
const ALLOWED_ROBOTS = ['allowed', 'disallowed', 'override'];
const EXPECTED_DATATYPES: readonly DataType[] = ['quotes', 'filings_list', 'eod_bulletin'];

// Expected transport per (venue, dataType) — recon ground truth (P1-recon-findings.md).
// TDWL + ADX are WAF'd → http_bootstrap for every row. DFM SPA-over-JSON → http_bootstrap.
// QE/BHB plain http. MSX quotes bootstrap (SPA+reCAPTCHA), filings/eod plain http.
const EXPECTED_TRANSPORT: Record<string, Transport> = {
  'TDWL/quotes': 'http_bootstrap',
  'TDWL/filings_list': 'http_bootstrap',
  'TDWL/eod_bulletin': 'http_bootstrap',
  'DFM/quotes': 'http_bootstrap',
  'DFM/filings_list': 'http_bootstrap',
  'DFM/eod_bulletin': 'http_bootstrap',
  'ADX/quotes': 'http_bootstrap',
  'ADX/filings_list': 'http_bootstrap',
  'ADX/eod_bulletin': 'http_bootstrap',
  'QE/quotes': 'http',
  'QE/filings_list': 'http',
  'QE/eod_bulletin': 'http',
  'MSX/quotes': 'http_bootstrap',
  'MSX/filings_list': 'http',
  'MSX/eod_bulletin': 'http',
  'BHB/quotes': 'http',
  'BHB/filings_list': 'http',
  'BHB/eod_bulletin': 'http',
};

const key = (s: SourceSeed) => `${s.venue}/${s.dataType}`;

test('every active venue has exactly quotes + filings_list + eod_bulletin', () => {
  for (const v of VENUES) {
    for (const dt of EXPECTED_DATATYPES) {
      assert.ok(findSource(v, dt), `missing seed row ${v}/${dt}`);
    }
  }
  // total rows = 6 venues × 3 data_types = 18, no extras.
  assert.equal(SOURCE_SEED.length, VENUES.length * EXPECTED_DATATYPES.length);
});

test('BK Kuwait (inactive) is NOT seeded — no ingestion for inactive venues', () => {
  assert.ok(!SOURCE_SEED.some((s) => (s.venue as string) === 'BK'));
});

test('(venue, dataType, entryUrl) natural key is unique (matches DDL unique constraint)', () => {
  const seen = new Set<string>();
  for (const s of SOURCE_SEED) {
    const k = `${s.venue}|${s.dataType}|${s.entryUrl}`;
    assert.ok(!seen.has(k), `duplicate natural key ${k}`);
    seen.add(k);
  }
});

test('transport is a valid CHECK value and matches recon ground truth', () => {
  for (const s of SOURCE_SEED) {
    assert.ok(ALLOWED_TRANSPORT.includes(s.transport), `bad transport ${s.transport} on ${key(s)}`);
    assert.equal(s.transport, EXPECTED_TRANSPORT[key(s)], `transport mismatch on ${key(s)}`);
  }
});

test('endpointConfig.responseKind + robotsStatus are valid enum values', () => {
  for (const s of SOURCE_SEED) {
    assert.ok(
      ALLOWED_RESPONSE_KIND.includes(s.endpointConfig.responseKind),
      `bad responseKind on ${key(s)}`,
    );
    assert.ok(ALLOWED_ROBOTS.includes(s.robotsStatus), `bad robotsStatus on ${key(s)}`);
  }
});

test('http_bootstrap rows carry actionDiscovery (runtime action/route scraping)', () => {
  for (const s of SOURCE_SEED) {
    if (s.transport === 'http_bootstrap') {
      assert.ok(
        s.endpointConfig.actionDiscovery,
        `${key(s)} is http_bootstrap but has no actionDiscovery`,
      );
      assert.equal(s.endpointConfig.actionDiscovery!.navigateUrl.length > 0, true);
    }
  }
});

test('no adapter-hardcoded portal action ids leak into a plain urlTemplate', () => {
  // The TDWL portal action id/PUID must be scraped at runtime, never a literal in urlTemplate.
  for (const s of SOURCE_SEED) {
    const tmpl = s.endpointConfig.urlTemplate ?? '';
    assert.ok(
      !/!ut\/p\/z1/.test(tmpl),
      `${key(s)} urlTemplate hardcodes a portal PUID path — must be discovered at runtime`,
    );
  }
});

test('cadence law: quotes 10min session-only; filings 5min; eod 60min; all not session-gated except quotes', () => {
  for (const s of SOURCE_SEED) {
    const sc = s.schedule;
    assert.ok(sc.active, `${key(s)} schedule inactive`);
    if (s.dataType === 'quotes') {
      assert.equal(sc.cadenceMinutes, 10, `${key(s)} quotes cadence`);
      assert.equal(sc.sessionOnly, true, `${key(s)} quotes must be session_only`);
    } else if (s.dataType === 'filings_list') {
      assert.equal(sc.cadenceMinutes, 5, `${key(s)} filings cadence`);
      assert.equal(sc.sessionOnly, false, `${key(s)} filings must not be session_only`);
    } else if (s.dataType === 'eod_bulletin') {
      assert.equal(sc.cadenceMinutes, 60, `${key(s)} eod cadence`);
      assert.equal(sc.sessionOnly, false, `${key(s)} eod must not be session_only`);
    }
  }
});

test('offset stagger is per-venue TDWL+0 DFM+1 ADX+2 QE+3 MSX+4 BHB+5', () => {
  const expected: Record<VenueCode, number> = {
    TDWL: 0,
    DFM: 1,
    ADX: 2,
    QE: 3,
    MSX: 4,
    BHB: 5,
  };
  for (const s of SOURCE_SEED) {
    assert.equal(
      s.schedule.offsetMinutes,
      expected[s.venue],
      `${key(s)} offset mismatch`,
    );
  }
});

test('QE quotes is the confirmed txt_json board (recon-confirmed endpoint)', () => {
  const qe = findSource('QE', 'quotes')!;
  assert.equal(qe.endpointConfig.responseKind, 'txt_json');
  assert.match(qe.endpointConfig.urlTemplate ?? '', /MarketWatch\.txt$/);
  assert.equal(qe.transport, 'http');
});

test('all eod_bulletin rows are xlsx responseKind (EOD source of record)', () => {
  for (const s of SOURCE_SEED.filter((r) => r.dataType === 'eod_bulletin')) {
    assert.equal(s.endpointConfig.responseKind, 'xlsx', `${key(s)} eod not xlsx`);
  }
});

// ---- drift guard: TS mirror ⇄ SQL migration ---------------------------------

test('SQL migration seeds the same 18 (venue, data_type) pairs as the TS mirror', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  for (const s of SOURCE_SEED) {
    // Each sources INSERT tuple begins with ('VENUE', 'data_type', — assert presence.
    const re = new RegExp(`\\(\\s*'${s.venue}'\\s*,\\s*'${s.dataType}'\\s*,`);
    assert.match(sql, re, `migration missing sources row ${key(s)}`);
  }
});

test('SQL migration schedule tuples match the TS cadence/session/offset for every source', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  for (const s of SOURCE_SEED) {
    const sc = s.schedule;
    // schedule VALUES rows look like: ('TDWL', 'quotes', 10, true, 0),
    const re = new RegExp(
      `\\(\\s*'${s.venue}'\\s*,\\s*'${s.dataType}'\\s*,\\s*${sc.cadenceMinutes}\\s*,\\s*${sc.sessionOnly}\\s*,\\s*${sc.offsetMinutes}\\s*\\)`,
    );
    assert.match(sql, re, `migration schedule mismatch for ${key(s)}`);
  }
});

test('SQL migration is idempotent (on conflict do nothing / not exists guards present)', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /on conflict\s*\(venue,\s*data_type,\s*entry_url\)\s*do nothing/i);
  assert.match(sql, /where not exists/i);
});
