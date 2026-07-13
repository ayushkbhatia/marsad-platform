/**
 * Freshness failure-signal layer — types (01-ingestion.md §8, §10).
 *
 * This module is the CODE HALF of the two-loop freshness design:
 *
 *   Loop A (this module, TypeScript, runs on the VPS worker per fetch)
 *     — classifies each fetch outcome into the frozen error taxonomy (§10),
 *       WRITES ingest.fetch_log + updates ingest.sources so Loop B has signal,
 *       and derives ticker-level halt/auction facts from parsed board data.
 *
 *   Loop B (ingest.sweep_feed_status(), SQL, pg_cron every minute — ALREADY
 *     APPLIED in 20260713000005_prices.sql) — the SINGLE writer of
 *     public.venue_feed_status. This module never writes that table; it only
 *     feeds the inputs the sweep reads (ingest.sources.last_success_at,
 *     consecutive_failures) and never overwrites desk-set halted/auction.
 *
 * The pure state machine here (`state-machine.ts`) is a faithful mirror of the
 * SQL sweep's transition table so the two can be reasoned about and tested
 * together; it is used for unit assertions (§8 transitions) and by any reader
 * that needs to derive the venue state from raw signals without a DB round-trip.
 * The DB remains the source of truth at runtime.
 */

import type { VenueCode, FetchErrorClass } from '../core/types.js';
import type { FetchError } from '../core/types.js';

// The failure taxonomy is defined ONCE, in core/types.ts (CONTRACT §10), and
// thrown by the transport layer (core/fetcher.ts, core/browser.ts) as the
// `FetchError` class. Freshness does NOT redeclare it — a caught core FetchError
// flows straight into FetchOutcome.error. Re-exported here so freshness importers
// keep a single import site.
export type { FetchErrorClass } from '../core/types.js';
export { FetchError } from '../core/types.js';

/**
 * The 6-state machine + 'closed' (01 §8 post-review: 'closed' is part of the
 * machine, not an implied default). Mirrors the CHECK on
 * public.venue_feed_status.state (0005).
 */
export type FeedState =
  | 'live'
  | 'reconnecting'
  | 'delayed'
  | 'offline'
  | 'halted'
  | 'auction'
  | 'closed';

/**
 * Whether an error class is retryable, and whether it is a "quality error" that
 * bypasses auto-retry and goes straight to the Desk error queue (27a).
 * HTTP_4XX and PARSE_DRIFT are quality errors: a human or a code fix is needed,
 * and confidence-style auto-retry would just hammer the site (01 §8).
 *
 * `errorClass` mirrors the field name on the thrown core `FetchError` class so a
 * caught transport error keys straight into `policyFor(err.errorClass)`.
 */
export interface ErrorPolicy {
  errorClass: FetchErrorClass;
  retryable: boolean;
  /** Goes straight to the Desk error queue without retries. */
  qualityError: boolean;
  /** Notify the owner (email + Desk) on this class. */
  escalate: boolean;
}

/** A single fetch outcome as Loop A sees it, before it is written to fetch_log. */
export interface FetchOutcome {
  sourceId: number;
  venue: VenueCode;
  /** null when the request never got an HTTP response (NETWORK). */
  httpStatus: number | null;
  /** Whether the (normalized) content changed vs. the last snapshot. */
  changed: boolean;
  /** Wall-clock duration of the fetch, ms. */
  durationMs: number;
  /**
   * Populated on failure; null/undefined on success. This is the SAME throwable
   * `FetchError` class the transport layer (core/fetcher.ts, core/browser.ts)
   * raises — a caught transport error is assigned here verbatim (no adapter).
   * Fields of interest: `errorClass`, `status`, `retryAfterMs`.
   */
  error?: FetchError | null;
}

/**
 * Inputs for the pure venue-state derivation (state-machine.ts). These are
 * exactly the signals ingest.sweep_feed_status() reads — kept in sync so the TS
 * mirror and the SQL writer never diverge.
 */
export interface VenueFreshnessSignal {
  venue: VenueCode;
  /** Is the venue's market open right now (calendar + session)? — venue_is_open. */
  isOpen: boolean;
  /** max(last_success_at) over the venue's active quotes sources; null = never. */
  lastQuotesSuccessAt: Date | null;
  /** "now" — injected so the derivation is pure/testable. */
  now: Date;
  /**
   * A desk- or parser-set market state that the pipeline must NOT overwrite
   * while it persists (01 §8: the sweep never clobbers halted/auction).
   * When set to 'halted' or 'auction', the derived state is that value unless
   * the market has closed (closed always wins — matches the SQL WHERE guard).
   */
  marketOverride?: 'halted' | 'auction' | null;
}

/** Result of the pure derivation, plus the human-readable reason for the badge. */
export interface DerivedVenueState {
  state: FeedState;
  /** Minutes since last quotes success, or null when never/closed-irrelevant. */
  minutesSinceSync: number | null;
  detail: string;
}

/** Thresholds in minutes for the quotes-cadence freshness ladder (C = 10). */
export interface FreshnessThresholds {
  /** ≤ this ⇒ live. Default 15 (1.5×C). */
  liveMax: number;
  /** ≤ this ⇒ reconnecting. Default 30 (3×C). */
  reconnectingMax: number;
  /** ≤ this ⇒ delayed. Default 45. Above ⇒ offline. */
  delayedMax: number;
}

/**
 * Ticker-level state emitted from PARSED board data (01 §8 "Ticker-level
 * states are parse outputs, not fetch outputs"). This module emits the FACTS;
 * the lake owns the object (public.security_status, 0005). We never write that
 * table directly — we hand these to the staging/lake layer.
 */
export interface SecurityStateFact {
  venue: VenueCode;
  ticker: string;
  state: 'halted' | 'auction' | 'stale';
  reason: string;
  /** When known (auction windows), the time the state is expected to clear. */
  resumeAt?: string | null;
}
