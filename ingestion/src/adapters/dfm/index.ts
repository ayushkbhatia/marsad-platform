// DFM (Dubai Financial Market) VenueAdapter.
// SPA-over-JSON (api2.dfm.ae). WAF-fronted -> seeded transport http_bootstrap. NO real fixture yet
// (SPA shell + WAF blocked sandbox capture); parsers verified against inline shape-samples and MUST
// be revalidated against a real /mw/v1 + /efsah/v1 capture on the first VPS run.
import type { VenueAdapter } from '../../core/types.js';
import { dfmQuotes } from './quotes.js';
import { dfmFilingsList } from './filings.js';

export const dfmAdapter: VenueAdapter = {
  venue: 'DFM',
  agentAccount: 'DATA-DFM',
  quotes: dfmQuotes,
  filingsList: dfmFilingsList,
};

export { dfmQuotes, DFM_QUOTES_PARSER_VERSION } from './quotes.js';
export { dfmFilingsList, DFM_FILINGS_PARSER_VERSION } from './filings.js';
