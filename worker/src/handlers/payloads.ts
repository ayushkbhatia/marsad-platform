import type { VenueCode } from './ingestion-runtime.js';

/**
 * Frozen pgmq job envelope + payloads (CONTRACT §9). Every pgmq message body is
 * a JSON object with a `handler` key naming a registered handler; the rest is
 * the payload. These types are the frozen shapes other producers (pg_cron
 * enqueue fns, lake triggers, the poller) must emit.
 */

export type HandlerName =
  | 'quote_poll'
  | 'eod_sweep'
  | 'filings_poll'
  | 'cross_check'
  | 'key_ratios_recompute'
  | 'ohlcv_accrual';

export interface QuotePollPayload {
  handler: 'quote_poll';
  sourceId: number;
}

export interface EodSweepPayload {
  handler: 'eod_sweep';
  venue: VenueCode;
  tradeDate: string;
}

export interface FilingsPollPayload {
  handler: 'filings_poll';
  sourceId: number;
}

export interface CrossCheckPayload {
  handler: 'cross_check';
  naturalKey: string;
  objectType: string;
}

export interface KeyRatiosPayload {
  handler: 'key_ratios_recompute';
  securityIds?: number[];
}

/**
 * P1.7a EOD accrual (07-lake-enrichment.md family B): project the day's delayed
 * quote-board close into one public.ohlcv_daily bar per listed security for all 6
 * venues. tradeDate omitted ⇒ current UTC date (the enqueuer should pass the
 * venue-local trade date at close+).
 */
export interface OhlcvAccrualPayload {
  handler: 'ohlcv_accrual';
  tradeDate?: string;
}
