import { registerHandler } from './index.js';
import type { IngestionRuntime } from './ingestion-runtime.js';
import type { HandlerName } from './payloads.js';
import { makeQuotePoll } from './quote-poll.js';
import { makeEodSweep } from './eod-sweep.js';
import { makeFilingsPoll } from './filings-poll.js';
import { makeFilingsDetailPoll } from './filings-detail-poll.js';
import { makeCrossCheck } from './cross-check.js';
import { makeKeyRatiosRecompute } from './key-ratios-recompute.js';
import { makeOhlcvAccrual } from './ohlcv-accrual.js';
import { makeScoreBatch } from './score-batch.js';
import { makeNightly } from './nightly.js';
import { makeStoragePurge } from './storage-purge.js';

/**
 * Register the P1 ingestion handlers (CONTRACT §9) against a live
 * IngestionRuntime. Called once from the worker entrypoint after the runtime is
 * built. Every handler is a thin orchestrator: identity → runtime pipeline →
 * follow-up enqueues; the consumer owns pgmq archive + the queue-level
 * heartbeat around each message.
 *
 *   quote_poll             q_ingest       venue quotes (+ folded indices)
 *   eod_sweep              q_ingest       close+30 EOD bulletin + final board
 *   filings_poll           q_ingest       filings list-diff → filing_detail enqueue
 *   cross_check            q_pipeline     2-source rule → VERIFIED lake.objects
 *   key_ratios_recompute   q_pipeline     nightly public.key_ratios rebuild
 *   ohlcv_accrual          q_pipeline     daily quote-board close → ohlcv_daily (P1.7a)
 *   nightly                q_maintenance  02:00 GST omnibus → key_ratios rebuild (P1.7)
 *   score_batch            q_maintenance  04:00 GST Marsad Score re-rank (P1.7c)
 *   storage_purge          q_maintenance  daily lake-raw Storage-API delete of purged blobs (02 §3)
 */
export function registerIngestionHandlers(runtime: IngestionRuntime): HandlerName[] {
  const registrations: Array<[HandlerName, ReturnType<typeof makeQuotePoll>]> = [
    ['quote_poll', makeQuotePoll(runtime)],
    ['eod_sweep', makeEodSweep(runtime)],
    ['filings_poll', makeFilingsPoll(runtime)],
    ['filings_detail_poll', makeFilingsDetailPoll(runtime)],
    ['cross_check', makeCrossCheck(runtime)],
    ['key_ratios_recompute', makeKeyRatiosRecompute(runtime)],
    ['ohlcv_accrual', makeOhlcvAccrual()],
    ['nightly', makeNightly(runtime)],
    ['score_batch', makeScoreBatch(runtime)],
    ['storage_purge', makeStoragePurge()],
  ];

  for (const [name, handler] of registrations) {
    registerHandler(name, handler);
  }

  return registrations.map(([name]) => name);
}
