/**
 * CrossCheck service (CONTRACT §7) — applies the 2-source rule to promote
 * staging rows into VERIFIED lake.objects using the supersede-then-insert
 * pattern the live DDL (0004) is built for.
 *
 * Runs as the `cross_check` handler on q_pipeline. All mutation happens in ONE
 * transaction per natural_key so the DEFERRABLE self-FK
 * lake.objects.superseded_by resolves at COMMIT (0004 comment). The datapoint
 * fan-out (lake.fn_datapoint_fanout, 0007) fires automatically on the
 * PENDING→VERIFIED UPDATE — we NEVER write public.datapoints directly.
 *
 * ── Principals ──────────────────────────────────────────────────────────────
 * The live iam seed (0002) has NO dedicated CROSS-CHECK principal — only 6
 * venue DATA agents, DATA-FILINGS, WRITER/EDITOR agents, and SYSTEM. SYSTEM is
 * the documented actor for "cron/auto-flow audit rows" (0002 comment), so the
 * cross-check agent verifier defaults to SYSTEM, resolved by handle at runtime
 * and cached. The verifier id is passed to lake.objects.verified_by and the
 * revision actor_id. Price-sensitive facts can NOT be auto-verified (the state
 * guard requires a HUMAN verifier for those, 33b) — they stay PENDING and a
 * lake.object_conflicts / Desk item is raised instead.
 *
 * ── Parse-run lineage ───────────────────────────────────────────────────────
 * lake.objects.parse_run_id is NOT NULL. A cross-check pass opens one
 * lake.parse_runs row (parser_key 'cross_check', status running→succeeded) and
 * every object it writes references it. This is the richer lake-side ledger
 * (0004), distinct from the ingestion-side ingest.parse_runs (0005).
 */

import type { LakeSql, LakeTx, LakeLogger } from './db.js';
import { noopLogger } from './db.js';
import {
  decide,
  PRICE_TOLERANCE,
  type Candidate,
  type Decision,
} from './agreement.js';
import type { CrossCheck, CrossCheckInput, CrossCheckResult } from './contract-types.js';

export interface CrossCheckOptions {
  /** iam.principals.handle used as verifier/actor for auto cross-check.
   *  Defaults to 'SYSTEM' (no CROSS-CHECK principal exists in the live seed). */
  verifierHandle?: string;
  /** Price agreement tolerance override (default ±0.5%). */
  tolerance?: number;
  logger?: LakeLogger;
}

interface StagingCandidateRow {
  id: string; // bigint as string (postgres.js)
  source_id: string;
  source_rank: number;
  numeric_value: string | null;
  payload: unknown;
  effective_date: string | null;
  price_sensitive: boolean;
  snapshot_id: string;
  venue_code: string;
  external_id: string | null;
}

interface LiveObjectRow {
  id: string;
  revision: number;
  state: string;
  payload: unknown;
  numeric_value: string | null;
}

export class LakeCrossCheck implements CrossCheck {
  private readonly verifierHandle: string;
  private readonly tolerance: number;
  private readonly log: LakeLogger;
  private verifierId: string | null = null;

  constructor(
    private readonly sql: LakeSql,
    opts: CrossCheckOptions = {},
  ) {
    this.verifierHandle = opts.verifierHandle ?? 'SYSTEM';
    this.tolerance = opts.tolerance ?? PRICE_TOLERANCE;
    this.log = opts.logger ?? noopLogger;
  }

