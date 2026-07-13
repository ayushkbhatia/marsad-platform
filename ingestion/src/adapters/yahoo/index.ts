// ingestion/src/adapters/yahoo/index.ts
//
// Yahoo Finance adapter — the CROSS-CHECK partner + historical-backfill source for TDWL/QE/DFM.
//
// Yahoo (query1.finance.yahoo.com) is an AGGREGATOR spanning three venues, not a single venue, so —
// exactly like ingestion/src/adapters/mubasher — it does NOT own a VenueAdapter of its own and is NOT
// a key in the frozen ADAPTERS map (which is Record<VenueCode, VenueAdapter>; VenueCode has no
// 'YAHOO'). Instead it SUPPLIES TaskSpecs that the runtime mounts per venue:
//   * yahooQuotes  (data_type 'quotes')          — the 2nd source per venue for the cross-check.
//   * yahooOhlcv   (data_type 'ohlcv_backfill')  — the ≥2y daily backfill drain.
//
// ── WIRING (READ — cross-scope, out of this adapter's assigned paths) ───────────────────────────
// The worker/runtime resolves a source's parser purely by (venue, data_type) via the ADAPTERS map
// (runtime.tasksForSource → tasksForDataType → ADAPTERS[venue].quotes …). There is NO parser_key on
// ingest.sources (see migration 0019's note). Consequently, to actually RUN these Yahoo TaskSpecs the
// runtime layer needs TWO changes that live OUTSIDE this adapter's assigned paths and are therefore
// deliberately NOT made here (flagged in the migration + build notes):
//
//   (A) Second 'quotes' source per venue. This migration adds a Yahoo 'quotes' row alongside the
//       primary (distinct entry_url ⇒ the (venue,data_type,entry_url) unique key allows it). But
//       tasksForDataType('quotes') returns adapter.quotes — the SINGLE primary slot — so both the
//       primary and the Yahoo source would resolve to the primary task. The runtime needs to select
//       the Yahoo task for the Yahoo source (e.g. an endpoint_config.provider='yahoo' discriminant, or
//       a per-source task registry). Until then, the Yahoo 'quotes' source is seeded active=false.
//
//   (B) ohlcv_backfill routing. 'ohlcv_backfill' is a valid DataType, but runtime.tasksForDataType has
//       no case for it (only 'eod_bulletin' → adapter.eodBulletin). The runtime needs an
//       'ohlcv_backfill' → yahooOhlcv branch. yahooOhlcv is exposed on the yahooTasks bundle below and
//       (as a NormalizedOhlcv TaskSpec) is shape-compatible with the eodBulletin slot for the day the
//       runtime mounts it.
//
// The PURE parsers + symbol mapping — the load-bearing, cross-check-correctness deliverables — are
// complete and fixture-tested independent of that wiring.

import type { TaskSpec, NormalizedQuote, NormalizedOhlcv } from '../../core/types.js';
import { yahooQuotes, YAHOO_QUOTES_PARSER_VERSION } from './quotes.js';
import { yahooOhlcv, YAHOO_OHLCV_PARSER_VERSION } from './ohlcv.js';

/**
 * The Yahoo TaskSpec bundle. Consumed by the runtime/worker once the (venue,data_type)→Yahoo routing
 * lands (see wiring note (A)/(B)). Keyed by the logical task name, NOT by venue — Yahoo serves all
 * three covered venues from the same per-symbol endpoint; the venue is carried on each NormalizedQuote
 * / NormalizedOhlcv row (recovered from the Yahoo symbol suffix, symbols.fromYahooSymbol).
 */
export const yahooTasks: {
  quotes: TaskSpec<NormalizedQuote>;
  ohlcvBackfill: TaskSpec<NormalizedOhlcv>;
} = {
  quotes: yahooQuotes,
  ohlcvBackfill: yahooOhlcv,
};

export { yahooQuotes, YAHOO_QUOTES_PARSER_VERSION, fetchYahooQuotes, parseYahooQuote, mapYahooMeta, epochSecondsToIso } from './quotes.js';
export { yahooOhlcv, YAHOO_OHLCV_PARSER_VERSION, fetchYahooOhlcv, parseYahooOhlcv, barTradeDate } from './ohlcv.js';
export { toYahooSymbol, fromYahooSymbol, isYahooVenue } from './symbols.js';
export type { YahooVenue } from './symbols.js';

export default yahooTasks;
