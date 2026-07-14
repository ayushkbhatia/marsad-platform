/**
 * Marsad Score batch (07 §3.6 step 04:00 GST `score_batch`; the flagship).
 *
 * public.scores is one row per scored security — the 0–100 Marsad Score, rating
 * band, five factor letter grades, and sector-cohort percentile. This service is
 * the DB-facing shell around the PURE engine in score-engine.ts (mirrors the
 * KeyRatiosRecompute / ratios-compute split): it loads the score-eligible
 * universe (key_ratios + securities + the quote's 52-week band), runs the engine,
 * and per scored name writes a COMPUTED.SCORE lake object for lineage + upserts
 * public.scores, public.score_history (PK security_id, computed_on), and diffs
 * against yesterday into public.score_events.
 *
 * The COMPUTED.SCORE object is written straight to VERIFIED (numbers we derived
 * ourselves need no cross-check), carries NO metric_key (so the 0007 datapoint
 * fan-out short-circuits — score is a flat public.scores row, not a datapoint),
 * and supersedes the prior COMPUTED.SCORE for its natural_key via the same
 * one-live-per-key discipline used by KeyRatiosRecompute.writeComputedObject.
 *
 * FRESHNESS GATE (07 §3.6): a percentile is meaningless mid-population, so the
 * Score must run on fresh ratios. If the eligible universe is non-empty but the
 * newest key_ratios.computed_at predates today's 02:00 GST nightly run (i.e. the
 * ratio job did not refresh today), the batch ABORTS rather than scoring on
 * yesterday's ratios. An EMPTY universe (key_ratios has 0 rows — true in prod
 * today) returns { scored: 0 } cleanly, never crashes.
 *
 * Runs as marsad_worker on q_maintenance off the `score_batch` cron.
 */

import type { LakeSql, LakeTx, LakeLogger } from './db.js';
import { noopLogger } from './db.js';
import { scoreUniverse, type ScoreInput, type ScoreResult } from './score-engine.js';

export interface ScoresOptions {
  /** iam handle attributed as the COMPUTED object's verifier/actor. */
  computeHandle?: string;
  logger?: LakeLogger;
}

export interface ScoreBatchSummary {
  /** Number of securities that produced a scores row this run. */
  scored: number;
  /** Number of score-eligible securities considered (0 ⇒ empty universe). */
  considered: number;
  /** True when the freshness gate short-circuited the run (07 §3.6). */
  aborted: boolean;
}

/** Raised when the freshness gate trips (stale key_ratios). The handler logs and
 *  swallows this — a stale-ratio run must NOT silently score, but it also must not
 *  crash the worker. */
export class StaleKeyRatiosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleKeyRatiosError';
  }
}

/** One score-eligible security joined across securities + key_ratios + quotes. */
interface UniverseRow {
  id: string;
  venue_code: string;
  sector: string;
  // key_ratios inputs (numeric → string over the wire).
  market_cap: string | null;
  pe: string | null;
  pb: string | null;
  eps_ttm: string | null;
  dividend_yield: string | null;
  ev_ebitda: string | null;
  roe: string | null;
  roce: string | null;
  nim: string | null;
  net_margin: string | null;
  gross_margin: string | null;
  rev_growth_yoy: string | null;
  eps_growth_yoy: string | null;
  rev_cagr_3y: string | null;
  eps_cagr_3y: string | null;
  ret_3m: string | null;
  ret_6m: string | null;
  ret_12_1: string | null;
  // quote 52-week band.
  last: string | null;
  week52_high: string | null;
  week52_low: string | null;
}

/** Yesterday's published state for one security (for the diff → score_events). */
interface PriorScoreRow {
  security_id: string;
  score: number;
  rating: string;
  grades: Record<string, string | null>;
}

export class ScoresRecompute {
  private readonly computeHandle: string;
  private readonly log: LakeLogger;
  private computeAgentId: string | null = null;

  constructor(private readonly sql: LakeSql, opts: ScoresOptions = {}) {
    this.computeHandle = opts.computeHandle ?? 'SYSTEM';
    this.log = opts.logger ?? noopLogger;
  }

  /** Score the eligible universe (or the given slice). Returns a receipt. */
  async run(securityIds?: number[]): Promise<ScoreBatchSummary> {
    const rows = await this.loadUniverse(securityIds);
    if (rows.length === 0) {
      // Empty universe (prod today): nothing to score, not an error.
      this.log.info('score_batch: empty universe — nothing to score', {});
      return { scored: 0, considered: 0, aborted: false };
    }

    // FRESHNESS GATE (07 §3.6): abort rather than score on stale ratios.
    await this.assertRatiosFresh();

    const agentId = await this.resolveAgent();
    const inputs = rows.map((r) => toScoreInput(r));
    const results = scoreUniverse(inputs);
    const byId = new Map<number, ScoreResult>();
    for (const res of results) byId.set(res.securityId, res);

    let scored = 0;
    for (const row of rows) {
      const res = byId.get(Number(row.id));
      if (!res) continue; // < 3 factors ⇒ no score row (engine omitted it).
      await this.persist(row, res, agentId);
      scored += 1;
    }

    this.log.info('score_batch done', { considered: rows.length, scored });
    return { scored, considered: rows.length, aborted: false };
  }

