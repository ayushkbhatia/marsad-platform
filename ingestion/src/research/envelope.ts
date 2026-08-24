/**
 * PR.1 step 1 — the evidence envelope. No SQL, no I/O, no DB.
 *
 * ── WHY THREE MEMBERS AND NOT ONE OPTIONAL FIELD ────────────────────────────────────────────────
 * `Evidence` is a discriminated union of three shapes, NOT one type with `object_id?: string`.
 * An optional binding on a shared type is exactly what lets a composer emit a D-8 binding for
 * something that has none — the mistake is then invisible until the fit stage, or worse, until a
 * reader sees a number with no source. `UnboundFact` has no `binding` key at all, so composing a
 * binding from it is a type error rather than a runtime refusal.
 *
 * ── WHY VALUES ARE FROZEN HERE ──────────────────────────────────────────────────────────────────
 * `value` is resolved by the SQL at assembly and stored. It becomes `lake.citations.quoted_value`
 * and is what the fit stage's numeric pass arithmetic-checks the prose against. It is a snapshot,
 * not a cache: `hydrate()` (PR.4) re-resolves against the live object before composition and
 * reports `value_moved` when the two disagree beyond DRIFT_TOL. That matters because the two
 * families that carry most VERIFIED objects are rebuilt nightly — COMPUTED.RATIOS measured 13.9
 * revisions per natural key, every live row rewritten inside a single hour — so a binding has a
 * roughly 24-hour life.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md §4
 */
import { z } from "zod";

import { ObjectBinding, ObjectRef } from "../blocks/binding.js";
import { LEG_KEYS, LEG_REASONS, LEG_STATUSES } from "./types.js";

/**
 * Bumped when a stored brief's shape changes incompatibly. PR.2 persists briefs to
 * `ops.research_briefs` with this as a COLUMN, not buried in the jsonb, so a reader can dispatch
 * on it without parsing the payload first.
 */
export const BUNDLE_CONTRACT_VERSION = 1;

export const Freshness = z.enum(["fresh", "aging", "stale", "unknown"]);
export type Freshness = z.infer<typeof Freshness>;

/**
 * `RETIRED` is deliberately absent. A retired object is never returned by a bundle — it is the
 * superseded revision, and binding to one produces `FIT-BIND-UNRESOLVED` at best and a silently
 * wrong number at worst.
 */
export const ObjectState = z.enum(["VERIFIED", "PENDING", "CONFLICT"]);
export type ObjectState = z.infer<typeof ObjectState>;

/**
 * How the value behaves over time, so a consumer knows whether re-resolving can change it:
 *   · immutable  — a filed figure for a closed period (FILING.FINANCIALS)
 *   · recomputed — rebuilt on a producer cadence (COMPUTED.RATIOS, COMPUTED.SCORE)
 *   · perishable — moves intraday (QUOTE.LAST)
 */
export const Volatility = z.enum(["immutable", "recomputed", "perishable"]);
export type Volatility = z.infer<typeof Volatility>;

/**
 * Durable identity, independent of the uuid.
 *
 * The uuid is NOT stable: producers supersede by natural key on every run. `rebind` is what
 * `hydrate()` uses to find the current revision of the same fact. Rides
 * `btree (natural_key, revision)` and the partial `btree (natural_key) WHERE superseded_by IS NULL`.
 */
export const RebindKey = z.strictObject({
  object_type: z.string().min(1),
  natural_key: z.string().min(1),
  revision: z.int().min(1),
});
export type RebindKey = z.infer<typeof RebindKey>;

export const FactPeriod = z.strictObject({
  statement_type: z.enum(["income", "balance", "cashflow", "oci", "equity_change"]),
  basis: z.enum(["consolidated", "standalone"]),
  period_kind: z.enum(["quarter", "annual", "ttm"]),
  fiscal_period: z.string().min(1),
  period_end: z.iso.date(),
  is_restated: z.boolean().default(false),
});
export type FactPeriod = z.infer<typeof FactPeriod>;

/**
 * How a resolved value must be PRINTED.
 *
 * Without this the same field renders `0.1243` in a stat strip and "12.4%" in the prose two lines
 * above it, and the fit stage's numeric-consistency pass then refuses the piece for a disagreement
 * that is purely presentational. `multiplier` is the fraction-vs-percent decision and it lives
 * here and nowhere else.
 */
export const FactFormat = z.strictObject({
  value_kind: z.enum(["number", "date", "string", "boolean"]),
  multiplier: z.number(),
  unit: z.string().nullable(),
  currency: z.string().length(3).nullable(),
  scale: z.enum(["unit", "thousand", "million", "billion"]).default("unit"),
  decimals: z.int().min(0).max(6),
});
export type FactFormat = z.infer<typeof FactFormat>;

const BundleName = z.enum(LEG_KEYS);

const evidenceCommon = {
  label: z.string().min(1),
  metric_key: z.string().min(1),
  /** Resolved by the SQL at assembly, then frozen. See the header note. */
  value: z.union([z.number(), z.string(), z.boolean()]).nullable(),
  format: FactFormat,
  /** The date the value is ABOUT: effective_date, else payload.period_end, else null. */
  as_of: z.iso.date().nullable(),
  /** lake.objects.updated_at — when the platform last touched the row. NOT the same question. */
  observed_at: z.iso.datetime(),
  /**
   * For a DERIVED family (COMPUTED.*), the oldest input the producer consumed. Freshness is
   * computed from this when present — a ratio rebuilt last night off a two-year-old statement is
   * not fresh, and `observed_at` alone would say it was.
   */
  input_as_of: z.iso.date().nullable(),
  age_days: z.int().nullable(),
  freshness: Freshness,
  period: FactPeriod.nullable(),
};