  async resolve(input: CrossCheckInput): Promise<CrossCheckResult> {
    const verifierId = await this.resolveVerifier();

    return this.sql.begin(async (tx) => {
      const candidates = await this.gatherCandidates(tx, input.naturalKey);
      if (candidates.length === 0) {
        // Nothing new to fold in. Report the current live object if one exists.
        const live = await this.liveObject(tx, input.naturalKey);
        if (live) {
          return { objectId: live.id, state: normalizeState(live.state), revision: live.revision };
        }
        // No staging rows AND no object: caller enqueued a stale key.
        this.log.warn('cross_check.no_candidates', { naturalKey: input.naturalKey });
        return { objectId: '', state: 'PENDING', revision: 0 };
      }

      let decision = decide(candidates.map(toCandidate), this.tolerance);

      // CONTRACT §7: MSX ex-date discipline is weak — a dividend disagreement
      // that lacks a registrar (rank ≤10) source is NOT yet a real conflict; a
      // later registrar confirmation may resolve it. Hold such a key PENDING
      // (await registrar) instead of raising a CONFLICT.
      if (decision.kind === 'CONFLICT' && awaitsRegistrar(input.objectType, decision.candidates)) {
        decision = { kind: 'PENDING', reason: 'single_source', winner: decision.winner };
        this.log.info('cross_check.dividend_await_registrar', { naturalKey: input.naturalKey });
      }

      const live = await this.liveObject(tx, input.naturalKey);
      const parseRunId = await this.openParseRun(tx, verifierId);

      let result: CrossCheckResult;
      switch (decision.kind) {
        case 'PENDING':
          result = await this.applyPending(tx, input, decision, candidates, live, parseRunId, verifierId);
          break;
        case 'VERIFIED':
          result = await this.applyVerified(tx, input, decision, candidates, live, parseRunId, verifierId);
          break;
        case 'CONFLICT':
          result = await this.applyConflict(tx, input, decision, candidates, live, parseRunId, verifierId);
          break;
      }

      // Provenance-preserving consumption (independence, CONTRACT §7): a PENDING
      // outcome that has NOT yet reached independent consensus (single_source, or
      // a dividend held for a registrar) leaves its candidate rows UNCONSUMED so a
      // genuinely distinct source arriving in a later pass is gathered ALONGSIDE
      // them — decide() then sees ≥2 independent source_ids in the SAME gather and
      // promotes via applyVerified. We never treat an already-live object as an
      // anonymous prior source, so a second poll of the SAME source (which cannot
      // add a new staging row past the (source_id, external_id, content_hash)
      // dedupe, and never a new source_id) can never auto-VERIFY a single-source
      // fact. VERIFIED/CONFLICT and the price-sensitive hold consume their gather.
      const holdForCorroboration =
        decision.kind === 'PENDING' && decision.reason === 'single_source';
      if (!holdForCorroboration) {
        await this.consume(tx, candidates.map((c) => c.id));
      }
      await this.closeParseRun(tx, parseRunId);
      return result;
    });
  }

  // ── candidate gathering ────────────────────────────────────────────────────

  private async gatherCandidates(tx: LakeTx, naturalKey: string): Promise<StagingCandidateRow[]> {
    return tx<StagingCandidateRow>`
      select id, source_id, source_rank, numeric_value, payload,
             effective_date, price_sensitive, snapshot_id, venue_code, external_id
      from lake.staging_rows
      where natural_key = ${naturalKey} and consumed_at is null
      order by source_rank asc, id asc
    `;
  }

  private async liveObject(tx: LakeTx, naturalKey: string): Promise<LiveObjectRow | null> {
    const rows = await tx<LiveObjectRow>`
      select id, revision, state, payload, numeric_value
      from lake.objects
      where natural_key = ${naturalKey} and superseded_by is null
      limit 1
    `;
    return rows[0] ?? null;
  }

  // ── PENDING (single source, or price-sensitive hold) ───────────────────────

  private async applyPending(
    tx: LakeTx,
    input: CrossCheckInput,
    decision: Extract<Decision, { kind: 'PENDING' }>,
    candidates: StagingCandidateRow[],
    live: LiveObjectRow | null,
    parseRunId: string,
    verifierId: string,
  ): Promise<CrossCheckResult> {
    if (live) {
      const liveState = normalizeState(live.state);

      // No in-place cross-pass promotion for single_source: lake.objects does NOT
      // retain the originating source_id, so a live object can never stand in as
      // an independent "prior source" (CONTRACT §7 requires ≥2 DISTINCT source_ids).
      // Independent corroboration is instead achieved by RETAINING the earlier
      // single-source staging row unconsumed (see resolve()) so a genuinely
      // distinct source in a later pass is gathered alongside it and flows through
      // the VERIFIED path with real, distinct provenance. Here we only leave the
      // live object untouched (a lone new source must not retire a value) and,
      // for a price-sensitive hold, raise a Desk item.
      if (decision.reason === 'price_sensitive_hold') {
        await this.raiseConflictRow(tx, input, live.id, candidates, 'price_sensitive');
      }
      return { objectId: live.id, state: liveState, revision: live.revision };
    }

    const winner = winnerRow(candidates, decision.winner);
    const objectId = await this.insertObject(tx, input, winner, 'PENDING', parseRunId, verifierId);

    if (decision.reason === 'price_sensitive_hold') {
      await this.raiseConflictRow(tx, input, objectId, candidates, 'price_sensitive');
    }
    this.log.info('cross_check.pending', { naturalKey: input.naturalKey, reason: decision.reason });
    return { objectId, state: 'PENDING', revision: 1 };
  }

