// BHB (Bahrain Bourse) VenueAdapter.
// Plain HTTP (no WAF). Quotes via webapi JSON (route pinned on VPS); EOD via the Daily-Trading-
// Summary XLSX (the GCC's gold EOD source). No real fixtures yet (SPA shell); quotes/eod parsers
// verified against inline shape-samples, filings against the stable list shape.
//
// ohlcv.ts is the ≥2y EOD-CLOSE-history backfill (provider='bhb_webapi', routed by
// runtime.tasksForProvider — ohlcv_backfill has NO VenueAdapter slot, so it is exported below but
// mounted via the provider, NOT on the VenueAdapter surface). It is the DEF-BHB-OHLCV pickup.
import type { VenueAdapter } from '../../core/types.js';
import { bhbQuotes } from './quotes.js';
import { bhbEodBulletin } from './eod.js';
import { bhbFilingsList } from './filings.js';

export const bhbAdapter: VenueAdapter = {
  venue: 'BHB',
  agentAccount: 'DATA-BHB',
  quotes: bhbQuotes,
  eodBulletin: bhbEodBulletin,
  filingsList: bhbFilingsList,
};

export { bhbQuotes, BHB_QUOTES_PARSER_VERSION } from './quotes.js';
export { bhbEodBulletin, mapBulletinRows, decodeWorkbook, BHB_EOD_PARSER_VERSION } from './eod.js';
export { bhbFilingsList, BHB_FILINGS_PARSER_VERSION } from './filings.js';
export { bhbOhlcvBackfill, fetchBhbOhlcv, parseBhbOhlcv, toIsoTradeDate, BHB_OHLCV_PARSER_VERSION } from './ohlcv.js';
