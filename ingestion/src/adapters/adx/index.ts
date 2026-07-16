// ingestion/src/adapters/adx/index.ts
//
// ADX (Abu Dhabi Securities Exchange) VenueAdapter. Quotes/EOD → DATA-ADX; filings → DATA-FILINGS
// (resolved per-task by the worker). ADX trades Mon–Fri (UAE weekend Sat–Sun since Jan 2022) — the
// session gate is data in public.venues.trading_days ('{1,2,3,4,5}'); nothing here assumes Sun–Thu.

import type { VenueAdapter } from "../../core/types.js";
import { adxQuotes } from "./quotes.js";
import { adxFilingsList, adxFilingDetail } from "./filings.js";
import { adxEodBulletin } from "./eod.js";
import { adxProfile } from "./profile.js";

export const adxAdapter: VenueAdapter = {
  venue: "ADX",
  agentAccount: "DATA-ADX",
  quotes: adxQuotes,
  filingsList: adxFilingsList,
  filingDetail: adxFilingDetail,
  eodBulletin: adxEodBulletin,
  securitiesProfile: adxProfile,
};

export { adxQuotes, adxFilingsList, adxFilingDetail, adxEodBulletin, adxProfile };
export { DEFAULT_ADX_PROFILE_MAP } from "./profile.js";
export default adxAdapter;