  // ── VERIFIED (≥2 independent sources agree, not price-sensitive) ────────────

  private async applyVerified(
    tx: LakeTx,
    input: CrossCheckInput,
    decision: Extract<Decision, { kind: 'VERIFIED' }>,
    candidates: StagingCandidateRow[],
    live: LiveObjectRow | null,
    parseRunId: string,
    verifierId: string,
  ): Promise<CrossCheckResult> {
    const winner = winnerRow(candidates, decision.winner);

    if (!live) {
      // First verification for this key: insert PENDING then transition to
      // VERIFIED so the AFTER-UPDATE datapoint fan-out fires (0007 fires only
      // on state entering VERIFIED via UPDATE).
      const objectId = await this.insertObject(tx, input, winner, 'PENDING', parseRunId, verifierId);
      await this.verifyObject(tx, objectId, verifierId);
      this.log.info('cross_check.verified_new', { naturalKey: input.naturalKey, sources: decision.agreeingSourceIds });
      return { objectId, state: 'VERIFIED', revision: 1 };
    }

    // A live object exists carrying the same value as the winner.
    if (valuesEqual(live, winner, this.tolerance)) {
      const liveState = normalizeState(live.state);
      if (liveState === 'VERIFIED') {
        // Already verified with this value — pure re-confirmation, nothing to do.
        this.log.info('cross_check.verified_noop', { naturalKey: input.naturalKey });
        return { objectId: live.id, state: 'VERIFIED', revision: live.revision };
      }
      // A PENDING (single-source) or CONFLICT row that a second source now
      // agrees with: promote it IN PLACE to VERIFIED (PENDING→VERIFIED and
      // CONFLICT→VERIFIED are both legal), firing the datapoint fan-out. No new
      // revision — the value never changed, only its verification status.
      await this.verifyObject(tx, live.id, verifierId);
      if (liveState === 'CONFLICT') await this.resolveOpenConflicts(tx, live.id, verifierId);
      this.log.info('cross_check.verified_inplace', { naturalKey: input.naturalKey, from: liveState });
      return { objectId: live.id, state: 'VERIFIED', revision: live.revision };
    }

    // Value changed on an already-live key ⇒ supersede-then-insert a new
    // revision (CONTRACT §7). One transaction; deferred FK resolves at COMMIT.
    const newRevision = live.revision + 1;
    const newId = await this.newObjectId(tx);

    // 1. Point the old live row at the pre-allocated new id and retire it.
    //    (Must happen before the new row is live so objects_natural_key_live_uni
    //     never sees two live rows for the key.) Retire requires the row already
    //    be VERIFIED; if the live row is PENDING/CONFLICT we transition it to
    //    VERIFIED first is illegal — instead we insert the new revision live and
    //    supersede the non-verified predecessor directly (its state may be
    //    PENDING/CONFLICT, both of which are allowed to be superseded because the
    //    live-uniqueness is on superseded_by, not on state).
    await this.supersedeOld(tx, live, newId);

    // 2. Insert the new revision as PENDING, then verify (fan-out fires).
    const insertedId = await this.insertObjectWithId(tx, input, winner, newId, 'PENDING', parseRunId, verifierId, newRevision);
    await this.verifyObject(tx, insertedId, verifierId);

    // 3. Record the revision pair.
    await this.recordRevision(tx, input.naturalKey, live, insertedId, winner, 'source_update', verifierId);

    this.log.info('cross_check.verified_revision', { naturalKey: input.naturalKey, revision: newRevision });
    return { objectId: insertedId, state: 'VERIFIED', revision: newRevision };
  }

  // ── CONFLICT (≥2 independent sources disagree) ─────────────────────────────

