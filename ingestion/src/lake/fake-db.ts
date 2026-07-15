/**
 * In-memory LakeSql/LakeTx fake for unit tests (no Postgres).
 *
 * NOT a general SQL engine — it recognizes exactly the queries the lake modules
 * issue, by matching stable fragments of each tagged-template. It models enough
 * of lake.objects / staging_rows / object_revisions / object_conflicts /
 * parse_runs / securities / iam.principals to assert the pipeline's behavior:
 * the 2-source decision, supersede-then-insert (incl. the one-live-per-key
 * invariant and the datapoint fan-out that mirrors the 0007 trigger), conflict
 * rows, and staging idempotency.
 *
 * It deliberately enforces the invariants the real DDL enforces so a test that
 * would violate them (two live rows per natural_key, illegal state transition,
 * price-sensitive VERIFIED without a human) fails here too.
 */

import type { LakeSql, LakeTx, Row } from './db.js';

interface ObjectRow {
  id: string;
  object_type: string;
  natural_key: string;
  security_id: string | null;
  venue_code: string | null;
  payload: unknown;
  numeric_value: string | null;
  unit: string | null;
  effective_date: string | null;
  state: string;
  revision: number;
  parse_run_id: string;
  source_rank: number;
  price_sensitive: boolean;
  verified_by: string | null;
  verified_at: string | null;
  superseded_by: string | null;
}

interface StagingRowRec {
  id: string;
  object_type: string;
  natural_key: string;
  venue_code: string;
  source_id: string;
  source_rank: number;
  snapshot_id: string;
  external_id: string | null;
  content_hash: string;
  payload: unknown;
  numeric_value: string | null;
  unit: string | null;
  effective_date: string | null;
  price_sensitive: boolean;
  extracted_at: string;
  consumed_at: string | null;
}

export interface FakeState {
  principals: Map<string, string>; // handle → id
  securities: Array<{ id: string; venue_code: string; ticker: string; shares_outstanding: string | null; status: string }>;
  objects: ObjectRow[];
  staging: StagingRowRec[];
  revisions: Row[];
  conflicts: Row[];
  parseRuns: Row[];
  quotesLatest: Map<string, string | null>; // security_id → last
  statements: Array<{ security_id: string; statement_type: string; period_kind: string; period_end: string; is_estimate: boolean; line_items: Record<string, unknown> }>;
  dividends: Array<{ security_id: string; state: string; dps: number; ex_date: string | null }>;
  keyRatios: Map<string, Row>;
  datapointFanoutCalls: Array<{ objectId: string; numericValue: string | null }>;
}

export function newState(): FakeState {
  return {
    principals: new Map([['SYSTEM', 'sys-0000']]),
    securities: [],
    objects: [],
    staging: [],
    revisions: [],
    conflicts: [],
    parseRuns: [],
    quotesLatest: new Map(),
    statements: [],
    dividends: [],
    keyRatios: new Map(),
    datapointFanoutCalls: [],
  };
}

let uuidSeq = 1;
let idSeq = 1;
function nextUuid(): string {
  return `uuid-${String(uuidSeq++).padStart(4, '0')}`;
}
function nextId(): string {
  return String(idSeq++);
}

export function createFakeDb(state: FakeState): LakeSql {
  const run = makeRunner(state);
  const sql = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeSql;
  sql.begin = async <T>(fn: (tx: LakeTx) => Promise<T>): Promise<T> => {
    const tx = ((strings: TemplateStringsArray, ...params: unknown[]) => run(strings, params)) as unknown as LakeTx;
    return fn(tx);
  };
  return sql;
}