  /**
   * Score-eligible universe (07 §3.6): listed securities with a key_ratios row,
   * past their score_eligible_from gate. Joined to the quote's 52-week band.
   */
  private async loadUniverse(securityIds?: number[]): Promise<UniverseRow[]> {
    if (securityIds && securityIds.length > 0) {
      return this.sql<UniverseRow>`
        select
          s.id, s.venue_code, s.sector,
          k.market_cap, k.pe, k.pb, k.eps_ttm, k.dividend_yield, k.ev_ebitda,
          k.roe, k.roce, k.nim, k.net_margin, k.gross_margin,
          k.rev_growth_yoy, k.eps_growth_yoy, k.rev_cagr_3y, k.eps_cagr_3y,
          k.ret_3m, k.ret_6m, k.ret_12_1,
          q.last, q.week52_high, q.week52_low
        from public.securities s
        join public.key_ratios k on k.security_id = s.id
        left join public.quotes_latest q on q.security_id = s.id
        where s.id = any(${securityIds})
          and s.status = 'listed'
          and (s.score_eligible_from is null or s.score_eligible_from <= current_date)
        order by s.id
      `;
    }
    return this.sql<UniverseRow>`
      select
        s.id, s.venue_code, s.sector,
        k.market_cap, k.pe, k.pb, k.eps_ttm, k.dividend_yield, k.ev_ebitda,
        k.roe, k.roce, k.nim, k.net_margin, k.gross_margin,
        k.rev_growth_yoy, k.eps_growth_yoy, k.rev_cagr_3y, k.eps_cagr_3y,
        k.ret_3m, k.ret_6m, k.ret_12_1,
        q.last, q.week52_high, q.week52_low
      from public.securities s
      join public.key_ratios k on k.security_id = s.id
      left join public.quotes_latest q on q.security_id = s.id
      where s.status = 'listed'
        and (s.score_eligible_from is null or s.score_eligible_from <= current_date)
      order by s.id
    `;
  }

  /**
   * Freshness gate (07 §3.6): the nightly key_ratios job runs at 02:00 GST
   * (= 22:00 UTC the prior day). If the newest key_ratios.computed_at is older
   * than today's 02:00 GST boundary, the ratio job did not refresh today and the
   * Score must not run on stale ratios — abort loudly.
   */
  private async assertRatiosFresh(): Promise<void> {
    const rows = await this.sql<{ stale: boolean }>`
      select (max(computed_at) <= date_trunc('day', now() at time zone 'Asia/Dubai')
                                   at time zone 'Asia/Dubai' + interval '2 hours') as stale
      from public.key_ratios
    `;
    if (rows[0]?.stale) {
      throw new StaleKeyRatiosError(
        'score_batch aborted: stale key_ratios (max(computed_at) predates today 02:00 GST nightly run)',
      );
    }
  }