  private async applyConflict(
    tx: LakeTx,
    input: CrossCheckInput,
    decision: Extract<Decision, { kind: 'CONFLICT' }>,
    candidates: StagingCandidateRow[],
    live: LiveObjectRow | null,
    parseRunId: string,
    verifierId: string,
  ): Promise<CrossCheckResult> {
    const winner = winnerRow(candidates, decision.winner);

    // If a VERIFIED live object already exists, a fresh disagreement among new
    // sources must NOT retire it (VERIFIED→CONFLICT is not a legal transition).
    // Park the conflict against the existing object for Desk resolution.
    let objectId: string;
    let revision: number;
    let state: CrossCheckResult['state'];

    if (live && normalizeState(live.state) === 'VERIFIED') {
      objectId = live.id;
      revision = live.revision;
      state = 'VERIFIED';
    } else if (live) {
      // Live PENDING/CONFLICT row: move/keep it in CONFLICT.
      objectId = live.id;
      revision = live.revision;
      if (normalizeState(live.state) === 'PENDING') {
        await this.transition(tx, live.id, 'CONFLICT');
      }
      state = 'CONFLICT';
    } else {
      // No live object: create one in CONFLICT (PENDING→CONFLICT).
      objectId = await this.insertObject(tx, input, winner, 'PENDING', parseRunId, verifierId);
      await this.transition(tx, objectId, 'CONFLICT');
      revision = 1;
      state = 'CONFLICT';
    }

    await this.raiseConflictRow(tx, input, objectId, candidates, 'primary_wins');
    this.log.warn('cross_check.conflict', { naturalKey: input.naturalKey, candidates: candidates.length });
    return { objectId, state, revision };
  }

  // ── lake.objects writers ───────────────────────────────────────────────────

  private async insertObject(
    tx: LakeTx,
    input: CrossCheckInput,
    winner: StagingCandidateRow,
    state: 'PENDING',
    parseRunId: string,
    _verifierId: string,
  ): Promise<string> {
    const securityId = await this.resolveSecurityId(tx, winner);
    const rows = await tx<{ id: string }>`
      insert into lake.objects (
        object_type, natural_key, security_id, venue_code, payload,
        numeric_value, unit, effective_date, state, revision,
        parse_run_id, source_rank, price_sensitive
      ) values (
        ${input.objectType}, ${input.naturalKey}, ${securityId}, ${winner.venue_code},
        ${asJsonb(winner.payload)}, ${winner.numeric_value}, ${unitOf(winner)},
        ${winner.effective_date}, ${state}, ${1},
        ${parseRunId}, ${winner.source_rank}, ${winner.price_sensitive}
      )
      returning id
    `;
    return rows[0].id;
  }

  private async insertObjectWithId(
    tx: LakeTx,
    input: CrossCheckInput,
    winner: StagingCandidateRow,
    id: string,
    state: 'PENDING',
    parseRunId: string,
    _verifierId: string,
    revision: number,
  ): Promise<string> {
    const securityId = await this.resolveSecurityId(tx, winner);
    const rows = await tx<{ id: string }>`
      insert into lake.objects (
        id, object_type, natural_key, security_id, venue_code, payload,
        numeric_value, unit, effective_date, state, revision,
        parse_run_id, source_rank, price_sensitive
      ) values (
        ${id}, ${input.objectType}, ${input.naturalKey}, ${securityId}, ${winner.venue_code},
        ${asJsonb(winner.payload)}, ${winner.numeric_value}, ${unitOf(winner)},
        ${winner.effective_date}, ${state}, ${revision},
        ${parseRunId}, ${winner.source_rank}, ${winner.price_sensitive}
      )
      returning id
    `;
    return rows[0].id;
  }

  /** PENDING→VERIFIED. Sets verified_by (the state guard stamps verified_at and
   *  enforces the human-verifier rule for price-sensitive rows). Fan-out fires. */
  private async verifyObject(tx: LakeTx, objectId: string, verifierId: string): Promise<void> {
    await tx`
      update lake.objects
      set state = 'VERIFIED', verified_by = ${verifierId}
      where id = ${objectId}
    `;
  }

  private async transition(tx: LakeTx, objectId: string, state: 'CONFLICT'): Promise<void> {
    await tx`update lake.objects set state = ${state} where id = ${objectId}`;
  }

