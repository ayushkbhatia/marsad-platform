// QE (Qatar Stock Exchange) VenueAdapter. Plain HTTP; clean-JSON board (golden-verified).
import type { VenueAdapter } from '../../core/types.js';
import { qeQuotes } from './quotes.js';
import { qeFilingsList } from './filings.js';

export const qeAdapter: VenueAdapter = {
  venue: 'QE',
  agentAccount: 'DATA-QE',
  quotes: qeQuotes,
  filingsList: qeFilingsList,
};

export { qeQuotes, QE_QUOTES_PARSER_VERSION } from './quotes.js';
export { qeFilingsList, QE_FILINGS_PARSER_VERSION } from './filings.js';