  /**
   * Persist one scored name in a single transaction: write the COMPUTED.SCORE
   * lake object (lineage), upsert public.scores → it, upsert score_history for
   * today, compute weekly_delta from ~7 days ago, and diff vs yesterday into
   * score_events.
   */
  private async persist(row: UniverseRow, res: ScoreResult, agentId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const objectId = await this.writeComputedObject(tx, row, res, agentId);
      const prior = await this.loadPriorScore(tx, row.id);
      const weekAgo = await this.loadWeekAgoScore(tx, row.id);
      const weeklyDelta = weekAgo !== null ? res.score - weekAgo : null;

      await this.upsertScores(tx, row.id, res, weeklyDelta, objectId);
      await this.upsertScoreHistory(tx, row.id, res);
      await this.emitEvents(tx, row.id, res, prior);
    });
  }

  /** Write COMPUTED.SCORE lake object (VERIFIED) with supersede-then-insert
   *  discipline — copies KeyRatiosRecompute.writeComputedObject exactly. */
  private async writeComputedObject(
    tx: LakeTx,
    row: UniverseRow,
    res: ScoreResult,
    agentId: string,
  ): Promise<string> {
    const naturalKey = `COMPUTED.SCORE:${row.venue_code}:${row.id}`;
    const payload = scorePayload(res);

    const parseRun = await tx<{ id: string }>`
      insert into lake.parse_runs (agent_id, parser_key, parser_version, status)
      values (${agentId}, 'score_batch', '1', 'running')
      returning id
    `;
    const parseRunId = parseRun[0].id;

    // Supersede the prior live COMPUTED.SCORE object for this key, if any.
    const live = await tx<{ id: string; state: string; revision: number }>`
      select id, state, revision from lake.objects
      where natural_key = ${naturalKey} and superseded_by is null
      limit 1
    `;

    let revision = 1;
    let newId: string;
    if (live[0]) {
      revision = live[0].revision + 1;
      const alloc = await tx<{ id: string }>`select gen_random_uuid() as id`;
      newId = alloc[0].id;
      // Retire the previous VERIFIED computed row (VERIFIED→RETIRED).
      await tx`
        update lake.objects
        set superseded_by = ${newId}, state = 'RETIRED'
        where id = ${live[0].id}
      `;
      await tx`
        insert into lake.objects (
          id, object_type, natural_key, security_id, venue_code, payload,
          numeric_value, state, revision, parse_run_id, source_rank
        ) values (
          ${newId}, ${'COMPUTED.SCORE'}, ${naturalKey}, ${row.id}, ${row.venue_code},
          ${payload}, ${res.score}, ${'PENDING'}, ${revision}, ${parseRunId}, ${10}
        )
      `;
      await tx`update lake.objects set state = 'VERIFIED', verified_by = ${agentId} where id = ${newId}`;
    } else {
      const inserted = await tx<{ id: string }>`
        insert into lake.objects (
          object_type, natural_key, security_id, venue_code, payload,
          numeric_value, state, revision, parse_run_id, source_rank
        ) values (
          ${'COMPUTED.SCORE'}, ${naturalKey}, ${row.id}, ${row.venue_code},
          ${payload}, ${res.score}, ${'PENDING'}, ${1}, ${parseRunId}, ${10}
        )
        returning id
      `;
      newId = inserted[0].id;
      await tx`update lake.objects set state = 'VERIFIED', verified_by = ${agentId} where id = ${newId}`;
    }

    await tx`update lake.parse_runs set status = 'succeeded', finished_at = now() where id = ${parseRunId}`;
    return newId;
  }

  /** Yesterday's published scores row, if any (for the score_events diff). */
  private async loadPriorScore(tx: LakeTx, securityId: string): Promise<PriorScoreRow | null> {
    const rows = await tx<{ security_id: string; score: number; rating: string; grades: Record<string, string | null> }>`
      select security_id, score, rating, grades
      from public.score_history
      where security_id = ${securityId}
        and computed_on < current_date
      order by computed_on desc
      limit 1
    `;
    return rows[0] ?? null;
  }

  /** The score ~7 days ago (nearest history row at/older than 7 days back) → weekly_delta. */
  private async loadWeekAgoScore(tx: LakeTx, securityId: string): Promise<number | null> {
    const rows = await tx<{ score: number }>`
      select score
      from public.score_history
      where security_id = ${securityId}
        and computed_on <= current_date - 7
      order by computed_on desc
      limit 1
    `;
    return rows[0]?.score ?? null;
  }

  private async upsertScores(
    tx: LakeTx,
    securityId: string,
    res: ScoreResult,
    weeklyDelta: number | null,
    objectId: string,
  ): Promise<void> {
    await tx`
      insert into public.scores (
        security_id, score, rating, weekly_delta,
        grade_value, grade_growth, grade_profitability, grade_momentum, grade_revisions,
        sector_percentile, sector_peer_count, computed_at, source_object_id
      ) values (
        ${securityId}, ${res.score}, ${res.rating}, ${weeklyDelta},
        ${res.grades.value}, ${res.grades.growth}, ${res.grades.profitability},
        ${res.grades.momentum}, ${res.grades.revisions},
        ${res.sectorPercentile}, ${res.sectorPeerCount}, now(), ${objectId}
      )
      on conflict (security_id) do update set
        score = excluded.score,
        rating = excluded.rating,
        weekly_delta = excluded.weekly_delta,
        grade_value = excluded.grade_value,
        grade_growth = excluded.grade_growth,
        grade_profitability = excluded.grade_profitability,
        grade_momentum = excluded.grade_momentum,
        grade_revisions = excluded.grade_revisions,
        sector_percentile = excluded.sector_percentile,
        sector_peer_count = excluded.sector_peer_count,
        computed_at = excluded.computed_at,
        source_object_id = excluded.source_object_id
    `;
  }

  private async upsertScoreHistory(tx: LakeTx, securityId: string, res: ScoreResult): Promise<void> {
    const grades = gradesJson(res);
    await tx`
      insert into public.score_history (
        security_id, computed_on, score, rating, grades, sector_percentile
      ) values (
        ${securityId}, current_date, ${res.score}, ${res.rating}, ${grades}, ${res.sectorPercentile}
      )
      on conflict (security_id, computed_on) do update set
        score = excluded.score,
        rating = excluded.rating,
        grades = excluded.grades,
        sector_percentile = excluded.sector_percentile
    `;
  }

  /**
   * Diff today's result vs yesterday's history row → score_events (07 §3.5):
   *   score_change  when the numeric score moved,
   *   rating_change when the rating band changed,
   *   grade_change  once per factor whose letter grade changed.
   * No prior row (a first-ever score) emits no events — it's not a change.
   */
  private async emitEvents(
    tx: LakeTx,
    securityId: string,
    res: ScoreResult,
    prior: PriorScoreRow | null,
  ): Promise<void> {
    if (!prior) return;

    if (prior.score !== res.score) {
      await tx`
        insert into public.score_events (security_id, event_kind, old_value, new_value, detail)
        values (${securityId}, ${'score_change'}, ${String(prior.score)}, ${String(res.score)},
                ${{ delta: res.score - prior.score }})
      `;
    }

    if (prior.rating !== res.rating) {
      await tx`
        insert into public.score_events (security_id, event_kind, old_value, new_value, detail)
        values (${securityId}, ${'rating_change'}, ${prior.rating}, ${res.rating}, ${null})
      `;
    }

    const nextGrades = gradesJson(res);
    const priorGrades = prior.grades ?? {};
    for (const factor of ['value', 'growth', 'profitability', 'momentum', 'revisions'] as const) {
      const from = priorGrades[factor] ?? null;
      const to = nextGrades[factor] ?? null;
      if (from !== to) {
        await tx`
          insert into public.score_events (security_id, event_kind, old_value, new_value, detail)
          values (${securityId}, ${'grade_change'}, ${from}, ${to}, ${{ factor, from, to }})
        `;
      }
    }
  }

  private async resolveAgent(): Promise<string> {
    if (this.computeAgentId) return this.computeAgentId;
    const rows = await this.sql<{ id: string }>`
      select id from iam.principals where handle = ${this.computeHandle} limit 1
    `;
    if (rows.length === 0) {
      throw new Error(`score_batch compute principal not found: handle=${this.computeHandle}`);
    }
    this.computeAgentId = rows[0].id;
    return this.computeAgentId;
  }
}

