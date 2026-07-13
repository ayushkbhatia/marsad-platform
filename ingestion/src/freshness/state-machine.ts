/**
 * Pure venue freshness state machine (01 §8 Loop B, mirrored in TypeScript).
 *
 * This is a faithful, side-effect-free mirror of `ingest.sweep_feed_status()`
 * (20260713000005_prices.sql). The SQL function is the RUNTIME single writer of
 * public.venue_feed_status; this TS version exists so the transition logic is
 * unit-testable (§8 assertions) and reusable by readers that already hold the
 * raw signals. If the two ever disagree, the SQL is authoritative — and the
 * golden tests here exist precisely to catch drift between them.
 *
 * Transition table (quotes cadence C = 10 min), during a venue's session:
 *   last success ≤ 15 min (1.5×C) → live
 *   15–30 min      (1.5–3×C)      → reconnecting
 *   30–45 min                     → delayed
 *   > 45 min                      → offline
 * Outside the session → closed (calendar-driven, never offline).
 * A desk/parser-set halted|auction override is preserved unless the market has
 * closed — 'closed' always wins, matching the SQL WHERE guard
 *   (state not in ('halted','auction') OR excluded.state = 'closed').
 *
 * Note the "≥ 6 consecutive failures" clause from earlier drafts is DEAD at
 * C = 10 (the 45-min clock always fires first) and is intentionally omitted,
 * matching the SQL. If cadence is ever tightened below 7 min, reintroduce a
 * failure-count clause explicitly (see §8 post-review note).
 */

import type {
  DerivedVenueState,
  FeedState,
  FreshnessThresholds,
  VenueFreshnessSignal,
} from './types.js';

/** Defaults for quotes cadence C = 10 min (01 §8). */
export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  liveMax: 15,
  reconnectingMax: 30,
  delayedMax: 45,
};

const MS_PER_MIN = 60_000;

/**
 * Derive the venue feed state from raw signals. PURE — no Date.now(), no I/O;
 * `signal.now` is injected. Mirrors ingest.sweep_feed_status() exactly.
 */
export function deriveVenueState(
  signal: VenueFreshnessSignal,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): DerivedVenueState {
  const { isOpen, lastQuotesSuccessAt, now, marketOverride } = signal;

  // Calendar wins first: outside the session the venue is 'closed', and closed
  // overrides even a lingering halted/auction (SQL: `or excluded.state = 'closed'`).
  if (!isOpen) {
    return { state: 'closed', minutesSinceSync: null, detail: 'market closed' };
  }

  // In-session: a desk/parser market override is preserved (sweep never
  // overwrites halted/auction while the market is open).
  if (marketOverride === 'halted' || marketOverride === 'auction') {
    return {
      state: marketOverride,
      minutesSinceSync: minutesSince(lastQuotesSuccessAt, now),
      detail: marketOverride === 'halted' ? 'trading halted' : 'auction phase',
    };
  }

  const mins = minutesSince(lastQuotesSuccessAt, now);
  const state = ladder(mins, thresholds);
  return { state, minutesSinceSync: mins, detail: detailFor(state, mins) };
}

/** The freshness ladder: minutes-since-sync → state. `null` (never) ⇒ offline. */
function ladder(mins: number | null, t: FreshnessThresholds): FeedState {
  if (mins === null || mins > t.delayedMax) return 'offline';
  if (mins > t.reconnectingMax) return 'delayed';
  if (mins > t.liveMax) return 'reconnecting';
  return 'live';
}

function minutesSince(at: Date | null, now: Date): number | null {
  if (at === null) return null;
  return (now.getTime() - at.getTime()) / MS_PER_MIN;
}

function detailFor(state: FeedState, mins: number | null): string {
  switch (state) {
    case 'live':
      return 'delayed 15-min feed healthy';
    case 'reconnecting':
      return `retrying — last sync ${fmtAge(mins)} ago`;
    case 'delayed':
      return `delayed — synced ${fmtAge(mins)} ago`;
    case 'offline':
      return mins === null ? 'offline — never synced' : `offline — last ${fmtAge(mins)} ago`;
    default:
      return state;
  }
}

function fmtAge(mins: number | null): string {
  if (mins === null) return 'never';
  return `${Math.floor(mins)}m`;
}

/**
 * Does a state transition require escalation to a human (owner email + Desk)?
 * Per 01 §8: transitions INTO 'offline' escalate. (PARSE_DRIFT and robots flips
 * escalate too, but those originate in Loop A / the registry, not here.)
 */
export function isEscalatingTransition(from: FeedState | null, to: FeedState): boolean {
  return to === 'offline' && from !== 'offline';
}

/**
 * Does a transition mark recovery (offline → any healthy state), so incident
 * banners auto-expire? Mirrors the SQL recovery choreography
 * (offline → live clears incidents + banners). We treat any move OUT of offline
 * into an open/healthy state as recovery for banner-expiry purposes.
 */
export function isRecoveryTransition(from: FeedState | null, to: FeedState): boolean {
  return from === 'offline' && to !== 'offline';
}
