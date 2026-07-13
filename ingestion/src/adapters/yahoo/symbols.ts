// ingestion/src/adapters/yahoo/symbols.ts
//
// PURE venue+ticker ↔ Yahoo-symbol mapping for the three GCC venues Yahoo Finance covers.
//
// COVERAGE (verified live from the VPS this session): Yahoo covers 3 of the 6 GCC venues via an
// exchange suffix on our raw ticker:
//   TDWL (Saudi)  → {ticker}.SR   (numeric ticker, e.g. 2222   → 2222.SR   Aramco)
//   DFM  (Dubai)  → {ticker}.AE   (alpha ticker,   e.g. EMAAR  → EMAAR.AE)   NOTE: .AE, NOT .DU
//   QE   (Qatar)  → {ticker}.QA   (alpha ticker,   e.g. QNBK   → QNBK.QA)
// Yahoo does NOT carry ADX, MSX, or BHB (no findable symbols) — those venues have no Yahoo mapping
// and toYahooSymbol returns null for them. This is the single guard that keeps the Yahoo adapter
// scoped to TDWL/QE/DFM.
//
// CROSS-CHECK KEYING (CONTRACT §6.5, runtime.mapRowsToStaging): the NormalizedQuote/NormalizedOhlcv
// this adapter emits must carry our OWN raw ticker (2222 / EMAAR / QNBK), i.e. the suffix STRIPPED,
// and our own venue (TDWL/QE/DFM), so the natural_key collides byte-for-byte with the primary
// source's row (Mubasher for TDWL; official for QE/DFM). fromYahooSymbol is the inverse used by the
// parsers to recover (venue, ticker) from a Yahoo response's meta.symbol.

import type { VenueCode } from '../../core/types.js';

/** The venues Yahoo Finance covers, and their Yahoo exchange suffix. */
export type YahooVenue = 'TDWL' | 'DFM' | 'QE';

/** venue → Yahoo suffix. Kept as the single source of truth for both directions. */
const VENUE_SUFFIX: Record<YahooVenue, string> = {
  TDWL: '.SR',
  DFM: '.AE', // NOTE: Dubai is .AE on Yahoo, not .DU (verified live)
  QE: '.QA',
};

/** suffix → venue (reverse of VENUE_SUFFIX), for fromYahooSymbol. */
const SUFFIX_VENUE: Record<string, YahooVenue> = {
  SR: 'TDWL',
  AE: 'DFM',
  QA: 'QE',
};

/** True when Yahoo Finance carries this venue (TDWL/QE/DFM only). */
export function isYahooVenue(venue: VenueCode): venue is YahooVenue {
  return venue === 'TDWL' || venue === 'DFM' || venue === 'QE';
}

/**
 * Map (venue, ticker) → the Yahoo chart symbol. Returns null for venues Yahoo does not cover
 * (ADX/MSX/BHB) or an empty/blank ticker — callers drop those (no fetchable symbol). The ticker is
 * used verbatim (only trimmed); TDWL numeric tickers and DFM/QE alpha tickers are already in the
 * exact case/shape Yahoo expects.
 */
export function toYahooSymbol(venue: VenueCode, ticker: string): string | null {
  if (!isYahooVenue(venue)) return null;
  const t = (ticker ?? '').trim();
  if (t === '') return null;
  return `${t}${VENUE_SUFFIX[venue]}`;
}

/**
 * Inverse: a Yahoo symbol ("2222.SR", "EMAAR.AE", "QNBK.QA") → our (venue, ticker) with the suffix
 * STRIPPED. Returns null for a symbol with no recognised GCC suffix (so a stray non-GCC symbol in a
 * response can never be mis-attributed to a venue). Case-insensitive on the suffix; the recovered
 * ticker preserves the body's original case (Yahoo returns DFM/QE tickers upper-cased already).
 */
export function fromYahooSymbol(symbol: string): { venue: YahooVenue; ticker: string } | null {
  const s = (symbol ?? '').trim();
  const dot = s.lastIndexOf('.');
  if (dot <= 0 || dot === s.length - 1) return null; // no suffix, or leading/trailing dot
  const suffix = s.slice(dot + 1).toUpperCase();
  const venue = SUFFIX_VENUE[suffix];
  if (!venue) return null;
  const ticker = s.slice(0, dot).trim();
  if (ticker === '') return null;
  return { venue, ticker };
}
