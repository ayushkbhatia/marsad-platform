import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoresRecompute, StaleKeyRatiosError } from './scores.js';
import type { LakeSql, LakeTx, Row } from './db.js';

/**
 * Purpose-built in-memory fake for the Score batch (the shared fake-db does not
 * model securities.sector / score_eligible_from / the quote 52-week band). It
 * recognizes exactly the queries ScoresRecompute issues and enforces the
 * one-live-per-natural-key + PENDING→VERIFIED→RETIRED discipline the real DDL
 * enforces, so a lineage/supersede regression fails here too.
 */
interface SecurityRec {
  id: string;
  venue_code: string;
  sector: string;
  status: string;
  score_eligible_from: string | null;
}
interface KeyRatiosRec {
  security_id: string;
  computed_at: string; // ISO
  cols: Record<string, number | null>;
}
interface QuoteRec {
  security_id: string;
  last: number | null;
  week52_high: number | null;
  week52_low: number | null;
}
interface HistoryRec {
  security_id: string;
  computed_on: string; // YYYY-MM-DD
  score: number;
  rating: string;
  grades: Record<string, string | null>;
  sector_percentile: number | null;
}
interface ObjectRec {
  id: string;
  object_type: string;
  natural_key: string;
  state: string;
  revision: number;
  numeric_value: string | null;
  verified_by: string | null;
  superseded_by: string | null;
  payload: unknown;
}
interface EventRec {
  security_id: string;
  event_kind: string;
  old_value: string | null;
  new_value: string | null;
  detail: unknown;
}

interface State {
  securities: SecurityRec[];
  keyRatios: Map<string, KeyRatiosRec>;
  quotes: Map<string, QuoteRec>;
  history: HistoryRec[];
  scores: Map<string, Row>;
  objects: ObjectRec[];
  events: EventRec[];
  freshOverride: boolean | null; // null ⇒ derive from computed_at; else forced
}

function newState(): State {
  return {
    securities: [],
    keyRatios: new Map(),
    quotes: new Map(),
    history: [],
    scores: new Map(),
    objects: [],
    events: [],
    freshOverride: null,
  };
}

let uuidSeq = 1;
let idSeq = 1;

function createFakeDb(state: State): LakeSql {
  const run = makeRunner(state);
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeSql;
  sql.begin = async <T>(fn: (tx: LakeTx) => Promise<T>): Promise<T> => {
    const tx = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeTx;
    return fn(tx);
  };
  return sql;
}