function makeRunner(state: FakeState) {
  return async function run(strings: TemplateStringsArray, params: unknown[]): Promise<Row[]> {
    const q = strings.join('?').replace(/\s+/g, ' ').trim().toLowerCase();

    // ── iam.principals ───────────────────────────────────────────────────────
    if (q.includes('from iam.principals where handle')) {
      const handle = params[0] as string;
      const id = state.principals.get(handle);
      return id ? [{ id }] : [];
    }

    // ── gen_random_uuid() ────────────────────────────────────────────────────
    if (q.includes('select gen_random_uuid() as id')) {
      return [{ id: nextUuid() }];
    }

    // ── securities lookups ───────────────────────────────────────────────────
    if (q.includes('from public.securities where venue_code') && q.includes('and ticker')) {
      const venue = params[0] as string;
      const ticker = params[1] as string;
      const s = state.securities.find((x) => x.venue_code === venue && x.ticker === ticker);
      return s ? [{ id: s.id }] : [];
    }
    if (q.includes('from public.securities') && q.includes('status = \'listed\'')) {
      let secs = state.securities.filter((s) => s.status === 'listed');
      if (q.includes('id = any')) {
        const ids = (params[0] as number[]).map(String);
        secs = secs.filter((s) => ids.includes(s.id));
      }
      return secs.map((s) => ({ id: s.id, venue_code: s.venue_code, shares_outstanding: s.shares_outstanding }));
    }

    // ── quotes_latest ────────────────────────────────────────────────────────
    if (q.includes('from public.quotes_latest')) {
      const secId = params[0] as string;
      return state.quotesLatest.has(secId) ? [{ last: state.quotesLatest.get(secId) }] : [];
    }

    // ── financial_statements ─────────────────────────────────────────────────
    if (q.includes('from public.financial_statements')) {
      const secId = params[0] as string;
      const kind = params[1] as string;
      const rows = state.statements
        .filter((s) => s.security_id === secId && s.statement_type === kind && !s.is_estimate)
        .sort((a, b) => rankPk(a.period_kind) - rankPk(b.period_kind) || (a.period_end < b.period_end ? 1 : -1));
      return rows[0] ? [{ line_items: rows[0].line_items }] : [];
    }

    // ── dividends trailing sum ───────────────────────────────────────────────
    if (q.includes('sum(dps)') && q.includes('from public.dividends')) {
      const secId = params[0] as string;
      const sum = state.dividends
        .filter((d) => d.security_id === secId && d.state === 'live' && d.ex_date)
        .reduce((acc, d) => acc + d.dps, 0);
      return [{ dps_sum: state.dividends.some((d) => d.security_id === secId) ? String(sum) : null }];
    }

    // ── key_ratios upsert ────────────────────────────────────────────────────
    if (q.includes('insert into public.key_ratios')) {
      const secId = params[0] as string;
      state.keyRatios.set(secId, { security_id: secId, source_object_id: params[params.length - 1] });
      return [];
    }

    // ── lake.parse_runs ──────────────────────────────────────────────────────
    if (q.includes('insert into lake.parse_runs')) {
      const id = nextId();
      state.parseRuns.push({ id, agent_id: params[0], status: 'running' });
      return [{ id }];
    }
    if (q.includes('update lake.parse_runs set status')) {
      return [];
    }

    // ── staging insert (ON CONFLICT DO NOTHING) ──────────────────────────────
    if (q.includes('insert into lake.staging_rows')) {
      const [objectType, naturalKey, venue, sourceId, sourceRank, snapshotId, externalId, contentHash, payload, numericValue, unit, effectiveDate, priceSensitive, extractedAt] = params as [
        string, string, string, string | number, number, string | number, string | null, string, unknown, number | null, string | null, string | null, boolean, string,
      ];
      const dupe = state.staging.some(
        (r) => r.source_id === String(sourceId) && r.external_id === (externalId ?? null) && r.content_hash === contentHash,
      );
      if (!dupe) {
        state.staging.push({
          id: nextId(),
          object_type: objectType,
          natural_key: naturalKey,
          venue_code: venue,
          source_id: String(sourceId),
          source_rank: sourceRank,
          snapshot_id: String(snapshotId),
          external_id: externalId ?? null,
          content_hash: contentHash,
          payload,
          numeric_value: numericValue == null ? null : String(numericValue),
          unit: unit ?? null,
          effective_date: effectiveDate ?? null,
          price_sensitive: !!priceSensitive,
          extracted_at: extractedAt,
          consumed_at: null,
        });
      }
      return [];
    }

    // ── staging gather ───────────────────────────────────────────────────────
    if (q.includes('from lake.staging_rows') && q.includes('consumed_at is null') && q.includes('natural_key =')) {
      const naturalKey = params[0] as string;
      return state.staging
        .filter((r) => r.natural_key === naturalKey && r.consumed_at === null)
        .sort((a, b) => a.source_rank - b.source_rank || Number(a.id) - Number(b.id))
        .map((r) => ({
          id: r.id, source_id: r.source_id, source_rank: r.source_rank, numeric_value: r.numeric_value,
          payload: r.payload, effective_date: r.effective_date, price_sensitive: r.price_sensitive,
          snapshot_id: r.snapshot_id, venue_code: r.venue_code, external_id: r.external_id,
        }));
    }
    if (q.includes('update lake.staging_rows set consumed_at')) {
      const ids = (params[0] as string[]).map(String);
      for (const r of state.staging) if (ids.includes(r.id)) r.consumed_at = 'now';
      return [];
    }

    // ── lake.objects live lookup ─────────────────────────────────────────────
    if (q.includes('from lake.objects') && q.includes('superseded_by is null') && q.includes('natural_key =')) {
      const naturalKey = params[0] as string;
      const live = state.objects.find((o) => o.natural_key === naturalKey && o.superseded_by === null);
      return live ? [{ id: live.id, revision: live.revision, state: live.state, payload: live.payload, numeric_value: live.numeric_value }] : [];
    }

    // ── lake.objects insert (with or without explicit id) ────────────────────
    if (q.includes('insert into lake.objects')) {
      return insertObject(state, q, params);
    }

    // ── lake.objects update (verify / supersede / transition) ────────────────
    if (q.includes('update lake.objects')) {
      return updateObject(state, q, params);
    }

    // ── lake.object_revisions ────────────────────────────────────────────────
    if (q.includes('insert into lake.object_revisions')) {
      state.revisions.push({
        natural_key: params[0], old_object_id: params[1], new_object_id: params[2],
        old_value: params[3], new_value: params[4], reason: params[5], actor_id: params[6],
      });
      return [];
    }

    // ── lake.object_conflicts ────────────────────────────────────────────────
    if (q.includes('from lake.object_conflicts') && q.includes("status = 'open'")) {
      const objectId = params[0] as string;
      return state.conflicts.filter((c) => c.object_id === objectId && c.status === 'open').map((c) => ({ id: c.id }));
    }
    if (q.includes('insert into lake.object_conflicts')) {
      state.conflicts.push({
        id: nextId(), natural_key: params[0], object_id: params[1], candidates: params[2], policy: params[3], status: 'open',
      });
      return [];
    }
    if (q.includes('update lake.object_conflicts set status')) {
      const actorId = params[0] as string;
      const objectId = params[1] as string;
      for (const c of state.conflicts) {
        if (c.object_id === objectId && c.status === 'open') {
          c.status = 'resolved_primary';
          c.resolved_by = actorId;
        }
      }
      return [];
    }

    throw new Error(`fake-db: unrecognized query: ${q.slice(0, 120)}`);
  };
}

