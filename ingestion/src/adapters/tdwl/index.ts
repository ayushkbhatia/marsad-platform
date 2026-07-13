// ingestion/src/adapters/tdwl/index.ts
//
// TDWL (Saudi Exchange / Tadawul) VenueAdapter. Assembles the per-data-type TaskSpecs into the
// frozen VenueAdapter surface (CONTRACT §2). Quotes/indices/EOD attribute to DATA-TDWL; filings
// tasks attribute to DATA-FILINGS (the account behind the T+9-min parse SLA) — the worker resolves
// agentAccount per TASK, so filings tasks are wired under the filings account by the handler.

import type { VenueAdapter } from "../../core/types.js";
import { tdwlQuotes, tdwlNomuQuotes } from "./quotes.js";
import { tdwlFilingsList, tdwlFilingDetail } from "./filings.js";
import { tdwlEodBulletin } from "./eod.js";

export const tdwlAdapter: VenueAdapter = {
  venue: "TDWL",
  agentAccount: "DATA-TDWL",
  quotes: tdwlQuotes,
  filingsList: tdwlFilingsList,
  filingDetail: tdwlFilingDetail,
  eodBulletin: tdwlEodBulletin,
};

export { tdwlQuotes, tdwlNomuQuotes, tdwlFilingsList, tdwlFilingDetail, tdwlEodBulletin };
export default tdwlAdapter;
