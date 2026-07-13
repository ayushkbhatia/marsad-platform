// ingestion/src/adapters/mubasher/index.ts
//
// Mubasher aggregator adapters. Mubasher (english.mubasher.info) is an aggregator, not a venue, so
// it has no VenueAdapter of its own — it supplies TaskSpecs that venue adapters mount. Today it
// backs TDWL quotes (owner hybrid decision: saudiexchange.sa is Akamai-IP-blocked, GROUND TRUTH #3).
// adapters/tdwl/quotes.ts re-exports mubasherTdwlQuotes as the production `tdwlQuotes` task.

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
