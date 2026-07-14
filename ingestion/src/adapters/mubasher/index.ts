// ingestion/src/adapters/mubasher/index.ts
//
// Mubasher aggregator adapters. Mubasher (english.mubasher.info) is an aggregator, not a venue, so
// it has no VenueAdapter of its own — it supplies TaskSpecs that venue adapters mount. Today it
// backs TDWL quotes (owner hybrid decision: saudiexchange.sa is Akamai-IP-blocked, GROUND TRUTH #3)
// and the ADX/MSX/BHB ≥2y daily OHLCV backfill (ohlcv-csv.ts, routed by provider='mubasher_csv').
// adapters/tdwl/quotes.ts re-exports mubasherTdwlQuotes as the production `tdwlQuotes` task.

import type { NormalizedOhlcv, TaskSpec } from "../../core/types.js";
import { mubasherOhlcvCsv } from "./ohlcv-csv.js";

/**
 * The Mubasher TaskSpec bundle. Consumed by runtime.tasksForProvider once the provider='mubasher_csv'
 * routing resolves a source to it. Keyed by the logical task name, NOT by venue — like Yahoo,
 * Mubasher serves multiple venues from the same per-ticker endpoint; the venue is carried on each
 * NormalizedOhlcv row (recovered by the parser from snapshot.meta.venue, stamped by fetch).
 */
export const mubasherTasks: { ohlcvCsv: TaskSpec<NormalizedOhlcv> } = {
  ohlcvCsv: mubasherOhlcvCsv,
};

export {
  mubasherTdwlQuotes,
  fetchMubasherTdwlQuotes,
  parseMubasherTdwlQuotes,
  mapMubasherRow,
  parseMubasherNumber,
  parseMubasherTimestampToUtc,
  MUBASHER_TDWL_QUOTES_PARSER_VERSION,
} from "./tdwl-quotes.js";
export type { MubasherBoard, MubasherPriceRow } from "./tdwl-quotes.js";

export {
  mubasherOhlcvCsv,
  fetchMubasherOhlcvCsv,
  parseMubasherOhlcvCsv,
  MUBASHER_OHLCV_CSV_PARSER_VERSION,
} from "./ohlcv-csv.js";
