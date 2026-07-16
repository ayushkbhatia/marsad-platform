// ingestion/src/adapters/mubasher/tdwl-profile.ts
//
// Mubasher-backed TDWL securities-profile TaskSpec — sector / isin / shares_outstanding for the ~387
// Saudi (Tadawul) names (07 §2.2 "Profile / sector / description | TDWL: Mubasher /profile"). TDWL is
// 56% of the 693-name universe and the #1 unblocker for live PE/PB + the Marsad Score.
//
// PROVIDER (cross-venue aggregator, like mubasher_csv): Mubasher owns NO VenueAdapter — this TaskSpec is
// routed by runtime.tasksForProvider on endpoint_config.provider='mubasher_profile'. Plain http (ctx.http)
// — Mubasher is reachable from the VPS IP with no WAF/proxy (adapters/mubasher/tdwl-quotes.ts).
//
// ⚠ OWNER STEER — DEF-EXIT-MUBASHER (2026-07-16): the owner wants OFF Mubasher entirely (paywall/
//   durability). This is a ONE-TIME profile backfill (runs, stamps profile_scraped_at, then goes
//   DORMANT — not a durable poll), so it is materially different from the ongoing quote/backfill
//   dependencies the directive targets. It is seeded active=false; whether to activate it OR extend the
//   free Tadawul XBRL feed (already landing statements — its entity metadata carries
//   dei:EntityCommonStockSharesOutstanding / sector / ISIN, the Mubasher-free preferred producer) is the
//   owner's call at the activation gate. Either way the persist layer + taxonomy below are source-agnostic.
//
// CONFIG-DRIVEN + VPS-PINNED: the exact Mubasher profile URL + JSON field paths are pinned in
// endpoint_config (urlTemplate + profileFieldMap) on the first VPS capture — the DEFAULT_TDWL_PROFILE_MAP
// below is a best-effort placeholder from the documented /api/1 JSON style (the quote board is
// /api/1/stocks/prices?country=sa). Until pinned + verified the seed row is active=false, so a wrong
// placeholder never burns the shared 300/day Mubasher budget. See adapters/profile/shared.ts.

import type { NormalizedProfile, TaskSpec } from '../../core/types.js';
import {
  fetchProfilesHttp,
  parseProfileDoc,
  PROFILE_PARSER_VERSION,
  type ProfileFieldMap,
} from '../profile/shared.js';

/**
 * Best-effort DEFAULT field map for the Mubasher TDWL company-profile JSON. PIN THE REAL PATHS from a
 * live VPS capture into endpoint_config.profileFieldMap (which overrides this) + add a golden fixture
 * before flipping the source active. Shares may be comma-grouped or reported in millions — set
 * sharesMultiplier in the pinned map if so.
 */
export const DEFAULT_TDWL_PROFILE_MAP: ProfileFieldMap = {
  rowsPath: 'profile',
  sector: 'sector',
  industry: 'industry',
  isin: 'isin',
  shares: 'sharesOutstanding',
  symbol: 'code',
};

/** The Mubasher-backed TDWL profile TaskSpec (routed by runtime.tasksForProvider for mubasher_profile). */
export const mubasherTdwlProfile: TaskSpec<NormalizedProfile> = {
  dataType: 'securities_profile',
  parserVersion: PROFILE_PARSER_VERSION,
  fetch: fetchProfilesHttp,
  parse: parseProfileDoc,
};
