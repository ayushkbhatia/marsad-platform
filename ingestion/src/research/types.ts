/**
 * PR.1 step 1 — the evidence-brief vocabulary. No SQL, no I/O, no DB.
 *
 * The twelve legs a brief may contain, the statuses a leg may report, and the closed set of
 * reasons. Deliberately separate from `envelope.ts` so the SQL layer, the assembler and the tests
 * can import the vocabulary without pulling in Zod schemas.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md §3, §6
 */

/**
 * The twelve Tier-1 legs. A leg not listed here is not requestable — which is the point: an
 * undeclared leg cannot be asked for, whereas a declared leg that reports honest absence teaches
 * the researcher that the concept exists.
 */
export const LEG_KEYS = [
  "EB-IDENTITY",
  "EB-RATIOS",
  "EB-SCORE",
  "EB-STATEMENTS",
  "EB-PERIODPAIR",
  "EB-PRICE",
  "EB-QUOTE",
  "EB-PEERS",
  "EB-FILINGS",
  "EB-REVISIONS",
  "EB-CALENDAR",
  "EB-VENUESTATE",
] as const;

export type LegKey = (typeof LEG_KEYS)[number];

const LEG_KEY_SET: ReadonlySet<string> = new Set(LEG_KEYS);

export function isLegKey(v: string): v is LegKey {
  return LEG_KEY_SET.has(v);
}

/**
 * What a leg is reporting about itself.
 *
 * The distinction that carries the weight is `empty` vs `absent`, and it is a STATUS distinction,
 * not a reason one:
 *
 *   · `empty`  — the query ran against a LIVE producer and matched nothing for THIS subject.
 *                Prose-legal: "the company has filed no cash-flow statement since FY23."
 *   · `absent` — the producer does not exist for ANYONE. Prose-ILLEGAL: writing "no consensus
 *                estimate is available" implies a consensus feed was consulted. There is none —
 *                `public.estimates` holds 0 rows and `earnings_events.eps_consensus` is null on
 *                0 of 9,188 rows.
 *
 * Collapsing the two is how a brief starts producing sentences the data cannot support.
 */
export const LEG_STATUSES = [
  "present",
  "empty",
  "absent",
  "unbindable",
  "stale",
  "refused",
] as const;

export type LegStatus = (typeof LEG_STATUSES)[number];

/**
 * Closed reason set. Closed on purpose: a free-text reason cannot be asserted against, and this is
 * the field a downstream agent reads to decide whether an absence is worth writing a sentence
 * about.
 */
export const LEG_REASONS = [
  "ok",
  "no_rows_for_security",
  "no_producer",
  "producer_dark",
  "projection_only",
  "no_lake_object",
  "no_security_link",
  "superseded_only",
  "no_full_text",
  "conflicted",
  "no_sector",
  "cohort_thin",
  "cohort_unusable",
  "period_not_current",
  "cap_exceeded",
  "switch_off",
] as const;

export type LegReason = (typeof LEG_REASONS)[number];

/**
 * Which statuses may carry evidence at all.
 *
 * `present` is the ONLY status that may carry BoundFacts. `unbindable` carries UnboundFacts (or,
 * for EB-FILINGS, handles). `empty` / `absent` / `refused` carry nothing. Asserted in one pass by
 * `verifyBundle` — a leg that reports `absent` while shipping facts is a contradiction that would
 * otherwise reach the writer as licence to invent.
 */
export const STATUSES_ALLOWING_BOUND_FACTS: ReadonlySet<LegStatus> = new Set<LegStatus>([
  "present",
  "stale",
]);

export const STATUSES_ALLOWING_ANY_EVIDENCE: ReadonlySet<LegStatus> = new Set<LegStatus>([
  "present",
  "stale",
  "unbindable",
]);

/**
 * How old a leg's newest fact may be before it is `stale`.
 *
 * ⚠️ Staleness CANNOT be read from `lake.objects.effective_date` for the fundamentals tier:
 * measured 2026-07-27, `effective_date` is null on 0 of 36,330 FILING.FINANCIALS, 0 of 41,621
 * FINANCIALS.XCHECK, 0 of 736 COMPUTED.RATIOS and 0 of 540 COMPUTED.SCORE — only OHLCV.CLOSE
 * populates it (640,992 of 640,992). A staleness check reading that column would compute an age
 * from null and report the entire fundamentals corpus as permanently fresh. The period lives in
 * `payload.period_end`; see `envelope.ts` `as_of`.
 */
export const TOLERANCE_DAYS: Record<LegKey, number | null> = {
  "EB-IDENTITY": 400, // shares outstanding move on corporate actions, not quarterly
  "EB-RATIOS": 7, // rebuilt nightly; a week means the cron has been down
  "EB-SCORE": 7, // same producer cadence
  "EB-STATEMENTS": 200, // a half-year gap is normal between annual filers' prints
  "EB-PERIODPAIR": 200,
  "EB-PRICE": 5, // a trading week
  "EB-QUOTE": 2, // delayed quotes, but not last week's
  "EB-PEERS": 7, // rides the ratios/score producers
  "EB-FILINGS": null, // a filing is an event; an old one is not stale, it is history
  "EB-REVISIONS": null, // ditto — a restatement does not expire
  "EB-CALENDAR": 30,
  "EB-VENUESTATE": 1,
};