  /** Retire the old live row by pointing superseded_by at the pre-allocated new
   *  id. VERIFIED→RETIRED is legal; PENDING/CONFLICT rows are retired by simply
   *  setting superseded_by (they leave the live set) without a state change,
   *  which the state guard permits (it only gates state *changes*). */
  private async supersedeOld(tx: LakeTx, live: LiveObjectRow, newId: string): Promise<void> {
    if (normalizeState(live.state) === 'VERIFIED') {
      await tx`
        update lake.objects
        set superseded_by = ${newId}, state = 'RETIRED'
        where id = ${live.id}
      `;
    } else {
      await tx`
        update lake.objects
        set superseded_by = ${newId}
        where id = ${live.id}
      `;
    }
  }

  private async recordRevision(
    tx: LakeTx,
    naturalKey: string,
    oldRow: LiveObjectRow,
    newObjectId: string,
    winner: StagingCandidateRow,
    reason: 'source_update' | 'correction' | 'human_override' | 'conflict_resolution',
    actorId: string,
  ): Promise<void> {
    await tx`
      insert into lake.object_revisions (
        natural_key, old_object_id, new_object_id, old_value, new_value, reason, actor_id
      ) values (
        ${naturalKey}, ${oldRow.id}, ${newObjectId},
        ${asJsonb(oldRow.payload)}, ${asJsonb(winner.payload)}, ${reason}, ${actorId}
      )
    `;
  }

  /** Close any open conflicts on an object once cross-check reaches consensus. */
  private async resolveOpenConflicts(tx: LakeTx, objectId: string, actorId: string): Promise<void> {
    await tx`
      update lake.object_conflicts
      set status = 'resolved_primary', resolved_by = ${actorId}, resolved_at = now()
      where object_id = ${objectId} and status = 'open'
    `;
  }

  private async raiseConflictRow(
    tx: LakeTx,
    input: CrossCheckInput,
    objectId: string,
    candidates: StagingCandidateRow[],
    policy: 'primary_wins' | 'price_sensitive',
  ): Promise<void> {
    // Idempotency: don't stack duplicate open conflicts for the same object.
    const open = await tx<{ id: string }>`
      select id from lake.object_conflicts
      where object_id = ${objectId} and status = 'open'
      limit 1
    `;
    if (open.length > 0) return;

    const candidatesJson = candidates.map((c) => ({
      value: c.numeric_value !== null ? Number(c.numeric_value) : c.payload,
      source_id: Number(c.source_id),
      source_rank: c.source_rank,
      snapshot_id: Number(c.snapshot_id),
      external_id: c.external_id,
      price_sensitive: c.price_sensitive,
    }));

    await tx`
      insert into lake.object_conflicts (natural_key, object_id, candidates, policy)
      values (${input.naturalKey}, ${objectId}, ${asJsonb(candidatesJson)}, ${policyName(policy)})
    `;
  }

  // ── staging bookkeeping ────────────────────────────────────────────────────

  private async consume(tx: LakeTx, stagingIds: string[]): Promise<void> {
    if (stagingIds.length === 0) return;
    await tx`
      update lake.staging_rows
      set consumed_at = now()
      where id = any(${stagingIds})
    `;
  }

  // ── parse-run lineage ──────────────────────────────────────────────────────

  private async openParseRun(tx: LakeTx, agentId: string): Promise<string> {
    const rows = await tx<{ id: string }>`
      insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
      values (${agentId}, 'cross_check', '1', 'running')
      returning id
    `;
    return rows[0].id;
  }

