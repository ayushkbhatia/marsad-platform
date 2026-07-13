import type { Sql } from '../db.js';
import type { Handler, HandlerContext } from './index.js';

/**
 * ohlcv_accrual (P1.7a, 07-lake-enrichment.md family B — EOD accrual path).
 *
 * Once per trading day, project the day's DELAYED quote-board close into one
 * public.ohlcv_daily bar per listed security, for ALL 6 venues — so price history
 * accrues going forward regardless of Yahoo backfill depth or whether a venue
 * EOD-bulletin adapter exists yet. All the work is a single idempotent SQL upsert
 * (public.accrue_ohlcv_from_quotes, migration 0028); this handler is the thin
 * orchestration seam: pick the trade date, invoke the function, heartbeat.
 *
 * Board accrual is the LOWEST-fidelity OHLCV source, so accrue_ohlcv_from_quotes
 * is ADDITIVE ONLY (on conflict do nothing): it fills days no higher-fidelity bar
 * exists for and never clobbers a venue EOD bulletin / Yahoo bar. Those layer over
 * the same (security_id, trade_date) via the lake.objects→ohlcv_daily trigger
 * (path a), which overwrites a prior board bar. Running this handler repeatedly for
 * the same date is safe (no-op on already-present bars).
 *
 * DELAYED-DATA HONESTY: the close written is the ≥15-min-delayed board last; the
 * bar is end-of-day history, never a realtime figure.
 *
 * Payload: { tradeDate?: 'YYYY-MM-DD' } — omitted ⇒ the current UTC date. The
 * enqueuer (pg_cron, per venue at close+) should pass the venue-local trade date;
 * the SQL function itself filters quotes_latest to boards captured on that date,
 * so a wrong/absent date simply accrues fewer (or zero) bars rather than bogus ones.
 */

const JOB_NAME = 'ohlcv_accrual';
const EXPECTED_INTERVAL_S = 24 * 60 * 60;

interface OhlcvAccrualPayload {
  handler?: 'ohlcv_accrual';
  tradeDate?: string;
}

function resolveTradeDate(raw: unknown): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

export function makeOhlcvAccrual(): Handler {
  return async (payloadRaw, ctx: HandlerContext) => {
    const payload = payloadRaw as unknown as OhlcvAccrualPayload;
    const tradeDate = resolveTradeDate(payload.tradeDate);
    const log = ctx.log.child({ handler: JOB_NAME, tradeDate });

    await heartbeatRun(ctx.sql);
    try {
      const rows = await ctx.sql<{ n: number }[]>`
        select public.accrue_ohlcv_from_quotes(${tradeDate}::date) as n
      `;
      const barsWritten = rows.length > 0 ? Number(rows[0]!.n) : 0;
      await heartbeatOk(ctx.sql);
      log.info('ohlcv_accrual done', { barsWritten });
    } catch (err) {
      await heartbeatError(ctx.sql, err);
      throw err;
    }
  };
}

// ── heartbeat (single global job, not venue-keyed) ───────────────────────────

async function heartbeatRun(sql: Sql): Promise<void> {
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now())
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s, last_run_at = now()
    `;
  } catch {
    /* best effort — never mask the job */
  }
}

async function heartbeatOk(sql: Sql): Promise<void> {
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_ok_at, consecutive_failures)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now(), now(), 0)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(), last_ok_at = now(),
            last_error = null, consecutive_failures = 0
    `;
  } catch {
    /* best effort */
  }
}

async function heartbeatError(sql: Sql, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  try {
    await sql`
      insert into ops.job_heartbeats (job_name, expected_interval_s, last_run_at, last_error, consecutive_failures)
      values (${JOB_NAME}, ${EXPECTED_INTERVAL_S}, now(), ${message}, 1)
      on conflict (job_name) do update
        set expected_interval_s = excluded.expected_interval_s,
            last_run_at = now(), last_error = ${message},
            consecutive_failures = ops.job_heartbeats.consecutive_failures + 1
    `;
  } catch {
    /* best effort */
  }
}