function makeRunner(state: State) {
  return async function run(strings: TemplateStringsArray, params: unknown[]): Promise<Row[]> {
    const q = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();

    if (q.includes('from iam.principals where handle')) {
      const handle = params[0] as string;
      return handle === 'SYSTEM' ? [{ id: 'sys-0000' }] : [];
    }
    if (q.includes('select gen_random_uuid() as id')) {
      return [{ id: `uuid-${String(uuidSeq++).padStart(4, '0')}` }];
    }

    // ── freshness gate ──────────────────────────────────────────────────────
    if (q.includes('as stale') && q.includes('from public.key_ratios')) {
      if (state.freshOverride !== null) return [{ stale: !state.freshOverride }];
      // Default: fresh iff any key_ratios computed_at is "today" (we stamp fresh).
      const anyStale = [...state.keyRatios.values()].some((k) => k.computed_at === 'STALE');
      return [{ stale: state.keyRatios.size > 0 && anyStale }];
    }

    // ── universe load ───────────────────────────────────────────────────────
    if (q.includes('from public.securities s') && q.includes('join public.key_ratios k')) {
      let secs = state.securities.filter(
        (s) => s.status === 'listed' && state.keyRatios.has(s.id),
      );
      // score_eligible_from gate: null OR <= today. Fake treats a non-null future
      // date string 'FUTURE' as not-yet-eligible.
      secs = secs.filter((s) => s.score_eligible_from === null || s.score_eligible_from !== 'FUTURE');
      if (q.includes('s.id = any')) {
        const ids = (params[0] as number[]).map(String);
        secs = secs.filter((s) => ids.includes(s.id));
      }
      return secs
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((s) => {
          const k = state.keyRatios.get(s.id)!;
          const qr = state.quotes.get(s.id);
          const col = (name: string) => (k.cols[name] ?? null);
          return {
            id: s.id,
            venue_code: s.venue_code,
            sector: s.sector,
            market_cap: str(col('market_cap')),
            pe: str(col('pe')),
            pb: str(col('pb')),
            eps_ttm: str(col('eps_ttm')),
            dividend_yield: str(col('dividend_yield')),
            ev_ebitda: str(col('ev_ebitda')),
            roe: str(col('roe')),
            roce: str(col('roce')),
            nim: str(col('nim')),
            net_margin: str(col('net_margin')),
            gross_margin: str(col('gross_margin')),
            rev_growth_yoy: str(col('rev_growth_yoy')),
            eps_growth_yoy: str(col('eps_growth_yoy')),
            rev_cagr_3y: str(col('rev_cagr_3y')),
            eps_cagr_3y: str(col('eps_cagr_3y')),
            ret_3m: str(col('ret_3m')),
            ret_6m: str(col('ret_6m')),
            ret_12_1: str(col('ret_12_1')),
            last: qr ? str(qr.last) : null,
            week52_high: qr ? str(qr.week52_high) : null,
            week52_low: qr ? str(qr.week52_low) : null,
          };
        });
    }

    // ── lake.parse_runs ─────────────────────────────────────────────────────
    if (q.includes('insert into lake.parse_runs')) {
      return [{ id: String(idSeq++) }];
    }
    if (q.includes('update lake.parse_runs set status')) return [];

    // ── lake.objects live lookup ────────────────────────────────────────────
    if (q.includes('from lake.objects') && q.includes('superseded_by is null') && q.includes('natural_key =')) {
      const naturalKey = params[0] as string;
      const live = state.objects.find((o) => o.natural_key === naturalKey && o.superseded_by === null);
      return live ? [{ id: live.id, state: live.state, revision: live.revision }] : [];
    }
    if (q.includes('insert into lake.objects')) return insertObject(state, q, params);
    if (q.includes('update lake.objects')) return updateObject(state, q, params);

    // ── prior score (yesterday) ─────────────────────────────────────────────
    if (q.includes('from public.score_history') && q.includes('computed_on < current_date')) {
      const secId = params[0] as string;
      const prior = state.history
        .filter((h) => h.security_id === secId && h.computed_on !== 'TODAY')
        .sort((a, b) => (a.computed_on < b.computed_on ? 1 : -1))[0];
      return prior
        ? [{ security_id: prior.security_id, score: prior.score, rating: prior.rating, grades: prior.grades }]
        : [];
    }
    // ── week-ago score ──────────────────────────────────────────────────────
    if (q.includes('from public.score_history') && q.includes('current_date - 7')) {
      const secId = params[0] as string;
      const wa = state.history
        .filter((h) => h.security_id === secId && h.computed_on === 'WEEKAGO')
        .sort((a, b) => (a.computed_on < b.computed_on ? 1 : -1))[0];
      return wa ? [{ score: wa.score }] : [];
    }

    // ── scores upsert ───────────────────────────────────────────────────────
    if (q.includes('insert into public.scores')) {
      const secId = params[0] as string;
      state.scores.set(secId, {
        security_id: secId,
        score: params[1],
        rating: params[2],
        weekly_delta: params[3],
        grade_value: params[4],
        grade_growth: params[5],
        grade_profitability: params[6],
        grade_momentum: params[7],
        grade_revisions: params[8],
        sector_percentile: params[9],
        sector_peer_count: params[10],
        source_object_id: params[params.length - 1],
      });
      return [];
    }

    // ── score_history upsert ────────────────────────────────────────────────
    if (q.includes('insert into public.score_history')) {
      const secId = params[0] as string;
      const existing = state.history.find((h) => h.security_id === secId && h.computed_on === 'TODAY');
      const rec: HistoryRec = {
        security_id: secId,
        computed_on: 'TODAY',
        score: params[1] as number,
        rating: params[2] as string,
        grades: params[3] as Record<string, string | null>,
        sector_percentile: params[4] as number | null,
      };
      if (existing) Object.assign(existing, rec);
      else state.history.push(rec);
      return [];
    }

    // ── score_events insert ─────────────────────────────────────────────────
    if (q.includes('insert into public.score_events')) {
      state.events.push({
        security_id: params[0] as string,
        event_kind: params[1] as string,
        old_value: (params[2] as string | null) ?? null,
        new_value: (params[3] as string | null) ?? null,
        detail: params[4],
      });
      return [];
    }

    throw new Error(`fake-db(scores): unrecognized query: ${q.slice(0, 140)}`);
  };
}

