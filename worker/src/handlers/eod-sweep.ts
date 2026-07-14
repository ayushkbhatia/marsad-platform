import type { Sql } from '../db.js';
import type { Handler, HandlerContext } from './index.js';
import type { IngestionRuntime, RunTaskResult, SourceRecord, VenueCode } from './ingestion-runtime.js';
import type { EodSweepPayload } from './payloads.js';
import { resolveActiveAgent, AgentPausedError } from './identity.js';
import { logFetchFailure, logFetchSkipped } from './fetch-log.js';
import { enqueueCrossCheckForKeys } from './quote-poll.js';
import { heartbeatRun, heartbeatOk, heartbeatError } from './job-heartbeat.js';

/**
 * How long after the venue close the EOD bulletin remains fetch-eligible. The
 * bulletin publishes ~close+30 (CONTRACT §8); we allow a generous tail so a late
 * publish or a delayed wake-up still runs, but reject runs far from the close
 * (e.g. the 60-min keep-alive schedule firing mid-session or overnight).
 */
const POST_CLOSE_WINDOW_MINUTES = 180;

/**
 * Confirm now() is within [close, close + POST_CLOSE_WINDOW] in the venue's
 * local time AND the venue-local date equals the payload tradeDate. This is the
 * close-gate the handler doc / seed migration promise ("self-gates on the venue
 * close", "runs at close+30"): the coarse 60-min eod_bulletin schedule fires
 * around the clock, so without this guard the handler would fetch the bulletin
 * on every tick. Reads public.market_sessions / public.venues via the same
 * calendar tables ingest.venue_is_open uses, so the holiday/session semantics
 * match the scheduler.
 *
 * Returns { open: true } when the run is inside the post-close window, else
 * { open: false, reason } describing why it was skipped (for the fetch_log /
 * logs). A venue with no session row for the trade date is treated as closed.
 */
export async function eodCloseGate(
  sql: Sql,
  venue: VenueCode,
  tradeDate: string,
): Promise<{ open: true } | { open: false; reason: string }> {
  const rows = (await sql`
    with v as (
      select timezone from public.venues where code = ${venue} and is_active
    ),
    now_local as (
      select (now() at time zone (select timezone from v)) as ts
    ),
    session as (
      select ms.close_local
      from public.market_sessions ms
      where ms.venue_code = ${venue}
        and ms.effective_from <= ${tradeDate}::date
        and (ms.effective_to is null or ms.effective_to >= ${tradeDate}::date)
      order by ms.effective_from desc
      limit 1
    )
    select
      (select ts from now_local)                                   as local_ts,
      (select (ts)::date from now_local)                           as local_date,
      (select close_local from session)                            as close_local,
      (select exists (select 1 from v))                            as venue_active
  `) as unknown as Array<{
    local_ts: string | null;
    local_date: string | null;
    close_local: string | null;
    venue_active: boolean;
  }>;

  const row = rows[0];
  if (!row || !row.venue_active) {
    return { open: false, reason: 'venue_inactive_or_unknown' };
  }
  if (!row.close_local) {
    return { open: false, reason: 'no_session_for_trade_date' };
  }
  if (row.local_date !== tradeDate) {
    return { open: false, reason: `local_date ${row.local_date} != tradeDate ${tradeDate}` };
  }

  // Compare the local wall-clock time against [close, close + window]. Work in
  // minutes-since-midnight so we avoid tz-arithmetic in JS.
  const localTime = (row.local_ts ?? '').slice(11, 19); // 'HH:MM:SS'
  const nowMin = hmsToMinutes(localTime);
  const closeMin = hmsToMinutes(row.close_local);
  if (nowMin === null || closeMin === null) {
    return { open: false, reason: 'unparseable_time' };
  }
  if (nowMin < closeMin) {
    return { open: false, reason: 'before_close' };
  }
  if (nowMin > closeMin + POST_CLOSE_WINDOW_MINUTES) {
    return { open: false, reason: 'past_post_close_window' };
  }
  return { open: true };
}

function hmsToMinutes(hms: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hms);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * eod_sweep (CONTRACT §9) — q_ingest.
 *
 * At close+30 for a venue, pull the EOD bulletin (the OHLCV source of record,
 * CONTRACT §6.3) and the final quote board. Same snapshot-first pipeline; the
 * bulletin is a second independent source for the day's close, so the resulting
 * staged keys are prime cross_check candidates against the intraday board.
 *
 * Payload is venue-scoped, not source-scoped: the handler resolves the venue's
 * eod_bulletin (and any final-board) sources from the runtime. tradeDate is
 * carried through the runtime so parsers/staging stamp the right trade_date.
 */