function rankPk(pk: string): number {
  return pk === 'ttm' ? 0 : pk === 'annual' ? 1 : 2;
}

function insertObject(state: FakeState, q: string, params: unknown[]): Row[] {
  const hasId = q.includes('( id,') || q.includes('(id,') || /insert into lake\.objects \( ?id,/.test(q);
  let p = [...params];
  let id: string;
  if (hasId) {
    id = p.shift() as string;
  } else {
    id = nextUuid();
  }
  // Column order (both variants): object_type, natural_key, security_id,
  // venue_code, payload, numeric_value, [unit, effective_date,] state, revision,
  // parse_run_id, source_rank, [price_sensitive]
  const objectType = p[0] as string;
  const naturalKey = p[1] as string;
  const securityId = (p[2] as string | null) ?? null;
  const venueCode = (p[3] as string | null) ?? null;
  const payload = p[4];
  const numericValue = p[5] == null ? null : String(p[5]);

  // Four insert shapes, distinguished by column signature:
  //  cross-check base   : (…, numeric_value, unit, effective_date, state, revision=LITERAL 1, parse_run_id, source_rank, price_sensitive)
  //  cross-check w/ id  : (id, …, numeric_value, unit, effective_date, state, revision=PARAM, parse_run_id, source_rank, price_sensitive)
  //  COMPUTED base      : (…, numeric_value, state, revision=LITERAL 1, parse_run_id, source_rank)
  //  COMPUTED w/ id     : (id, …, numeric_value, state, revision=PARAM, parse_run_id, source_rank)
  // `revision` is a bound param ONLY on the "w/ id" variants (hasId); otherwise
  // it is the SQL literal 1 and is absent from params.
  const hasUnit = q.includes('numeric_value, unit, effective_date, state');
  let unit: string | null = null;
  let effectiveDate: string | null = null;
  let state_: string;
  let revision = 1;
  let parseRunId: string;
  let sourceRank: number;
  let priceSensitive = false;
  let i = 6;

  if (hasUnit) {
    unit = (p[i++] as string | null) ?? null;
    effectiveDate = (p[i++] as string | null) ?? null;
  }
  state_ = p[i++] as string;
  revision = p[i++] as number; // revision is bound as a param in all insert variants
  parseRunId = String(p[i++]);
  sourceRank = p[i++] as number;
  if (hasUnit) priceSensitive = !!p[i++];

  enforceLiveUnique(state, naturalKey);
  state.objects.push({
    id, object_type: objectType, natural_key: naturalKey, security_id: securityId, venue_code: venueCode,
    payload, numeric_value: numericValue, unit, effective_date: effectiveDate, state: state_, revision,
    parse_run_id: parseRunId, source_rank: sourceRank, price_sensitive: priceSensitive,
    verified_by: null, verified_at: null, superseded_by: null,
  });
  return [{ id }];
}

function updateObject(state: FakeState, q: string, params: unknown[]): Row[] {
  // Cases:
  //  set payload=$1, numeric_value=$2, unit=$3, effective_date=$4, source_rank=$5,
  //      parse_run_id=$6 where id=$7   (live-latest in-place refresh; no state change)
  //  set state = 'VERIFIED', verified_by = $1 where id = $2
  //  set superseded_by = $1, state = 'RETIRED' where id = $2
  //  set superseded_by = $1 where id = $2
  //  set state = $1 where id = $2   (CONFLICT transition)
  if (q.includes('payload =') && q.includes('parse_run_id =') && q.includes('numeric_value =')) {
    const [payload, numericValue, unit, effectiveDate, sourceRank, parseRunId, id] = params as [
      unknown, string | null, string | null, string | null, number, string, string,
    ];
    const obj = must(state, id);
    obj.payload = payload;
    obj.numeric_value = numericValue;
    obj.unit = unit;
    obj.effective_date = effectiveDate;
    obj.source_rank = sourceRank;
    obj.parse_run_id = parseRunId;
    return [];
  }
  if (q.includes("set state = 'verified'") || q.includes('set state = \'verified\'')) {
    const verifiedBy = params[0] as string;
    const id = params[1] as string;
    const obj = must(state, id);
    guardTransition(obj.state, 'VERIFIED');
    if (obj.price_sensitive && !isHuman(state, verifiedBy)) {
      throw new Error('price-sensitive objects require a HUMAN verifier (33b)');
    }
    obj.state = 'VERIFIED';
    obj.verified_by = verifiedBy;
    obj.verified_at = 'now';
    // fan-out mirror (0007: fires on entering VERIFIED via update)
    state.datapointFanoutCalls.push({ objectId: id, numericValue: obj.numeric_value });
    return [];
  }
  if (q.includes('set superseded_by =') && q.includes("state = 'retired'")) {
    const newId = params[0] as string;
    const id = params[1] as string;
    const obj = must(state, id);
    guardTransition(obj.state, 'RETIRED');
    obj.superseded_by = newId;
    obj.state = 'RETIRED';
    return [];
  }
  if (q.includes('set superseded_by =')) {
    const newId = params[0] as string;
    const id = params[1] as string;
    must(state, id).superseded_by = newId;
    return [];
  }
  if (q.includes('set state =')) {
    const newState = params[0] as string;
    const id = params[1] as string;
    const obj = must(state, id);
    guardTransition(obj.state, newState);
    obj.state = newState;
    return [];
  }
  return [];
}

function must(state: FakeState, id: string): ObjectRow {
  const o = state.objects.find((x) => x.id === id);
  if (!o) throw new Error(`fake-db: object ${id} not found`);
  return o;
}

function isHuman(state: FakeState, principalId: string): boolean {
  // Fake: only ids beginning with 'human-' are human principals.
  return principalId.startsWith('human-');
}

function enforceLiveUnique(state: FakeState, naturalKey: string): void {
  const live = state.objects.filter((o) => o.natural_key === naturalKey && o.superseded_by === null);
  if (live.length > 0) {
    throw new Error(`fake-db: objects_natural_key_live_uni violation for ${naturalKey}`);
  }
}

function guardTransition(from: string, to: string): void {
  if (from === to) return;
  const ok =
    (from === 'PENDING' && (to === 'VERIFIED' || to === 'CONFLICT')) ||
    (from === 'CONFLICT' && to === 'VERIFIED') ||
    (from === 'VERIFIED' && to === 'RETIRED');
  if (!ok) throw new Error(`illegal lake object transition ${from} -> ${to}`);
}