function insertObject(state: State, q: string, params: unknown[]): Row[] {
  const hasId = /insert into lake\.objects \( ?id,/.test(q);
  let p = [...params];
  let id: string;
  if (hasId) id = p.shift() as string;
  else id = `uuid-${String(uuidSeq++).padStart(4, '0')}`;
  const objectType = p[0] as string;
  const naturalKey = p[1] as string;
  const payload = p[4];
  const numericValue = p[5] == null ? null : String(p[5]);
  // COMPUTED shape: (…, numeric_value, state, revision, parse_run_id, source_rank)
  const state_ = p[6] as string;
  const revision = p[7] as number;

  const live = state.objects.filter((o) => o.natural_key === naturalKey && o.superseded_by === null);
  if (live.length > 0) throw new Error(`fake-db: live-unique violation for ${naturalKey}`);
  state.objects.push({
    id, object_type: objectType, natural_key: naturalKey, state: state_, revision,
    numeric_value: numericValue, verified_by: null, superseded_by: null, payload,
  });
  return [{ id }];
}

function updateObject(state: State, q: string, params: unknown[]): Row[] {
  if (q.includes("set state = 'verified'")) {
    const verifiedBy = params[0] as string;
    const id = params[1] as string;
    const o = state.objects.find((x) => x.id === id)!;
    if (o.state !== 'PENDING') throw new Error(`illegal transition ${o.state}->VERIFIED`);
    o.state = 'VERIFIED';
    o.verified_by = verifiedBy;
    return [];
  }
  if (q.includes('set superseded_by =') && q.includes("state = 'retired'")) {
    const newId = params[0] as string;
    const id = params[1] as string;
    const o = state.objects.find((x) => x.id === id)!;
    if (o.state !== 'VERIFIED') throw new Error(`illegal transition ${o.state}->RETIRED`);
    o.superseded_by = newId;
    o.state = 'RETIRED';
    return [];
  }
  return [];
}

function str(v: number | null): string | null {
  return v === null ? null : String(v);
}

// ── test fixtures ───────────────────────────────────────────────────────────

/** A full key_ratios column set for one security, positioned at cohort fraction t. */
function ratioCols(t: number): Record<string, number | null> {
  return {
    market_cap: 1_000_000,
    pe: 20 - t * 10,
    pb: 3 - t * 2,
    eps_ttm: 2 + t * 2, // ⇒ E/P via eps/last
    dividend_yield: 0.01 + t * 0.05,
    ev_ebitda: 14 - t * 8,
    roe: 0.05 + t * 0.2,
    roce: 0.04 + t * 0.16,
    nim: null,
    net_margin: 0.05 + t * 0.25,
    gross_margin: 0.2 + t * 0.3,
    rev_growth_yoy: -0.02 + t * 0.2,
    eps_growth_yoy: -0.05 + t * 0.3,
    rev_cagr_3y: t * 0.15,
    eps_cagr_3y: t * 0.2,
    ret_3m: -0.03 + t * 0.15,
    ret_6m: -0.05 + t * 0.25,
    ret_12_1: -0.1 + t * 0.4,
  };
}

/** Seed n listed, score-eligible securities with fresh key_ratios + quotes. */
function seedCohort(state: State, n: number): void {
  for (let i = 0; i < n; i += 1) {
    const id = String(5000 + i);
    const t = i / (n - 1);
    state.securities.push({ id, venue_code: 'TDWL', sector: 'energy', status: 'listed', score_eligible_from: null });
    state.keyRatios.set(id, { security_id: id, computed_at: 'FRESH', cols: ratioCols(t) });
    state.quotes.set(id, { security_id: id, last: 40 + t * 20, week52_high: 60, week52_low: 40 });
  }
}

test('score_batch scores an eligible cohort and writes VERIFIED COMPUTED.SCORE objects with lineage', async () => {
  const state = newState();
  seedCohort(state, 9);

  const summary = await new ScoresRecompute(createFakeDb(state)).run();
  assert.equal(summary.scored, 9);
  assert.equal(summary.considered, 9);
  assert.equal(summary.aborted, false);

  // Every scored name has a public.scores row carrying lineage to its object.
  assert.equal(state.scores.size, 9);
  for (const [, row] of state.scores) {
    assert.ok(row.source_object_id, 'scores row carries lineage');
    assert.match(row.rating as string, /^(BUY|OVERWEIGHT|HOLD|UNDERWEIGHT|SELL)$/);
  }
  // One live VERIFIED COMPUTED.SCORE object per name, numeric_value = score.
  const live = state.objects.filter((o) => o.object_type === 'COMPUTED.SCORE' && o.superseded_by === null);
  assert.equal(live.length, 9);
  for (const o of live) {
    assert.equal(o.state, 'VERIFIED');
    assert.equal(o.verified_by, 'sys-0000');
  }
  // score_history gets today's row per name.
  assert.equal(state.history.filter((h) => h.computed_on === 'TODAY').length, 9);
});

test('empty universe (no key_ratios) returns scored:0 and does NOT crash or abort', async () => {
  const state = newState();
  // securities exist but no key_ratios rows → universe is empty.
  state.securities.push({ id: '1', venue_code: 'TDWL', sector: 'energy', status: 'listed', score_eligible_from: null });

  const summary = await new ScoresRecompute(createFakeDb(state)).run();
  assert.equal(summary.scored, 0);
  assert.equal(summary.considered, 0);
  assert.equal(summary.aborted, false);
  assert.equal(state.objects.length, 0);
  assert.equal(state.scores.size, 0);
});

test('freshness gate aborts on stale key_ratios rather than scoring', async () => {
  const state = newState();
  seedCohort(state, 9);
  // Mark ratios stale.
  for (const [, k] of state.keyRatios) k.computed_at = 'STALE';

  await assert.rejects(
    () => new ScoresRecompute(createFakeDb(state)).run(),
    (err: unknown) => err instanceof StaleKeyRatiosError,
  );
  // Nothing was written.
  assert.equal(state.scores.size, 0);
  assert.equal(state.objects.length, 0);
});

test('second run supersedes the prior COMPUTED.SCORE object (one live per key)', async () => {
  const state = newState();
  seedCohort(state, 9);
  const run = () => new ScoresRecompute(createFakeDb(state)).run();

  await run();
  const firstLive = state.objects.filter((o) => o.superseded_by === null);
  assert.equal(firstLive.length, 9);
  assert.equal(firstLive[0]!.revision, 1);

  await run();
  const live = state.objects.filter((o) => o.object_type === 'COMPUTED.SCORE' && o.superseded_by === null);
  assert.equal(live.length, 9, 'still exactly one live object per name');
  assert.ok(live.every((o) => o.revision === 2), 'live objects bumped to revision 2');
  const retired = state.objects.filter((o) => o.state === 'RETIRED');
  assert.equal(retired.length, 9, 'the first-run objects were retired');
});

test('diff vs yesterday emits score/rating/grade change events', async () => {
  const state = newState();
  seedCohort(state, 9);
  // Plant a yesterday history row for one name that differs from what it will score.
  const target = '5008'; // the strongest name → high score today
  state.history.push({
    security_id: target,
    computed_on: 'YESTERDAY',
    score: 10,
    rating: 'SELL',
    grades: { value: 'D', growth: 'D', profitability: 'D', momentum: 'D', revisions: null },
    sector_percentile: 5,
  });

  await new ScoresRecompute(createFakeDb(state)).run();

  const evs = state.events.filter((e) => e.security_id === target);
  assert.ok(evs.some((e) => e.event_kind === 'score_change'), 'a score_change event fired');
  assert.ok(evs.some((e) => e.event_kind === 'rating_change'), 'a rating_change event fired');
  assert.ok(evs.some((e) => e.event_kind === 'grade_change'), 'at least one grade_change event fired');

  // A name with no prior history emits NO events (a first score is not a change).
  const noPrior = state.events.filter((e) => e.security_id === '5000');
  assert.equal(noPrior.length, 0);
});

test('weekly_delta is computed from the ~7-day-ago history row', async () => {
  const state = newState();
  seedCohort(state, 9);
  const target = '5008';
  state.history.push({
    security_id: target,
    computed_on: 'WEEKAGO',
    score: 30,
    rating: 'UNDERWEIGHT',
    grades: {},
    sector_percentile: null,
  });

  await new ScoresRecompute(createFakeDb(state)).run();
  const row = state.scores.get(target)!;
  assert.equal(row.weekly_delta, (row.score as number) - 30);

  // A name with no week-ago row gets null weekly_delta.
  assert.equal(state.scores.get('5000')!.weekly_delta, null);
});

test('securityIds slice restricts the scored set', async () => {
  const state = newState();
  seedCohort(state, 9);

  const summary = await new ScoresRecompute(createFakeDb(state)).run([5000, 5001, 5002]);
  assert.equal(summary.considered, 3);
  assert.equal(state.scores.size, 3);
  assert.equal(state.scores.has('5000'), true);
  assert.equal(state.scores.has('5008'), false);
});
