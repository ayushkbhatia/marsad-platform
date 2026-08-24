/**
 * PR.1 step 1 — the field allow-list and the format map. No SQL, no I/O, no DB.
 *
 * ── WHY THE ALLOW-LIST IS PR.1'S AND NOT `binding.ts`'S ─────────────────────────────────────────
 * `binding.ts`'s `objectField` regex validates the SHAPE of a dotted path. It therefore accepts
 * `natural_key`, `superseded_by`, `revision`, `security_id` and `created_at` — every one
 * schema-legal, semantically wrong, and unprintable as a fact. The narrow rule belongs to the layer
 * that knows what a *fact* is, which is this one.
 *
 * ── WHY `numeric_value` IS EXCLUDED ABSOLUTELY ──────────────────────────────────────────────────
 * With no per-type exception, because it means a different thing on every family: market cap on
 * COMPUTED.RATIOS, the score on COMPUTED.SCORE, the close on OHLCV.CLOSE — and it is populated on
 * 2 of 36,330 FILING.FINANCIALS rows, where every real figure lives in `payload.line_items`. A
 * binding to `numeric_value` is therefore either ambiguous or null, and both are worse than absent.
 *
 * ── WHY THE MULTIPLIERS ARE WHAT THEY ARE ───────────────────────────────────────────────────────
 * Read off the PRODUCER, not sampled: `ratios-compute.ts:202` computes `roe: safeDiv(netIncome,
 * equity)` and `ratios-compute.test.ts:60-67` asserts `roe === 0.2` for net income 200 on equity
 * 1,000. So the margin/return/growth family is stored as a **fraction**, and printing it needs
 * ×100. `decimals` mirrors `ratios-compute.ts`'s COLUMN_NUMERIC scales — a value stored to 4 dp as
 * a fraction is 2 dp as a percent, and claiming more precision than the producer kept would be
 * inventing it.
 *
 * This is the ONLY place the fraction-versus-percent decision lives. Without it the same field
 * renders `0.1243` in a stat strip and "12.4%" in the prose two lines above, and the fit stage's
 * numeric pass then refuses the piece over a disagreement that is purely presentational.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md §4
 */
import type { FactFormat } from "./envelope.js";

/**
 * The only field paths a bundle may emit.
 *
 * `numeric_value` is deliberately absent — see the header. `effective_date` and `unit` are real
 * scalar columns and safe. Everything else must come from `payload.*`.
 */
export const RESOLVABLE_FIELD = /^(effective_date|unit|payload(\.[A-Za-z0-9_]+)+)$/;

export function isResolvableField(field: string): boolean {
  return RESOLVABLE_FIELD.test(field);
}

const pct = (decimals = 2): FactFormat => ({
  value_kind: "number",
  multiplier: 100,
  unit: "%",
  currency: null,
  scale: "unit",
  decimals,
});

const multiple = (decimals = 2): FactFormat => ({
  value_kind: "number",
  multiplier: 1,
  unit: "x",
  currency: null,
  scale: "unit",
  decimals,
});

const money = (decimals = 2): FactFormat => ({
  value_kind: "number",
  multiplier: 1,
  unit: null,
  // Resolved per-object at assembly from payload.currency / the security's reporting currency.
  // Left null here because it is a property of the ROW, not of the field.
  currency: null,
  scale: "unit",
  decimals,
});

const plain = (decimals = 0): FactFormat => ({
  value_kind: "number",
  multiplier: 1,
  unit: null,
  currency: null,
  scale: "unit",
  decimals,
});

/**
 * Keyed `"<object_type>|<field>"`. Every (object_type, field) a bundle emits MUST have an entry —
 * asserted by `verifyBundle`. A missing entry is a build error, not a fallback: guessing a format
 * is how a percent becomes a fraction on the page.
 */
