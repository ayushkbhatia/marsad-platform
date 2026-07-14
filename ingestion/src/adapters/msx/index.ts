// MSX (Muscat Stock Exchange) VenueAdapter.
// Quotes via server-rendered snapshot.aspx (golden-verified); board JSON pinned on VPS.
import type { VenueAdapter } from '../../core/types.js';
import { msxQuotes } from './quotes.js';
import { msxFilingsList } from './filings.js';

export const msxAdapter: VenueAdapter = {
  venue: 'MSX',
  agentAccount: 'DATA-MSX',
  quotes: msxQuotes,
  filingsList: msxFilingsList,
};

export { msxQuotes, MSX_QUOTES_PARSER_VERSION } from './quotes.js';
export { msxFilingsList, MSX_FILINGS_PARSER_VERSION } from './filings.js';
// ≥2y daily-close price-history backfill via MSX's native company-chart-data.aspx JSON. Routed by
// runtime.tasksForProvider on endpoint_config.provider='msx-company-chart' (a first-class MSX source,
// NOT a Mubasher aggregator ride) — so it is exported here but mounted via the provider, not on the
// VenueAdapter surface (ohlcv_backfill has no VenueAdapter slot).
export { msxHistory, fetchMsxHistory, parseMsxHistory, MSX_HISTORY_PARSER_VERSION } from './history.js';
