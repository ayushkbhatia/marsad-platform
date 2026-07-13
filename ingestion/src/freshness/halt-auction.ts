/**
 * Ticker-level halt / auction / stale detection from PARSED board data
 * (01 §8 "Ticker-level states are parse outputs, not fetch outputs").
 *
 * These are PURE derivations over the normalized board a parser produced plus
 * the session clock. They emit FACTS (`SecurityStateFact`); the LAKE owns the
 * object (public.security_status) — this module never writes that table, it
 * hands facts to the staging/lake layer. Halt alerts bypass quiet hours per
 * platform rules; that routing is the newsroom/dispatch layer's job, not here.
 *
 * Three signals, all board-derived:
 *   HALTED  — the exchange flags a security suspended on the board (a per-row
 *             status field, when the venue publishes one).
 *   AUCTION — derived from the SESSION CLOCK (pre-open / pre-close auction
 *             windows), optionally corroborated by an indicative-price field
 *             where the venue publishes one.
 *   STALE   — a security that was present on the previous fresh board snapshot
 *             is ABSENT from the current fresh one (dim, suppress chg + score).
 *
 * Because venues differ wildly in how (and whether) they mark halts, the
 * per-venue extraction of the raw "board status" string is the adapter's job;
 * this module takes already-extracted, venue-neutral inputs.
 */

import type { VenueCode } from '../core/types.js';
import type { SecurityStateFact } from './types.js';

/** One row of a parsed board, reduced to just what halt/stale detection needs. */
export interface BoardRow {
  ticker: string;
  /**
   * The venue's raw per-security board status token, already extracted by the
   * adapter and upper-cased (e.g. 'HALTED', 'SUSPENDED', 'H', 'T'). Undefined
   * when the venue publishes no per-row status.
   */
  boardStatus?: string | undefined;
  /** True when the row carries an indicative/auction price field (venue-specific). */
  hasIndicativePrice?: boolean | undefined;
}

/** Auction window definition, in the venue's local session terms. */
export interface AuctionWindow {
  /** e.g. 'pre_open' | 'pre_close'. */
  kind: string;
  /** Human label + expected clear time, if known. */
  resumeAt?: string | null;
}

export interface HaltAuctionInput {
  venue: VenueCode;
  /** Current parsed board. */
  rows: BoardRow[];
  /**
   * Tickers seen on the PREVIOUS fresh snapshot for this venue. Used only for
   * stale detection (present-before, absent-now). Empty ⇒ no stale detection
   * (first snapshot of the session).
   */
  previousTickers?: readonly string[];
  /**
   * The active auction window for the venue right now, from the session clock
   * (pre-open / pre-close), or null when in continuous trading. When set, rows
   * are candidates for AUCTION; a per-row halt still takes precedence.
   */
  auctionWindow?: AuctionWindow | null;
}

/**
 * Board-status tokens that mean "trading halted / suspended". Kept broad and
 * case-insensitive; adapters normalize to upper-case before handing rows in.
 * A venue with a bespoke token adds it via `extraHaltTokens`.
 */
const DEFAULT_HALT_TOKENS = new Set([
  'HALT',
  'HALTED',
  'SUSPEND',
  'SUSPENDED',
  'H',
  'T', // some feeds use 'T' for trading-halt
]);

/**
 * Derive the ticker-level state facts for one venue board snapshot. PURE.
 *
 * Precedence per security: HALTED > AUCTION > (normal, no fact). STALE is a
 * separate axis (a ticker that vanished) and is emitted for the missing tickers.
 */
export function detectSecurityStates(
  input: HaltAuctionInput,
  opts: { extraHaltTokens?: readonly string[] } = {},
): SecurityStateFact[] {
  const haltTokens = new Set(DEFAULT_HALT_TOKENS);
  for (const t of opts.extraHaltTokens ?? []) haltTokens.add(t.toUpperCase());

  const facts: SecurityStateFact[] = [];
  const present = new Set<string>();

  for (const row of input.rows) {
    present.add(row.ticker);

    const status = row.boardStatus?.trim().toUpperCase();
    if (status && haltTokens.has(status)) {
      facts.push({
        venue: input.venue,
        ticker: row.ticker,
        state: 'halted',
        reason: `board status ${status}`,
        resumeAt: null,
      });
      continue; // halt beats auction
    }

    if (input.auctionWindow) {
      // Auction is session-clock driven; the indicative-price field, when
      // present, corroborates but is not required.
      facts.push({
        venue: input.venue,
        ticker: row.ticker,
        state: 'auction',
        reason: row.hasIndicativePrice
          ? `${input.auctionWindow.kind} auction (indicative price present)`
          : `${input.auctionWindow.kind} auction`,
        resumeAt: input.auctionWindow.resumeAt ?? null,
      });
    }
  }

  // STALE: present before, absent now (only when we have a prior board).
  for (const ticker of input.previousTickers ?? []) {
    if (!present.has(ticker)) {
      facts.push({
        venue: input.venue,
        ticker,
        state: 'stale',
        reason: 'absent from current fresh board snapshot',
        resumeAt: null,
      });
    }
  }

  return facts;
}

/**
 * Venue-level override the state machine consumes (state-machine.ts
 * `marketOverride`). When an ENTIRE board is in an auction window, or the venue
 * marks a market-wide halt, the venue badge should reflect it. We surface a
 * venue override only for the clear market-wide cases:
 *   - auctionWindow set AND every row lacks a continuous-trade price (all in
 *     auction) ⇒ 'auction'
 *   - a market-wide halt token supplied by the adapter ⇒ 'halted'
 * Individual-security halts do NOT flip the venue badge (that stays per-ticker).
 */
export function deriveVenueOverride(input: {
  auctionWindow?: AuctionWindow | null;
  marketWideHalt?: boolean;
}): 'halted' | 'auction' | null {
  if (input.marketWideHalt) return 'halted';
  if (input.auctionWindow) return 'auction';
  return null;
}