export const FIELD_FORMAT: Record<string, FactFormat> = {
  // ── COMPUTED.RATIOS ────────────────────────────────────────────────────────────────────────
  // Fractions (ratios-compute.ts COLUMN_NUMERIC scale 4 ⇒ 2 dp as a percent).
  "COMPUTED.RATIOS|payload.roe": pct(),
  "COMPUTED.RATIOS|payload.roce": pct(),
  "COMPUTED.RATIOS|payload.nim": pct(),
  "COMPUTED.RATIOS|payload.net_margin": pct(),
  "COMPUTED.RATIOS|payload.gross_margin": pct(),
  "COMPUTED.RATIOS|payload.dividend_yield": pct(),
  "COMPUTED.RATIOS|payload.payout_ratio": pct(),
  "COMPUTED.RATIOS|payload.rev_growth_yoy": pct(),
  "COMPUTED.RATIOS|payload.eps_growth_yoy": pct(),
  "COMPUTED.RATIOS|payload.rev_cagr_3y": pct(),
  "COMPUTED.RATIOS|payload.eps_cagr_3y": pct(),
  "COMPUTED.RATIOS|payload.ret_3m": pct(),
  "COMPUTED.RATIOS|payload.ret_6m": pct(),
  "COMPUTED.RATIOS|payload.ret_12_1": pct(),
  // Multiples (scale 3 ⇒ 2 dp is the honest print).
  "COMPUTED.RATIOS|payload.pe": multiple(),
  "COMPUTED.RATIOS|payload.pb": multiple(),
  "COMPUTED.RATIOS|payload.ps": multiple(),
  "COMPUTED.RATIOS|payload.ev_ebitda": multiple(),
  "COMPUTED.RATIOS|payload.net_debt_ebitda": multiple(),
  // Currency absolutes.
  "COMPUTED.RATIOS|payload.market_cap": money(),
  "COMPUTED.RATIOS|payload.ebitda_ttm": money(),
  "COMPUTED.RATIOS|payload.eps_ttm": money(4),
  "COMPUTED.RATIOS|payload.book_value_ps": money(4),

  // ── COMPUTED.SCORE ─────────────────────────────────────────────────────────────────────────
  // 0-100, not a fraction — do NOT give these a ×100.
  "COMPUTED.SCORE|payload.score": plain(),
  "COMPUTED.SCORE|payload.composite": plain(),
  "COMPUTED.SCORE|payload.sector_percentile": plain(),
  "COMPUTED.SCORE|payload.sector_peer_count": plain(),
  "COMPUTED.SCORE|payload.rating": {
    value_kind: "string",
    multiplier: 1,
    unit: null,
    currency: null,
    scale: "unit",
    decimals: 0,
  },

  // ── QUOTE.LAST ─────────────────────────────────────────────────────────────────────────────
  "QUOTE.LAST|payload.last": money(3),
  "QUOTE.LAST|payload.open": money(3),
  "QUOTE.LAST|payload.high": money(3),
  "QUOTE.LAST|payload.low": money(3),
  "QUOTE.LAST|payload.bid": money(3),
  "QUOTE.LAST|payload.ask": money(3),
  "QUOTE.LAST|payload.week52High": money(3),
  "QUOTE.LAST|payload.week52Low": money(3),
  "QUOTE.LAST|payload.change": money(3),
  // Already a percent on the wire — multiplier 1, NOT 100.
  "QUOTE.LAST|payload.changePct": { ...pct(), multiplier: 1 },
  "QUOTE.LAST|payload.volume": plain(),

  // ── OHLCV.CLOSE ────────────────────────────────────────────────────────────────────────────
  "OHLCV.CLOSE|payload.close": money(3),
  "OHLCV.CLOSE|payload.open": money(3),
  "OHLCV.CLOSE|payload.high": money(3),
  "OHLCV.CLOSE|payload.low": money(3),
  "OHLCV.CLOSE|payload.volume": plain(),
  "OHLCV.CLOSE|payload.valueTraded": money(),

  // ── PROFILE.SECURITY ───────────────────────────────────────────────────────────────────────
  // The ONLY bindable field on this family: isin/sector/ticker/industry are identity, not facts.
  "PROFILE.SECURITY|payload.sharesOutstanding": plain(),
};

/** The format for a (object_type, field) pair, or null when the pair is not in the map. */
export function formatFor(objectType: string, field: string): FactFormat | null {
  return FIELD_FORMAT[`${objectType}|${field}`] ?? null;
}

/**
 * FILING.FINANCIALS line items are keyed by the statement's own taxonomy and cannot be enumerated
 * here — the key set differs by statement_type and by filer (a bank has `net_interest_income` and
 * no `gross_profit`; an industrial the reverse). Their format is derived at assembly from the
 * object's `payload.currency`, so this predicate is what `verifyBundle` uses to exempt them from
 * the FIELD_FORMAT completeness check rather than letting the whole family through unchecked.
 */
export function isLineItemField(objectType: string, field: string): boolean {
  return objectType === "FILING.FINANCIALS" && field.startsWith("payload.line_items.");
}
