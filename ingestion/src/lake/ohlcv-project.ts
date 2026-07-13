/**
 * OHLCV projection — the seam that lands NormalizedOhlcv bars into
 * public.ohlcv_daily (CONTRACT §6.3; 07-lake-enrichment.md family B, P1.7a).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * The lake ingests QUOTES + FILINGS and materializes lake.objects, but nothing
 * projected OHLCV.CLOSE objects into public.ohlcv_daily — the price-history table
 * the charts and the Score's Momentum factor (≥126 daily bars) both need. That
 * was THE critical gap P1.7a closes.
 *
 * TWO WRITE PATHS, ONE TABLE
 *   (a) lake.objects (OHLCV.CLOSE) → ohlcv_daily.  Owned by the SQL trigger
 *       lake.fn_ohlcv_daily_project() (migration 0028). Fires on INSERT *and*
 *       UPDATE because a single-source OHLCV bar (Yahoo-only backfill, or a lone
 *       venue bulletin) stays PENDING — cross-check INSERTs it PENDING and never
 *       UPDATEs it, so a VERIFIED-only / UPDATE-only trigger would miss every
 *       backfill bar. See migration 0028 header for the state rationale.
 *   (b) EOD accrual from the quote board close (public.accrue_ohlcv_from_quotes,
 *       migration 0028) — one bar/security/trading-day for ALL 6 venues going
 *       forward, independent of whether a venue EOD-bulletin adapter exists.
 *
 * WHAT THIS MODULE OWNS (the direct TS upsert path)
 * ohlcv_daily is a plain historical series keyed (security_id, trade_date), NOT a
 * cross-checked/VERIFIED fact — a single authoritative source per bar is
 * acceptable (owner decision D-src-1, per-venue verification tier; prices are
 * DELAYED and non-price-sensitive). So this module offers a *direct idempotent
 * upsert* that a caller with resolved security_ids can use to drain a batch of
 * NormalizedOhlcv rows straight into ohlcv_daily, bypassing the lake-object round
 * trip. The SQL trigger (path a) is the default in production; this direct writer
 * is the unit-testable core of the same mapping and a backfill fast-path.
 *
 * PURITY: the mapping (normalizedOhlcvToDailyRow) is a pure function — no I/O, no
 * Date.now() — so it is golden-testable. The writer is the only impure part.
 */

import type { LakeSql, LakeLogger } from './db.js';
import { noopLogger } from './db.js';
import type { NormalizedOhlcv } from './contract-types.js';

/** One public.ohlcv_daily row (0005 DDL). close is NOT NULL; the rest nullable. */
export interface OhlcvDailyRow {
  securityId: number;
  tradeDate: string; // 'YYYY-MM-DD'
  open: number | null;
  high: number | null;
  low: number | null;
  close: number; // NOT NULL — the source of record
  volume: number | null;
  valueTraded: number | null;
}

/** Finite-number guard: absent/null/NaN/±Inf → null; genuine zeros survive. */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * PURE map: one NormalizedOhlcv (with a resolved security_id) → one OhlcvDailyRow.
 * Returns null when the bar cannot produce a valid ohlcv_daily row:
 *   - no resolvable security_id (FK would fail; securities not bootstrapped), or
 *   - a null / non-finite close (ohlcv_daily.close is NOT NULL — the parsers
 *     already skip these, but we re-guard so a bad row can never reach the DB).
 */
export function normalizedOhlcvToDailyRow(
  o: NormalizedOhlcv,
  securityId: number | null | undefined,
): OhlcvDailyRow | null {
  if (securityId === null || securityId === undefined || !Number.isFinite(securityId)) return null;
  const close = numOrNull(o.close);
  if (close === null) return null; // NOT NULL constraint — never emit a null-close bar
  if (!o.tradeDate) return null;
  return {
    securityId,
    tradeDate: o.tradeDate,
    open: numOrNull(o.open),
    high: numOrNull(o.high),
    low: numOrNull(o.low),
    close,
    volume: numOrNull(o.volume),
    valueTraded: numOrNull(o.valueTraded),
  };
}

/**
 * PURE: map a batch of NormalizedOhlcv (each paired with its resolved
 * security_id) → OhlcvDailyRow[], dropping bars that cannot produce a valid row.
 * The `resolve` callback maps (venue, ticker) → security_id (from public.securities);
 * a null result silently drops the bar (unlisted / not-yet-bootstrapped ticker).
 */
export function mapOhlcvBatch(
  rows: NormalizedOhlcv[],
  resolve: (venue: string, ticker: string) => number | null | undefined,
): OhlcvDailyRow[] {
  const out: OhlcvDailyRow[] = [];
  for (const o of rows) {
    const row = normalizedOhlcvToDailyRow(o, resolve(o.venue, o.ticker));
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * Idempotent upsert of OhlcvDailyRow[] into public.ohlcv_daily.
 *
 * The conflict target is the natural PK (security_id, trade_date): re-running a
 * backfill, replaying a snapshot, or a later higher-fidelity source (venue
 * bulletin over a Yahoo bar) all CONVERGE on the same row — the last writer wins
 * the O/H/L/V/value_traded fields, close is always present. Safe to call
 * repeatedly. Returns the number of rows written (attempted upserts).
 *
 * Per-row inserts keep the semantics obvious and portable across the in-memory
 * fake used in unit tests; batch sizes here are small (one symbol's 2y = ~500
 * bars, one venue's daily bulletin = a few hundred securities).
 */
export async function projectOhlcvDaily(
  sql: LakeSql,
  rows: OhlcvDailyRow[],
  log: LakeLogger = noopLogger,
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  for (const r of rows) {
    await sql`
      insert into public.ohlcv_daily
        (security_id, trade_date, open, high, low, close, volume, value_traded)
      values
        (${r.securityId}, ${r.tradeDate}, ${r.open}, ${r.high}, ${r.low},
         ${r.close}, ${r.volume}, ${r.valueTraded})
      on conflict (security_id, trade_date) do update set
        open         = excluded.open,
        high         = excluded.high,
        low          = excluded.low,
        close        = excluded.close,
        volume       = excluded.volume,
        value_traded = excluded.value_traded
    `;
    written += 1;
  }
  log.info('ohlcv.project', { rows: written });
  return written;
}