/**
 * MEMBER 1 — the D-8 atom.
 *
 * Assembler invariants, all checked by `verifyBundle`:
 *  1. `binding.field` was RESOLVED against the live object and did not return null.
 *     `binding.ts`'s regex validates the SHAPE of a dotted path and nothing about whether the key
 *     exists. Measured: `dividend_yield`, `payout_ratio` and `nim` are null on 0 of 736
 *     COMPUTED.RATIOS rows, so they must never be emitted as facts.
 *  2. `binding.field` matches RESOLVABLE_FIELD and is NEVER `numeric_value`.
 *  3. The object is live and its state is not RETIRED.
 *  4. `fit_bindable === (object_state is in this type's citable_states)` — nothing else.
 *  5. `format` came from FIELD_FORMAT, not from a guess.
 */
export const BoundFact = z.strictObject({
  kind: z.literal("fact"),
  fact_id: z.string().regex(/^f\d+$/),
  bundle: BundleName,
  binding: ObjectBinding,
  binding_shape: z.literal("scalar"),
  object_state: ObjectState,
  fit_bindable: z.boolean(),
  rebind: RebindKey,
  volatility: Volatility,
  source_rank: z.int().nullable(),
  ...evidenceCommon,
});
export type BoundFact = z.infer<typeof BoundFact>;

/**
 * MEMBER 2 — object identity, no field.
 *
 * What BLK-PROV, BLK-CITE, BLK-FRESH and BLK-DOWNLOAD consume. Carries no `value` at all: a ref
 * with a value is a fact in disguise, and would let a composer print it without a field path.
 */
export const BoundRef = z.strictObject({
  kind: z.literal("ref"),
  fact_id: z.string().regex(/^r\d+$/),
  bundle: BundleName,
  binding: ObjectRef,
  binding_shape: z.literal("ref"),
  label: z.string().min(1),
  object_type: z.string().min(1),
  object_state: ObjectState,
  fit_bindable: z.boolean(),
  rebind: RebindKey,
  volatility: Volatility,
  source_rank: z.int().nullable(),
  as_of: z.iso.date().nullable(),
  observed_at: z.iso.datetime(),
  age_days: z.int().nullable(),
  freshness: Freshness,
  /** Distinct lineage roots — R-03's ≥2 auto-publish gate reads this. */
  lineage_root_count: z.int().min(0).nullable(),
});
export type BoundRef = z.infer<typeof BoundRef>;

/**
 * MEMBER 3 — real, readable, and NOT bindable.
 *
 * No `binding` key exists on this shape, so a composer physically cannot emit a D-8 binding from
 * it. `prose_legal` is a literal `false`: an unbound fact may never be quoted as a numeral in
 * prose, because the fit stage's numeric pass would have nothing to check it against and R-04
 * would refuse the piece — correctly.
 */
export const UnboundFact = z.strictObject({
  kind: z.literal("unbound"),
  fact_id: z.string().regex(/^u\d+$/),
  bundle: BundleName,
  unbindable_reason: z.enum([
    "no_lake_object", // public.filings has no source_object_id column
    "no_security_link", // FILING.REF carries security_id on 0 of 669 rows
    "projection_only", // exists only in a public.* projection
  ]),
  prose_legal: z.literal(false),
  provenance: z.strictObject({
    table: z.string().min(1),
    /** Stringified bigint pk — deliberately NOT uuid-shaped, so it can never be mistaken for one. */
    row_ref: z.string().min(1),
  }),
  ...evidenceCommon,
});
export type UnboundFact = z.infer<typeof UnboundFact>;

export const Evidence = z.discriminatedUnion("kind", [BoundFact, BoundRef, UnboundFact]);
export type Evidence = z.infer<typeof Evidence>;

/** One leg's result. */
export const EvidenceLeg = z.strictObject({
  bundle: BundleName,
  status: z.enum(LEG_STATUSES),
  reason: z.enum(LEG_REASONS),
  evidence: z.array(Evidence),
  /**
   * The "what I looked for and did not find" half of the brief. Free text, but per-leg and
   * deliberate — it is what stops the writer inventing a reason for an absence.
   */
  notes: z.array(z.string().min(1)),
  /** Fields this leg would carry if a producer existed. Names the gap without implying a lookup. */
  unavailable_fields: z.array(z.string().min(1)),
  tolerance_days: z.int().nullable(),
  newest_as_of: z.iso.date().nullable(),
  query_ms: z.int().min(0).nullable(),
});
export type EvidenceLeg = z.infer<typeof EvidenceLeg>;

/** The whole brief for one security. */
export const EvidenceBrief = z.strictObject({
  contract_version: z.literal(BUNDLE_CONTRACT_VERSION),
  security_id: z.int().positive(),
  venue_code: z.string().min(1).nullable(),
  trigger_object_id: z.uuid().nullable(),
  assembled_at: z.iso.datetime(),
  assembly_ms: z.int().min(0).nullable(),
  legs: z.array(EvidenceLeg),
  /**
   * Server-built citation allow-set: every object_id this brief permits a citation to. PR.4 writes
   * `lake.citations` from this rather than from anything the model emitted, which dissolves
   * DEF-WRITER-CITATION-ALLOWSET by construction — the writer cannot cite outside its evidence
   * because it never handles a uuid at all.
   */
  allow_set: z.array(z.uuid()),
});
export type EvidenceBrief = z.infer<typeof EvidenceBrief>;