export function makeEodSweep(runtime: IngestionRuntime): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as EodSweepPayload;
    const venue = payload.venue;
    const tradeDate = payload.tradeDate;
    if (!venue) {
      throw new Error(`eod_sweep: missing venue in payload: ${JSON.stringify(payloadRaw)}`);
    }
    if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`eod_sweep: missing/invalid tradeDate (YYYY-MM-DD): ${JSON.stringify(payloadRaw)}`);
    }

    const log = ctx.log.child({ handler: 'eod_sweep', venue, tradeDate });
    const startedAt = Date.now();

    // Per-venue heartbeat so a venue's EOD feed going silent is detectable
    // (CONTRACT §9). Recorded before the close-gate so an intentional skip still
    // refreshes last_run_at (a skip is not silence).
    await heartbeatRun(ctx.sql, 'eod_sweep', venue);

    // Close-gate: the eod_bulletin schedule is a coarse 60-min keep-alive that
    // fires around the clock (0017); this handler must only fetch inside the
    // venue's post-close window for the given trade date (CONTRACT §8 "close+30",
    // handler self-gates). Outside it, skip cleanly (skipped_closed) — do not
    // fetch, do not fail.
    let gate;
    try {
      gate = await eodCloseGate(ctx.sql, venue, tradeDate);
    } catch (err) {
      log.error('eod_sweep: close-gate check failed', { err });
      await heartbeatError(ctx.sql, 'eod_sweep', venue, err);
      throw err;
    }
    if (!gate.open) {
      log.info('eod_sweep skipped: outside post-close window', { reason: gate.reason });
      await heartbeatOk(ctx.sql, 'eod_sweep', venue);
      return;
    }

    // Resolve the EOD sources for this venue (eod_bulletin is the primary; a
    // venue may also expose a final board). The runtime owns the sources → the
    // handler asks for the venue's eod sources.
    let sources: SourceRecord[];
    try {
      sources = await runtime.eodSourcesForVenue(venue);
    } catch (err) {
      log.error('eod_sweep: failed to resolve eod sources', { err });
      throw err;
    }

    const active = sources.filter((s) => s.active);
    if (active.length === 0) {
      log.warn('eod_sweep: no active eod sources for venue');
      await heartbeatOk(ctx.sql, 'eod_sweep', venue);
      return;
    }

    // All EOD sources for a venue attribute to the same venue DATA agent.
    const agentAccount = runtime.agentAccountForSource(active[0]!);

    let results: RunTaskResult[];
    try {
      // Kill-switch check only — NO transaction. Like quote_poll, the body is pure runtime.runTask
      // (runs on the runtime's own connection + sets its own identity), so a held handler tx just
      // deadlocks the pool under concurrency. resolveActiveAgent = same kill-switch check, no tx.
      const identity = await resolveActiveAgent(ctx.sql, agentAccount);
      const out: RunTaskResult[] = [];
      for (const source of active) {
        for (const task of runtime.tasksForSource(source)) {
          out.push(
            await runtime.runTask({
              source,
              task,
              agentPrincipalId: identity.principalId,
              tradeDate,
            }),
          );
        }
      }
      results = out;
    } catch (err) {
      if (err instanceof AgentPausedError) {
        log.info('eod_sweep skipped: agent paused', { agentAccount });
        for (const s of active) await logFetchSkipped(ctx.sql, s.id, 'agent_paused');
        await heartbeatOk(ctx.sql, 'eod_sweep', venue);
        return;
      }
      // Attribute the failure to the first source's fetch_log for the Desk trail.
      await logFetchFailure(ctx.sql, active[0]!.id, err, Date.now() - startedAt);
      await heartbeatError(ctx.sql, 'eod_sweep', venue, err);
      throw err;
    }

    const enqueued = await enqueueCrossCheckForKeys(ctx, runtime, results);

    await heartbeatOk(ctx.sql, 'eod_sweep', venue);
    const rowsEmitted = results.reduce((n, r) => n + r.rowsEmitted, 0);
    log.info('eod_sweep done', {
      sources: active.length,
      rowsEmitted,
      crossChecksEnqueued: enqueued,
    });
  };
}
