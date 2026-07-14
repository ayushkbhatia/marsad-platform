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
  | 'ohlcv_accrual'
  | 'score_batch'
  | 'nightly';

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

/**
 * P1.7c Marsad Score batch (07 §3.6, 04:00 GST). The score_batch pg_cron enqueues
 * {"task":"score_batch"} to q_maintenance; the consumer aliases `task`→`handler`.
 * Re-ranks the eligible universe off fresh key_ratios into public.scores /
 * score_history / score_events (+ COMPUTED.SCORE lake objects). Optional
 * securityIds narrows the batch (e.g. an earnings-verdict single-name recompute);
 * omitted ⇒ full universe.
 */
export interface ScoreBatchPayload {
  handler: 'score_batch';
  securityIds?: number[];
}

/**
 * P1.7 nightly omnibus (07 §3.6, 02:00 GST). The nightly_omnibus pg_cron enqueues
 * {"task":"nightly"}; the consumer aliases `task`→`handler`. Runs the nightly
 * key_ratios recompute (the complete-table job that must finish before the 04:00
 * score_batch's percentiles are valid).
 */
export interface NightlyPayload {
  handler: 'nightly';
}