/** Project a joined universe row into the engine's ScoreInput.
 *  Value uses earnings YIELD (E/P), not 1/pe, so a loss ranks at the bottom
 *  instead of nulling: prefer eps_ttm/last (sign-preserving), else 1/pe. */
function toScoreInput(r: UniverseRow): ScoreInput {
  const last = num(r.last);
  const epsTtm = num(r.eps_ttm);
  const pe = num(r.pe);
  const earningsYield =
    epsTtm !== null && last !== null && last !== 0
      ? epsTtm / last
      : pe !== null && pe !== 0
        ? 1 / pe
        : null;

  return {
    securityId: Number(r.id),
    venue: r.venue_code,
    sector: r.sector,
    earningsYield,
    pb: num(r.pb),
    evEbitda: num(r.ev_ebitda),
    dividendYield: num(r.dividend_yield),
    epsGrowthYoy: num(r.eps_growth_yoy),
    revGrowthYoy: num(r.rev_growth_yoy),
    epsCagr3y: num(r.eps_cagr_3y),
    revCagr3y: num(r.rev_cagr_3y),
    roe: num(r.roe),
    roce: num(r.roce),
    nim: num(r.nim),
    netMargin: num(r.net_margin),
    grossMargin: num(r.gross_margin),
    ret12_1: num(r.ret_12_1),
    ret6m: num(r.ret_6m),
    ret3m: num(r.ret_3m),
    last,
    week52High: num(r.week52_high),
    week52Low: num(r.week52_low),
  };
}

/** The COMPUTED.SCORE lake-object payload. NB: NO metric_key (flat public.scores
 *  row, not a datapoint series) → the 0007 fan-out short-circuits. */
function scorePayload(res: ScoreResult): Record<string, unknown> {
  return {
    score: res.score,
    rating: res.rating,
    composite: res.composite,
    factor_scores: res.factorScores,
    grades: gradesJson(res),
    sector_percentile: res.sectorPercentile,
    sector_peer_count: res.sectorPeerCount,
    thin_cohort: res.thinCohort,
  };
}

/** score_history.grades jsonb / score_events comparison map. */
function gradesJson(res: ScoreResult): Record<string, string | null> {
  return {
    value: res.grades.value,
    growth: res.grades.growth,
    profitability: res.grades.profitability,
    momentum: res.grades.momentum,
    revisions: res.grades.revisions,
  };
}

/** Parse a numeric-over-the-wire string to a finite number, else null. */
function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