  private async closeParseRun(tx: LakeTx, parseRunId: string): Promise<void> {
    await tx`
      update lake.parse_runs
      set status = 'succeeded', finished_at = now()
      where id = ${parseRunId}
    `;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async newObjectId(tx: LakeTx): Promise<string> {
    const rows = await tx<{ id: string }>`select gen_random_uuid() as id`;
    return rows[0].id;
  }

  private async resolveSecurityId(tx: LakeTx, winner: StagingCandidateRow): Promise<string | null> {
    const ticker = tickerOf(winner.payload);
    if (!ticker) return null;
    const rows = await tx<{ id: string }>`
      select id from public.securities
      where venue_code = ${winner.venue_code} and ticker = ${ticker}
      limit 1
    `;
    return rows[0]?.id ?? null;
  }

  private async resolveVerifier(): Promise<string> {
    if (this.verifierId) return this.verifierId;
    const rows = await this.sql<{ id: string }>`
      select id from iam.principals where handle = ${this.verifierHandle} limit 1
    `;
    if (rows.length === 0) {
      throw new Error(`cross-check verifier principal not found: handle=${this.verifierHandle}`);
    }
    this.verifierId = rows[0].id;
    return this.verifierId;
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────────

function toCandidate(row: StagingCandidateRow): Candidate {
  return {
    stagingId: Number(row.id),
    sourceId: Number(row.source_id),
    sourceRank: row.source_rank,
    numericValue: row.numeric_value !== null ? Number(row.numeric_value) : null,
    comparableText: comparableTextOf(row),
    priceSensitive: row.price_sensitive,
  };
}

/** For non-numeric facts, compare a stable token derived from the payload +
 *  effective_date so dates/enums must match exactly (CONTRACT §7). */
function comparableTextOf(row: StagingCandidateRow): string {
  if (row.numeric_value !== null) return row.numeric_value;
  return JSON.stringify({ p: sortJson(row.payload), d: row.effective_date ?? null });
}

function sortJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortJson);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = sortJson((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

function winnerRow(candidates: StagingCandidateRow[], winner: Candidate): StagingCandidateRow {
  const found = candidates.find((c) => Number(c.id) === winner.stagingId);
  if (found) return found;
  // Fallback: recompute the primary from the raw rows.
  return [...candidates].sort(
    (a, b) => a.source_rank - b.source_rank || Number(a.id) - Number(b.id),
  )[0];
}

function valuesEqual(live: LiveObjectRow, winner: StagingCandidateRow, tolerance: number): boolean {
  if (live.numeric_value !== null && winner.numeric_value !== null) {
    const a = Number(live.numeric_value);
    const b = Number(winner.numeric_value);
    if (a === b) return true;
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return scale === 0 ? a === b : Math.abs(a - b) / scale <= tolerance;
  }
  return JSON.stringify(sortJson(live.payload)) === JSON.stringify(sortJson(winner.payload));
}

function normalizeState(state: string): CrossCheckResult['state'] {
  if (state === 'VERIFIED' || state === 'CONFLICT') return state;
  return 'PENDING'; // PENDING and RETIRED both report as non-verified to callers
}

function unitOf(row: StagingCandidateRow): string | null {
  const p = row.payload as Record<string, unknown> | null;
  if (p && typeof p.unit === 'string') return p.unit;
  return null;
}

function tickerOf(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (p && typeof p.ticker === 'string') return p.ticker;
  return null;
}

/** Registrar source rank (CONTRACT §6.5: registrar=10, exchange=20, press=90). */
const REGISTRAR_RANK = 10;

/** Dividend / DPS families whose ex-date/DPS disagreements tolerate a later
 *  registrar confirmation (CONTRACT §7: MSX ex-date discipline is weak). */
function isDividendKey(objectType: string): boolean {
  return objectType.startsWith('DIVIDEND.') || objectType === 'DISCLOSURE.DPS';
}

/** A dividend conflict should wait for the registrar (stay PENDING, not CONFLICT)
 *  when the disagreeing candidates are all non-registrar sources — i.e. no
 *  registrar-ranked (≤10) source has weighed in yet, so a later registrar
 *  confirmation could still resolve it (CONTRACT §7). If a registrar source is
 *  already present and still disagrees, it is a real conflict. */
function awaitsRegistrar(objectType: string, candidates: Candidate[]): boolean {
  if (!isDividendKey(objectType)) return false;
  return !candidates.some((c) => c.sourceRank <= REGISTRAR_RANK);
}

function policyName(policy: 'primary_wins' | 'price_sensitive'): string {
  // lake.object_conflicts.policy is free text (0004). Persist the ACTUAL policy
  // so the Desk can tell a 33b price-sensitive human-confirm hold apart from an
  // ordinary source-disagreement (primary_wins) conflict.
  return policy;
}

/** Marker so a plain JS object is bound to a jsonb column. postgres.js binds
 *  objects to jsonb automatically; the test fake reads through this seam. */
function asJsonb(value: unknown): unknown {
  return value;
}
