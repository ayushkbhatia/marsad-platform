// ingestion/src/adapters/msx/profile.ts
//
// MSX (Muscat) native securities-profile TaskSpec — sector / isin / shares_outstanding for the ~68 MSX
// names from the exchange-native company info (07 §2.2 "Profile … MSX: msx.om companies.aspx"). MSX has
// NO aggregator (not on Yahoo/Mubasher) → exchange-native is the only path. Plain http (ctx.http) —
// www.msx.om is reachable from the VPS IP with no WAF/proxy (adapters/msx/history.ts).
//
// CONFIG-DRIVEN + VPS-PINNED: MSX's per-company info URL + JSON field paths are pinned in endpoint_config
// (urlTemplate + profileFieldMap) on the first VPS capture; DEFAULT_MSX_PROFILE_MAP is a best-effort
// placeholder. Seed active=false until pinned + a golden fixture is captured. parse() reuses the shared
// PURE parseProfileDoc; fetch() reuses the shared per-symbol http loop.

import type { NormalizedProfile, TaskSpec } from '../../core/types.js';
import {
  fetchProfilesHttp,
  parseProfileDoc,
  PROFILE_PARSER_VERSION,
  type ProfileFieldMap,
} from '../profile/shared.js';

/**
 * Best-effort DEFAULT field map for the MSX company-info JSON. PIN THE REAL PATHS from a live VPS capture
 * into endpoint_config.profileFieldMap (which overrides this) + add a golden fixture before activation.
 */
export const DEFAULT_MSX_PROFILE_MAP: ProfileFieldMap = {
  rowsPath: '',
  sector: 'Sector',
  industry: 'SubSector',
  isin: 'ISIN',
  shares: 'ListedShares',
  symbol: 'Symbol',
};

export const msxProfile: TaskSpec<NormalizedProfile> = {
  dataType: 'securities_profile',
  parserVersion: PROFILE_PARSER_VERSION,
  fetch: fetchProfilesHttp,
  parse: parseProfileDoc,
};
