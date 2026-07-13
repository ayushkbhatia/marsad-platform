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
