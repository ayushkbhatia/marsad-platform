# PR.1 — Evidence bundles: the deterministic half of the research desk

*(Expansion of `docs/BRIDGE-BUILD-PLAN.md` PR.1. Everything below is measured against the live DB at commit `8633a6b`, 2026-07-27, or read from the tree at `claude/signal-article-pipeline-design-da193a`. Where a number could not be measured in this pass it is marked NOT MEASURED and carries a step that measures it.)*

---

## 1. What PR.1 is

PR.1 builds `assembleBrief(sql, {security_id, trigger_object_id, now}) → EvidenceBrief`: for one security, a fixed set of legs that return its statement history, computed ratios and score, a peer cohort, recent filings as handles, and the dividend/earnings calendar — every returned datum carrying either the `lake.objects.id` and dotted `field` that D-8 requires, or an explicit statement that it has none.

**It is deterministic because the whole value of an evidence layer is that a second run over the same database returns the same facts with the same ids — reproducible, auditable, free, LLM-free, and testable without a network.**

Three framing corrections to PR.1 as currently written at `docs/BRIDGE-BUILD-PLAN.md:1241-1252`, all forced by measurement:

1. *"recent filings with `full_text`/`extracted_facts`, each row carrying the `lake.objects.id` it came from"* is **unsatisfiable**. `public.filings` has no `source_object_id` column (`supabase/migrations/20260713000006_fundamentals.sql:5-31`), and `FILING.REF` carries `security_id` on 0 of 669 rows — by design (`20260713000037_filing_project.sql:11-14`: a filing list is a venue-level announcement stream). Filings are evidence a researcher *reads*, never data a writer *binds*. §4 makes this a type-level distinction, not a convention.
2. *"every one resolvable to an object id"* passes today while producing pieces the fit stage refuses 100% of the time. `fit-engine.ts:386-395` refuses any bound object whose citations are all non-`VERIFIED`; measured `VERIFIED` live populations are `COMPUTED.RATIOS` 736, `COMPUTED.SCORE` 540, `QUOTE.LAST` 264, `FILING.FINANCIALS` **1 of 36,330**. Resolvable ≠ bindable. §10 restates the exit criterion.
3. *"given a `security_id` and an `event_type`"* — there is no `event_type`. `classify.ts:58` declares `let eventType: string | null = null` and assigns it only inside the `verdict === 'ambiguous'` LLM branch (`:74`); the deterministic prefilter branch — the only path that can fire today — writes null. The entry point takes `(security_id, trigger_object_id, now)` and derives period currency itself. `event_type` is an **output** PR.2 writes back.

---

## 2. The measured constraints

**Binding.** `numeric_value` is populated on 2 of 36,330 `FILING.FINANCIALS` rows — every real figure lives in `payload.line_items`. `FILING.REF` has `security_id` on 0 of 669. `QUOTE.LAST` has `security_id` on 6,254 of 10,913 (57%), so a naive `where security_id = $1` silently returns nothing for 43% of quote objects and the leg looks empty rather than broken.

**Verification.** Live `VERIFIED`: `COMPUTED.RATIOS` 736, `COMPUTED.SCORE` 540, `QUOTE.LAST` 264 (a single 46-minute window on 2026-07-15), `FILING.FINANCIALS` 1. Everything else — all 640,992 `OHLCV.CLOSE`, all 36,330 `FILING.FINANCIALS`, all 728 `PROFILE.SECURITY`, all 42 `INDEX.LEVEL` — is `PENDING`.

**Object-id lifetime.** `COMPUTED.RATIOS:QE:573` has 15 revisions, 14 `RETIRED`, 1 live; `COMPUTED.SCORE:TDWL:183` has 10 revisions, 9 `RETIRED`. Both families supersede by natural key on every nightly run (`ingestion/src/lake/key-ratios.ts:361-390`, `scores.ts:230-270`: `update lake.objects set superseded_by = <new>, state = 'RETIRED'`), and `lake.v_citable_objects` filters `state in ('VERIFIED','PENDING')`. **A binding to the only two VERIFIED families has a ~24-hour life.**

**`effective_date` is NULL on the entire fundamentals tier** — `FILING.FINANCIALS`, `FINANCIALS.XCHECK`, `COMPUTED.RATIOS`, `COMPUTED.SCORE`. The period lives in `payload.period_end`; `key-ratios.ts` and `scores.ts` insert without the column at all. So the third column of `objects_security_idx` is dead for half the lake, and a staleness implementation reading `effective_date` for those four types computes `age_days` from null and reports everything fresh.

**Sector.** 487 of 762 listed securities are `sector='unknown'` (64%). The gap is venue-shaped, not universe-wide: TDWL 227/387 sectored, QE 48/49, and **ADX 0/93, DFM 0/72, MSX 0/120, BHB 0/41**. 453 of the 487 unknowns already carry `profile_scraped_at` stamped by shares-only producers, which closes every coverage guard keyed on `profile_scraped_at IS NULL` (`ingestion/src/runtime.ts:475`, `scripts/researchers/tadawul-researcher.mjs:181`).

**Coverage, denominator 762 listed:** ratios 736 (96.6%), profile 728 (95.5%), financials 599 (78.6%), score 540 (70.9%). Rung-1 peer cohort reaches 275 (36.1%). Only **394 of 762 (51.7%)** have any filing with `full_text`.

**Dead producers.** `dividends.ex_date` non-null on **0 of 1,233**; `state='live'` on **0**; `key_ratios.dividend_yield` non-null on **0 of 736**; `payout_ratio` **0 of 736**; `nim` **0 of 736**. `public.estimates` **0 rows**; `earnings_events.eps_consensus` **0 of 9,188**; `verdict` 0; `surprise_pct` 0; `next_session_reaction_pct` 0. `report_date` is an ingest stamp, not a calendar — 1,051 rows share 2026-07-16 and 0 rows carry a future date (`src/lib/data/adapters/earnings-calendar.ts:41-46`).

**Price divergence.** Since 2026-07-14: `public.ohlcv_daily` gained **5,070** rows, live `OHLCV.CLOSE` gained **32**. `ops.accrue_ohlcv_from_intraday` inserts straight into the projection (`20260726171633:49`) and that table has no `source_object_id`. SABIC: projection max `trade_date` 2026-07-26, newest bindable bar 2026-07-14.

**Cost.** `worker/src/db.ts:30` sets `prepare: false`, so every statement pays a full parse+plan — measured 1.85–14.14 ms planning and 282–515 planning buffers per statement, from an EU worker against a Mumbai DB. `q_pipeline` is the only queue that batch-reads and processes concurrently (`consumer.ts:73-78`, `pipelineConcurrency` 12 against `dbPoolMax` 20 under a 25-client Supavisor ceiling, `db.ts:20-25`). The peer fan-out on the 487-name `unknown` cohort measures **377.2 ms / 10,736 buffers**; a 20-name sector measures 18.3 ms / 732 buffers. 88–93% of index entries touched are retired revisions, because `objects_security_idx` has no predicate and nothing ever deletes from `lake.objects` (`ops.apply_retention`, `20260713000013:253-300`, touches index_levels/screen_runs/notifications/fetch_log/agent_runs and partitions only).

**Statement row count. ✅ RECONCILED 2026-07-27 (step 0 executed).** `public.financial_statements` holds **52,290** rows and **52,290** carry `source_object_id` — **100% bindable**. The designs were right and the 49,805 figure was wrong: it came from `pg_class.reltuples`, a planner *estimate*, passed into the planning pass as though it were a count (4.8% low). Every statement row therefore resolves to a lake object, and `EB-STATEMENTS` has full binding coverage — a better position than this spec was written against.

**Grants.** `marsad_worker` has SELECT+DELETE on `ops.story_blocks`, no INSERT/UPDATE. Nothing in `worker/src/*.ts` sets a `statement_timeout` (grep is empty); `marsad_worker` is uncapped. `anon` is 3 s, `authenticated` 8 s. PostgREST caps at `db-max-rows=1000` — irrelevant, because PR.1 runs only in the worker over Supavisor and must never be exposed through PostgREST.

---

## 3. The bundle taxonomy

Naming: the concept is **`EvidenceBundle`**, the collection is **`EvidenceBrief`**, the atom is **`BoundFact`**, codes are **`EB-*`**. Do not name it `Exhibit` — `exhibit` is taken by an unimplemented render placeholder (`src/lib/contracts/research.ts:72`, hatched grey box at `src/components/reader/research/ArticleView.tsx:59-66`). Do not name anything `context`/`pack`/`writer_context` — those denote `lake.fn_writer_context`, which PR.1 replaces for the research lane and whose id-less sections are the bug being removed.

**The leg key set is fixed and exported once**, as `LEG_KEYS` in `ingestion/src/research/types.ts`. Every brief carries every key. A missing key and an empty leg are indistinguishable, and that is the bug class that killed both recorded drafts (`draft.ts:156-170` walking a JSON blob for ids; 09 §4.1). The three prior design passes disagreed on the count (12 / 11 / 9) — that discrepancy is exactly what a shared constant makes into a compile error.

### Tier 1 — built in PR.1 (12 legs)

| code | question | input | output | source | binding path |
|---|---|---|---|---|---|
| `EB-IDENTITY` | who is this? | `security_id` | 1 bound fact + 3 unbound + 1 ref | `public.securities` + `PROFILE.SECURITY` | `payload.sharesOutstanding` **only** |
| `EB-RATIOS` | what is it worth? | `security_id` | ≤23 bound facts | `COMPUTED.RATIOS` | `payload.<key>` |
| `EB-SCORE` | how does it grade? | `security_id` | ≤12 bound facts + cohort meta | `COMPUTED.SCORE` | `payload.score`, `payload.grades.*`, `payload.factor_scores.*`, `payload.sector_percentile` |
| `EB-STATEMENTS` | what did it report? | `security_id`, caps | rectangular grids, one object per cell | `public.financial_statements` → `source_object_id` | `payload.line_items.<key>` |
| `EB-PERIODPAIR` | how does this print compare? | trigger period | paired bound facts, no deltas | same objects + `EB-RATIOS` growth keys | as above |
| `EB-PRICE` | what has the stock done? | `security_id`, window | series points + named anchors | `OHLCV.CLOSE` | `payload.close`, `numeric_value` excluded |
| `EB-QUOTE` | where is it now? | `security_id`, venue+ticker | ≤11 bound facts | `QUOTE.LAST` | `payload.last`, `payload.changePct`, … |
| `EB-PEERS` | who does it sit against? | subject sector/class/mcap | ≤12 members × ≤9 facts | peers' own ratios/score objects | `payload.<key>` |
| `EB-FILINGS` | what did it say? | `security_id` | ≤8 handles, **no facts field** | `public.filings` | **none — structurally unbindable** |
| `EB-REVISIONS` | what changed, was it corrected? | `security_id` | supersede chains | `lake.objects` chain + `public.financial_statement_history` | corrected object binds; wrong value is a literal |
| `EB-CALENDAR` | what is scheduled? | `security_id` | unbound rows + `unavailable_fields[]` | `dividends`, `earnings_events` | none |
| `EB-VENUESTATE` | is the market live? | `venue_code` | 1 unbound row | `public.venue_feed_status` | none until `MARKET.STATUS` exists |

`EB-REVISIONS` is **not optional** and was dropped from two of the three prior designs. It is the only source of `RuleContext.open_correction` (`ingestion/src/rules/types.ts:51`), which is what blocks auto-publish under R-07 (`ingestion/src/rules/rules.ts:223-224`). Dropping it silently removes the restatement guard.

`EB-CALENDAR` and `EB-VENUESTATE` are declared even though they return nothing bindable today, because a declared leg that reports honest absence teaches the researcher the concept exists; an undeclared leg cannot be requested at all. `EB-VENUESTATE` is also the cheapest unblock in the inventory: `BLK-FRESH` is mandatory on any live figure and binds a `market.status` `ObjectRef` (`g-provenance.ts:91-99`), the state lives in a 7-row table (`20260713000005_prices.sql:78-84`), and no `MARKET.*` family exists — so strictly, every piece quoting a price is unpublishable today. Mint the family in PR.0, not PR.1.

### Tier 3 — NOT declared, so not requestable

Segments (`payload.segments` is *read* by the projection at `20260719091206:22` but absent from every measured `FILING.FINANCIALS` key set); desk estimates and scenarios (`public.estimates` 0 rows; `BLK-SCENARIO` needs 6 bindings); ownership (`public.holders` ~empty, no `source_object_id`); IPO (all 0 rows); index benchmark (`INDEX.LEVEL` = 42 objects = 6 codes × 7 days, `security_id` on 0, and `BLK-INDEXED.benchmark` is a *required* non-optional `ChartSeries` at `d-charts.ts:417`); glossary (a slug store, not a lake family).

---

## 4. The BoundFact envelope

Three discriminated members, not one type with an optional `binding`. An `object_id?: string | undefined` on one shared type is precisely what would let PR.4 emit a binding for something unbindable — the `fn_writer_context` failure at scale.

```ts
// ingestion/src/research/envelope.ts
import { z } from "zod";                                   // ingestion/package.json pins zod ^4.4.3
import { ObjectBinding, ObjectRef } from "../blocks/binding.js";

export const BUNDLE_CONTRACT_VERSION = 1;

export const Freshness   = z.enum(["fresh", "aging", "stale", "unknown"]);
export const ObjectState = z.enum(["VERIFIED", "PENDING", "CONFLICT"]);   // RETIRED is never returned
export const Volatility  = z.enum(["immutable", "recomputed", "perishable"]);

/** Durable identity, independent of the uuid. Rides btree (natural_key, revision)
 *  and the partial btree (natural_key) WHERE superseded_by IS NULL. */
export const RebindKey = z.strictObject({
  object_type: z.string().min(1),
  natural_key: z.string().min(1),
  revision:    z.int().min(1),
});

export const FactPeriod = z.strictObject({
  statement_type: z.enum(["income","balance","cashflow","oci","equity_change"]),
  basis:          z.enum(["consolidated","standalone"]),
  period_kind:    z.enum(["quarter","annual","ttm"]),
  fiscal_period:  z.string().min(1),
  period_end:     z.iso.date(),
  is_restated:    z.boolean().default(false),
});

/** How a resolved value must be PRINTED. Without this the same field renders
 *  0.1243 in a stat strip and "12.4%" in the prose two lines above it. */
export const FactFormat = z.strictObject({
  value_kind: z.enum(["number","date","string","boolean"]),
  multiplier: z.number(),          // 100 for the fraction-valued ratio keys, else 1
  unit:       z.string().nullable(),   // 'SAR' | '%' | 'x' | 'shares' | null
  currency:   z.string().length(3).nullable(),
  scale:      z.enum(["unit","thousand","million","billion"]).default("unit"),
  decimals:   z.int().min(0).max(6),
});

const evidenceCommon = {
  label:      z.string().min(1),
  metric_key: z.string().min(1),
  /** RESOLVED BY THE SQL at assembly. Frozen. This becomes lake.citations.quoted_value
   *  and is what fit's numeric pass arithmetic-checks against. */
  value:      z.union([z.number(), z.string(), z.boolean()]).nullable(),
  format:     FactFormat,
  /** The date the value is ABOUT: effective_date, else payload.period_end, else null. */
  as_of:        z.iso.date().nullable(),
  /** lake.objects.updated_at — when the platform last touched it. */
  observed_at:  z.iso.datetime(),
  /** For a DERIVED family (COMPUTED.*), the oldest input date the producer consumed.
   *  Null where unknown. freshness is computed from this when present, never from
   *  observed_at alone. */
  input_as_of:  z.iso.date().nullable(),
  age_days:     z.int().nullable(),
  freshness:    Freshness,
  period:       FactPeriod.nullable(),
};

/** MEMBER 1 — the D-8 atom.
 *  Assembler invariants:
 *   1. binding.field was RESOLVED against the live object and did not return null.
 *      binding.ts:48-57 validates the SHAPE of a dotted path and nothing about whether
 *      the key exists. Measured: dividend_yield / payout_ratio / nim are null on 0/736
 *      COMPUTED.RATIOS, so they must never be emitted.
 *   2. binding.field is in RESOLVABLE_FIELD and is NEVER 'numeric_value'.
 *   3. The object is live (superseded_by is null) and its state is not RETIRED.
 *   4. fit_bindable === (object_state === 'VERIFIED') — nothing else.
 *   5. format is non-null and came from FIELD_FORMAT, not from a guess. */
export const BoundFact = z.strictObject({
  kind:          z.literal("fact"),
  fact_id:       z.string().regex(/^f\d+$/),
  bundle:        z.string().min(1),
  binding:       ObjectBinding,        // identical shape to binding.ts:62-68 — passes through unmodified
  binding_shape: z.literal("scalar"),
  object_state:  ObjectState,
  fit_bindable:  z.boolean(),
  rebind:        RebindKey,
  volatility:    Volatility,
  source_rank:   z.int().nullable(),
  ...evidenceCommon,
});

/** MEMBER 2 — object identity, no field. What BLK-PROV (g-provenance.ts:33-40),
 *  BLK-CITE (a-inline.ts:87), BLK-FRESH and BLK-DOWNLOAD consume. Carries no value:
 *  a ref with a value is a fact in disguise. */
export const BoundRef = z.strictObject({
  kind:          z.literal("ref"),
  fact_id:       z.string().regex(/^r\d+$/),
  bundle:        z.string().min(1),
  binding:       ObjectRef,
  binding_shape: z.literal("ref"),
  label:         z.string().min(1),
  object_type:   z.string().min(1),
  object_state:  ObjectState,
  fit_bindable:  z.boolean(),
  rebind:        RebindKey,
  volatility:    Volatility,
  source_rank:   z.int().nullable(),
  as_of:         z.iso.date().nullable(),
  observed_at:   z.iso.datetime(),
  age_days:      z.int().nullable(),
  freshness:     Freshness,
  /** Distinct lineage roots — R-03's >=2 auto-publish gate (rules/types.ts:23,:53). */
  lineage_root_count: z.int().min(0).nullable(),
});

/** MEMBER 3 — real, readable, NOT bindable. No `binding` key at all, so a composer
 *  physically cannot emit a D-8 binding from it. */
export const UnboundFact = z.strictObject({
  kind:    z.literal("unbound"),
  fact_id: z.string().regex(/^u\d+$/),
  bundle:  z.string().min(1),
  unbindable_reason: z.enum([
    "no_lake_object",    // public.filings has no source_object_id column
    "no_security_link",  // FILING.REF: security_id on 0 of 669
    "projection_only",   // exists only in a public.* projection
  ]),
  /** HARD RULE: an unbound fact may never be quoted as a numeral in prose. See §6. */
  prose_legal: z.literal(false),
  provenance: z.strictObject({
    table:   z.string().min(1),
    row_ref: z.string().min(1),      // stringified bigint pk — deliberately NOT a uuid shape
  }),
  ...evidenceCommon,
});

export const Evidence = z.discriminatedUnion("kind", [BoundFact, BoundRef, UnboundFact]);
```

**The field allow-list is PR.1's, not `binding.ts`'s.** `binding.ts:48-57`'s regex accepts `natural_key`, `superseded_by`, `revision`, `security_id`, `created_at` — schema-legal, semantically wrong, and unprintable. PR.1 owns and exports the narrow rule, plus the format map:

```ts
export const RESOLVABLE_FIELD =
  /^(effective_date|unit|payload(\.[A-Za-z0-9_]+)+)$/;    // note: numeric_value is EXCLUDED

/** Keyed (object_type, field). Every (object_type, field) the bundle emits MUST have
 *  an entry — asserted at exit (§10 EC-5). This is the ONLY place the fraction-vs-percent
 *  decision lives. */
export const FIELD_FORMAT: Record<string, FactFormat>;
```

`numeric_value` is excluded absolutely, with no per-type exception. It means market cap on `COMPUTED.RATIOS` (`key-ratios.ts:386`), the score on `COMPUTED.SCORE` (`scores.ts:257`), the close on `OHLCV.CLOSE` (`runtime.ts:653`), and is populated on 2 of 36,330 `FILING.FINANCIALS`. Measured collision: for `COMPUTED.RATIOS:TDWL:183`, `numeric_value` = 902850000 and `payload.market_cap` = 902850000 — indistinguishable at render time. Every value it carries is available under a payload key (`payload.market_cap`, `payload.score`, `payload.close`, `payload.last`), so the rule costs nothing. The two prior designs contradicted each other on this (`score.value → 'numeric_value'` in the SQL design's B4/B5 versus `NEVER_BIND_NUMERIC` in the taxonomy design's §10); use `payload.score`, which `scores.ts:455-457` writes and the measured key set contains.

**`format` is load-bearing and was missing from every prior pass.** `ObjectBinding` is `{object_id, field}` and nothing else; `BLK-STATSTRIP`'s cell is `{label, value: ObjectBinding, is_change}` with no unit field (`c-tabular.ts:31-42`); the render contract is `BoundValue = string | null`, "already-formatted text" (`src/components/blocks/types.ts:128-133`). Measured: `roe`/`net_margin`/`gross_margin` are `safeDiv` with no ×100 (`ingestion/src/lake/ratios-compute.ts:200-202`), `ret_12_1 = close[21]/close[252] − 1` (`key-ratios.ts:298,320`), and `lake.objects.unit` is NULL on every `COMPUTED.RATIOS` row. Without `FIELD_FORMAT` the stat strip renders `0.1243` while the prose two lines above says "12.4%" — and fit *passes* it, because `checkNumbers` accepts a percent token against either `r.value` or `r.value * 100` (`fit-engine.ts:507`). PR.1 owns the map; whether it travels on the binding (a `format` key added to `ObjectBinding` in PR.0) or is imported by the future resolver is PR.5's call, but the map is a PR.1 deliverable either way or it gets invented twice and diverges.

### 4.1 Grids and series

```ts
/** RECTANGULAR by construction. BLK-FINTABLE.rows[].values is
 *  z.array(ObjectBinding).min(1) — NON-nullable (c-tabular.ts:112-117) — and its
 *  refinement (:121-132) checks values.length === periods.length. BLK-COMPARE is
 *  identical (:307-312, :331-338). A null cell is UNREPRESENTABLE, so the only
 *  moves from a holed grid are dropping the row (silent evidence loss) or inventing
 *  a binding. The assembler rectangularises instead and REPORTS what it dropped. */
export const BoundGrid = z.strictObject({
  grid_id:       z.string().regex(/^g\d+$/),
  row_labels:    z.array(z.string().min(1)).min(1).max(8),
  column_labels: z.array(z.string().min(1)).min(2).max(8),
  cells:         z.array(z.array(BoundFact)),        // non-nullable, shaped rows × columns
  rows_dropped:    z.array(z.strictObject({ metric_key: z.string(), present_in: z.array(z.string()) })),
  columns_dropped: z.array(z.strictObject({ fiscal_period: z.string(), key_count: z.int() })),
  truncated:     z.boolean(),
  grid_binding:  ObjectBinding.nullable(),   // BLK-HEAT's single-object form. Null today.
});

/** An ordered set of individually-bound points. series_binding is the SINGLE
 *  object id ChartSeries (binding.ts:89-101) requires, and it is NULL for every
 *  series today because no lake payload holds a point array: OHLCV.CLOSE is one bar
 *  per row across 640,992 rows.
 *  RULE: with series_binding === null, PR.4 may render points as a table or as
 *  scalars but MUST NOT emit BLK-SPARK / LINE / AREA / DIST / INDEXED / CANDLE /
 *  SNAPSHOT. When a SERIES.* family lands this populates and nothing else changes. */
export const BoundSeries = z.strictObject({
  series_id: z.string().regex(/^s\d+$/),
  label:     z.string().min(1),
  question:  z.string().min(1),
  cadence:   z.enum(["daily","quarterly","annual"]),
  points:    z.array(BoundFact).min(2),
  series_binding: ObjectBinding.nullable(),
  x_key:     z.enum(["as_of","fiscal_period"]),
  truncated: z.boolean(),
});
```

`density` is deliberately **not** a field. It is orthogonal to renderability and rejects the renderable case while admitting the deceptive one: measured 7-key headline set × 4 recent income quarters gives sec 183 density 0.71 (admitted, still ragged), sec 431 0.57 (refused despite 127 live objects), sec 284 0.43 (refused despite a clean 3×4 rectangle). `renderable_rows` × `renderable_periods` — the largest total sub-rectangle — is the property that matters, and `rows_dropped`/`columns_dropped` is what makes the loss reportable instead of inferred.

### 4.2 Leg and brief envelopes

```ts
const legEnvelope = {
  contract_version: z.literal(BUNDLE_CONTRACT_VERSION),
  kind_version:     z.int().min(1),      // per-leg QUERY SEMANTICS version
  status:           LegStatus,
  reason:           LegReason,
  freshness:        LegFreshness,
  /** → content_blocks.bound_object_id, a SINGLE uuid (20260713000008_content.sql:99).
   *  Null unless status='present'. */
  primary_object_id: z.uuid().nullable(),
  /** EVERY distinct object this leg references. PR.4 writes one lake.citations row per
   *  entry or FIT-BIND-UNCITED refuses the block (fit-engine.ts:373-382). A BLK-COMPARE
   *  at cap is 4 names × 8 metrics = 32 bindings against one bound_object_id column. */
  citable_object_ids: z.array(z.uuid()),
  fact_count:         z.int().min(0),
  fit_bindable_count: z.int().min(0),
  notes:              z.array(z.string()),   // for PR.2's brief; never publishable prose
};

export const EvidenceBrief = z.strictObject({
  brief_id: z.uuid(),
  versioning: z.strictObject({
    contract_version: z.literal(BUNDLE_CONTRACT_VERSION),
    kind_versions:    z.record(z.string(), z.int().min(1)),
    lexicon_version:  z.int().min(1),
    lexicon_keys:     z.array(z.string()),      // frozen verbatim, so a later reader needs no code
  }),
  subject: z.strictObject({
    security_id: z.int(), ticker: z.string(), venue: VenueCode,
    name: z.string(), currency: z.string().length(3),
    sector: z.string(), sector_is_usable: z.boolean(),
  }),
  trigger: z.strictObject({
    object_id: z.uuid().nullable(), object_type: z.string().nullable(),
    natural_key: z.string().nullable(),
    derived_event: z.enum(["RESULT_CURRENT","RESULT_BACKFILL","PRICE_MOVE","UNCLASSIFIED"]),
  }),
  assembled_at: z.iso.datetime(),
  assembly_ms:  z.int(),
  legs: z.record(z.enum(LEG_KEYS), EvidenceBundleSchema),   // FIXED key set, always complete
  totals: z.strictObject({
    bound_facts: z.int(), fit_bindable_facts: z.int(), unbound_facts: z.int(),
    distinct_object_ids: z.int(), distinct_object_types: z.int(), distinct_periods: z.int(),
  }),
  /** Every distinct live object id in the brief. THIS IS the citation allow-set, built
   *  server-side. It dissolves DEF-WRITER-CITATION-ALLOWSET by construction — do not
   *  patch draft.ts:156-170's idsInPack, delete the need for it. */
  allow_set: z.array(z.uuid()),
  verdict:        z.enum(["sufficient","wire_only","insufficient_evidence","refused"]),
  verdict_reason: LegReason,
  /** Derived from fit_bindable_facts so the composer never lands in 40–89 words, which
   *  edit.ts:70-75 routes to TPL-01 (max_words 40) and fit then refuses with
   *  FIT-TEMPLATE-MAXWORDS — a guaranteed-refusal band. */
  suggested_word_budget: z.strictObject({ min: z.int(), max: z.int() }),
});
```

### 4.3 Compose-time: `FactRef`, not a uuid in a prompt

```ts
export const FactRef = z.string().regex(/^f\d+$/);
export function factRefSchemaFor(code: BlockCode): z.ZodType;
export function hydrate(
  brief: EvidenceBrief, code: BlockCode, draft: unknown, resolver: LiveResolver,
): Promise<
  | { ok: true; payload: unknown; cited_object_ids: string[]; primary_object_id: string }
  | { ok: false; issues: Array<{ path: string; fact_id: string;
        reason: "unknown_fact"|"unbound_fact"|"not_fit_bindable"|"wrong_shape"|"value_moved"|"superseded" }> }
>;
```

Uuids never enter the prompt, so a hallucinated uuid cannot be produced; an invented `f99` fails against a known id set with a precise error instead of being a well-formed uuid that passes `z.uuid()` and dies at `FIT-BIND-UNRESOLVED`. Token cost: a capped `BLK-COMPARE` is 32 `ObjectBinding`s ≈ 1,150 characters of raw uuid versus under 100 for `f1`…`f32`.

**`hydrate` takes a live resolver and is async — this is not optional.** A brief is evidence, not a cache of ids. With a ~24-hour id life on the only two VERIFIED families, a brief assembled at 23:00 and composed at 06:00 either binds a `RETIRED` uuid (fit finds `state='RETIRED'`, `FIT-BIND-UNRESOLVED`, every ratios piece refused silently every morning) or follows `superseded_by` forward and renders the *new* value while the prose carries the *frozen* one — and fit passes it, because the frozen `quoted_value` is in `reachableValues` (`fit-engine.ts:411`). `hydrate` re-resolves each fact's `rebind`, compares live to frozen, and returns `value_moved` when the delta exceeds `DRIFT_TOL = 0.005` (`ingestion/src/rules/text.ts:16`). A brief whose cited natural key has a higher live revision than recorded is **not composable** without re-resolution.

`hydrate` also returns `cited_object_ids`, which is what PR.4 writes to `lake.citations` — one row per distinct object, which is what stops `FIT-BIND-UNCITED` on every secondary binding.

---

## 5. The SQL, per leg

**Execution shape: 2–3 statements in TS against `LakeSql`, inside one `sql.begin`.** The three prior designs specified three incompatible shapes (TS set-based reads; one fused plpgsql function; ≤2 statements) and each one's cost numbers are true only for its own shape. The resolution:

- 11 separate statements is wrong: at `prepare:false` and 1.85–14.14 ms planning with 282–515 planning buffers each, planning alone is ~20–150 ms and ~3,000–5,000 buffers before a row is read.
- One fused statement is also wrong: it buys 1 RTT and loses early exit (~96% of admitted events are backfill and would pay the full 11-leg cost before being discarded), loses failure isolation (any single-leg error returns nothing and `consumer.ts:200-229` turns it into 5 redeliveries over 50 minutes then a `critical` incident for what is a capacity problem), and makes `refused(cap_exceeded)` structurally unreachable.

So: **statement 1** is the currency guard (one `fin_stmt_lookup` probe, returns the refusal without touching anything else); **statement 2** is the 10 cheap legs fused; **statement 3** is the peer leg, isolated so it can time out and downgrade alone.

**The timeout must be armed before the statement starts.** Postgres arms the statement timer once, in `start_xact_command()`, from the `StatementTimeout` in force when the top-level statement begins. `marsad_worker` is uncapped, so no timer is armed, and a function-level `SET` clause changes the GUC *after* the arming decision. A bare `set local` outside a transaction is discarded, because postgres.js runs every non-`begin` query in its own implicit transaction. The correct form:

```ts
await sql.begin(async (tx) => {
  await tx`set local statement_timeout = '5s'`;   // now inside a real tx, armed for what follows
  // guard → bundle → peers
});
```

PR.1 is read-only and needs no principal GUC, but it does need the transaction for the timer. State that; do not repeat "read-only, so no `sql.begin`".

### Guard — period currency (statement 1)

```sql
with trig as (
  select o.id, o.object_type, o.natural_key, o.revision, o.state::text as state,
         o.payload ->> 'statement_type' as statement_type,
         o.payload ->> 'period_kind'    as period_kind,
         o.payload ->> 'fiscal_period'  as fiscal_period,
         nullif(o.payload ->> 'period_end','')::date as period_end
    from lake.v_citable_objects o
   where o.id = $2::uuid
),
newest as (
  -- ACROSS ALL statement_types, not per type. A first-ever cashflow object must not
  -- read as 'current' for a security whose income runs to Q2 2026.
  select max(fs.period_end) as any_type_max
    from public.financial_statements fs
   where fs.security_id = $1 and fs.is_estimate = false
),
prior as (
  -- period_kind-MATCHED. For a December fiscal year end the FY annual and the Q4
  -- quarter share period_end, and the projection's uniqueness key
  -- (security_id, statement_type, basis, fiscal_period, is_estimate) does not include
  -- period_kind, so both rows legitimately coexist.
  select max(fs.period_end) as prior_period_end
    from public.financial_statements fs, trig t
   where fs.security_id = $1 and fs.is_estimate = false
     and fs.statement_type = t.statement_type
     and fs.period_kind    = t.period_kind
     and fs.period_end     < t.period_end
),
n_periods as (
  select count(*) as n from public.financial_statements fs, trig t
   where fs.security_id = $1 and fs.statement_type = t.statement_type
     and fs.period_kind = t.period_kind and fs.is_estimate = false
)
select t.*, p.prior_period_end, (current_date - t.period_end) as days_since_period_end,
       (t.period_end >= n.any_type_max) as is_latest_any_type,
       (current_date - t.period_end) <= 130 as within_tolerance,
       (np.n >= 2) as has_history
  from trig t, newest n, prior p, n_periods np;
```

Index: `fin_stmt_lookup (security_id, statement_type, period_end desc)` (`20260713000006_fundamentals.sql:53`) → Index Scan, 1 row each. Sub-millisecond.

The gate is **conjunctive**: `is_latest_any_type AND within_tolerance AND has_history`. `is_latest_period` alone is satisfied by definition whenever the trigger is the max — measured, 480 of 2,372 `(security_id, statement_type)` pairs (20.2%), spanning 136 securities (22.7% of the 599 with any financials), have `max(period_end)` older than `current_date − 130`, the oldest such "latest" period being 2016-12-31. For every one of those pairs the next backfilled statement, however old, would pass a per-type test. `has_history` refuses a single-observation history, which cannot establish currency at all. This guard is what stands between the newsroom and ~1,236 backfill stories a week (of ~1,285 admitted events/week, only 49 concern FY2026); nothing in `ops.materiality_prefilter` or `lake.fn_intake_dedup_key` (`20260727150000:113-123`) encodes recency.

### `EB-IDENTITY`

```sql
select s.id, s.venue_code, s.ticker, s.name_en, s.sector, s.industry, s.isin,
       s.currency, s.status, s.updated_at,
       (s.sector <> 'unknown') as sector_is_usable,
       o.id as profile_object_id, o.natural_key, o.revision, o.state::text,
       o.payload ->> 'sharesOutstanding' as shares_outstanding, o.updated_at as obj_updated_at
  from public.securities s
  left join lake.v_citable_objects o
    on o.security_id = s.id and o.object_type = 'PROFILE.SECURITY'
 where s.id = $1;
```

Index: `securities_pkey`, `objects_security_idx`. <1 ms, ~10 buffers.

**Sector/ISIN/industry are `unbound`, never bound.** 679 of 728 live `PROFILE.SECURITY` objects carry neither `sector` nor `rawSector` (only QE's 49 do): `scripts/researchers/tadawul-shares.mjs:78` writes `{sector:null, rawSector:null, isin:null, industry:null}` under the same natural key, and `upsertLakeObject`'s PENDING branch in `scripts/researchers/lib/lake-objects.mjs` replaces the payload wholesale rather than merging. `public.securities` survived only via the projection's COALESCE (`20260716123154:116-119`). `payload.sharesOutstanding` is the one bindable identity datum, and it is the only usable share count — `securities.shares_outstanding` is NULL on ~94% (`20260720160000:8`).

### `EB-RATIOS`

```sql
with r as (
  select o.id, o.natural_key, o.revision, o.state::text as state, o.payload, o.updated_at,
         o.payload ->> 'currency_computed' as currency
    from lake.v_citable_objects o
   where o.security_id = $1 and o.object_type = 'COMPUTED.RATIOS'
   limit 1                       -- objects_natural_key_live_uni guarantees exactly one live row
)
select r.id as object_id, r.natural_key, r.revision, r.state, r.updated_at, r.currency,
       k.key, 'payload.' || k.key as field, (r.payload ->> k.key)::numeric as value_num
  from r join (values ('market_cap'),('pe'),('pb'),('ps'),('ev_ebitda'),('eps_ttm'),
                      ('book_value_ps'),('ebitda_ttm'),('roe'),('roce'),('nim'),
                      ('net_margin'),('gross_margin'),('net_debt_ebitda'),
                      ('dividend_yield'),('payout_ratio'),('rev_growth_yoy'),
                      ('eps_growth_yoy'),('rev_cagr_3y'),('eps_cagr_3y'),
                      ('ret_3m'),('ret_6m'),('ret_12_1')) k(key)
    on r.payload ? k.key
 where jsonb_typeof(r.payload -> k.key) = 'number';    -- resolve before emitting
```

Index: `objects_security_idx`. Measured 661 B / 1 row / <1 ms. Non-null availability (live): `market_cap` 674, `ret_3m` 659, `ret_12_1` 615, `eps_ttm` 594, `book_value_ps` 581, `roe` 577, `net_margin` 571, `pe` 562, `pb` 552, `rev_cagr_3y` 486, `gross_margin` 431, `eps_cagr_3y` 371, `ev_ebitda` 202, and `nim`/`dividend_yield`/`payout_ratio` **0 each** — the `jsonb_typeof` guard drops them, which is why a yield league table (`BLK-RANKROW`'s canonical example) is not renderable at all today.

**Freshness for this leg comes from its inputs, not from the cron.** At least 8 of the ~13 populated keys are price-derived (`market_cap`, `pe`, `pb`, `ps`, `ev_ebitda`, `ret_3m`, `ret_6m`, `ret_12_1`), computed from `public.quotes_latest` (`key-ratios.ts:148,162`) and `public.ohlcv_daily` (`:295,307`) — the projections, not the lake. Timing `updated_at` times the cron. The producer does not store an input stamp today, so PR.1's interim is: propagate `EB-PRICE`'s `served_as_of` into this leg as its price-input stamp, tag the price-derived subset `price_derived: true`, and mark **those facts** (not the leg) `stale` when the price input exceeds tolerance. Otherwise one brief says `EB-PRICE: stale, binding_lag_days: 12` beside `EB-RATIOS: fresh, age_days: 0` on figures computed from the very prices it just declared unshowable. Log `COMPUTED.RATIOS.payload.input_as_of` in BUILD-STATUS §7, trigger = "the first bound valuation multiple is published".

### `EB-SCORE`

```sql
with s as (
  select o.id, o.natural_key, o.revision, o.state::text as state, o.payload, o.updated_at
    from lake.v_citable_objects o
   where o.security_id = $1 and o.object_type = 'COMPUTED.SCORE' limit 1
)
select s.id as object_id, s.natural_key, s.revision, s.state, s.updated_at, f.*
  from s cross join lateral (values
    ('score.value',      'payload.score',                        (s.payload->>'score')::numeric),
    ('score.composite',  'payload.composite',                    (s.payload->>'composite')::numeric),
    ('score.sector_pct', 'payload.sector_percentile',            (s.payload->>'sector_percentile')::numeric),
    ('score.f_value',    'payload.factor_scores.value',          (s.payload#>>'{factor_scores,value}')::numeric),
    ('score.f_growth',   'payload.factor_scores.growth',         (s.payload#>>'{factor_scores,growth}')::numeric),
    ('score.f_profit',   'payload.factor_scores.profitability',  (s.payload#>>'{factor_scores,profitability}')::numeric),
    ('score.f_momentum', 'payload.factor_scores.momentum',       (s.payload#>>'{factor_scores,momentum}')::numeric)
  ) f(fact_key, field, value_num)
 where f.value_num is not null;
```

Grades and `rating` come back from a second `values` arm as text facts. Index: `objects_security_idx`, measured 444 B / 1 row.

Two counts, deliberately named apart. `scorer_cohort_size` is the cohort's **input** size — `score-engine.ts:473` reports `members.length`, measured *before* the `composite !== null` filter at `:442`: `unknown` claims 456 but only 289 are scored; `insurance` claims 26 but only 2 are. Only `peer_count_bindable` (from `EB-PEERS`) may ever be printed. And `score.sector_pct` is suppressed when the subject's sector is `unknown`: 289 of 540 scored names (53.5%) sit in a 456-name pseudo-cohort with avg percentile 50.2, so their "sector percentile" is a percentile against every industry at once. Also emit `percentile_stale = (scores.computed_at < securities.updated_at)` — the sector-backfill task will trip this for up to 453 names at once, so land the guard first.

### `EB-STATEMENTS`

```sql
with kept as (
  select fs.id as row_id, fs.statement_type, fs.basis, fs.period_kind, fs.fiscal_period,
         fs.period_end, fs.currency, fs.line_items, fs.source_object_id,
         fs.source_filing_id, fs.updated_at
    from public.financial_statements fs
   where fs.security_id = $1 and fs.is_estimate = false
     and fs.statement_type = $2 and fs.period_kind = $3
   order by fs.period_end desc
   limit $4                              -- a REAL limit: index early-stop, no WindowAgg
),
bound as (
  select k.*, vo.id as object_id, vo.natural_key, vo.revision, vo.state::text as object_state
    from kept k left join lake.v_citable_objects vo on vo.id = k.source_object_id
)
select b.*, c.key as line_item, (b.line_items ->> c.key)::numeric as value_num,
       'payload.line_items.' || c.key as field
  from bound b join canon c on b.line_items ? c.key
 where jsonb_typeof(b.line_items -> c.key) = 'number';
```

**Drive from the projection, not from `lake.objects`.** Same 12 income periods for one security: via `fin_stmt_lookup` → Index Scan, **no Sort**, 14 buffers, 5.5 ms; via `lake.objects` → 176 buffers, top-N heapsort, 3.3 ms with 78 rows discarded, because `effective_date` is NULL on this type so the index degrades to a 2-column equality prefix. The projection copies the payload verbatim (`20260716120000:92` `v_items := new.payload -> 'line_items'`; `20260721110000:14` `x.line_items`), so the key set is identical and `payload.line_items.<key>` is guaranteed resolvable. Read the value from the projection, emit the binding as `{object_id: source_object_id, field}`.

Two implementation notes the prior SQL got wrong. **The `LIMIT` must be real and per `(statement_type, period_kind)`** — a `row_number() over (partition by …) where rn <= n` applies the filter *after* a WindowAgg over every non-estimate row for the security (145 rows for fixture F1), with no early stop and no LIMIT pushdown. Run the CTE per `(statement_type, period_kind)` via a lateral, or interpolate the cap as a literal. **And the limits must be `Const`, not plpgsql variables** — `preprocess_limit` cannot use a non-Const, so limit-aware costing (the "no Sort, top-N stop" the measurements show) disappears; plpgsql also switches to a generic plan after 5 executions per backend under `plan_cache_mode=auto`, so the plan that ships is not the plan that was EXPLAINed.

**Rectangularise before emitting.** Drop the headline/canon split that guarantees holes by construction (21 keys for the trigger period, 7 for history ⇒ every non-headline row null in every history column, always ⇒ measured density 0.583 for a normal `story` grid). Take the canon key set that is present in ≥1 kept period, then cut *periods* rather than keys until the rectangle is total, and report `rows_dropped` / `columns_dropped`.

### `EB-PERIODPAIR`

Not a separate query: `role ∈ {trigger, yoy_prior, seq_prior, history}` computed over the `EB-STATEMENTS` rows, **with `period_kind` matched**. Roles are assigned by `period_end` arithmetic against the guard's `prior_period_end` (which is already `period_kind`-filtered); the assembler asserts `current.period_kind === comparison.period_kind` and refuses otherwise.

**It emits no deltas.** The claim in the prior design — that an arithmetic delta is reachable at fit because both endpoints are cited — is false. `reachableValues` (`fit-engine.ts:402-419`) collects exactly `parseMagnitude(citation.quoted_value)` and `walkNumbers(citation.object_payload)`, the numeric *leaves* of the payload; there is no arithmetic in the function. `checkNumbers` (`:509-520`) then requires each material prose numeral within `DRIFT_TOL = 0.005`, and any token carrying `%` is material (`:457-464`). R-04 blocks even earlier at the rules stage (`ingestion/src/rules/rules.ts:99-101` headline, `:110-113` per-sentence `number_mismatch`, mode BLOCK), and `automark` will not attach a citation marker to the number at all (`ingestion/src/rules/automark.ts:90-91`). A computed 18.4% against endpoints of 3.4e10 and 2.9e10 fails by nine orders of magnitude; worse, if any cited payload leaf happens to sit near 0.184 — `net_margin` is a fraction and frequently does — the delta *passes* by matching an unrelated field and `nearest_source` records it.

So: route every growth claim through the object that already holds it. `COMPUTED.RATIOS` carries `rev_growth_yoy` and `eps_growth_yoy` (`key-ratios.ts:493-494`), plus `rev_cagr_3y`, `eps_cagr_3y`, `ret_3m`, `ret_6m`, `ret_12_1`. `EB-PERIODPAIR` emits the paired endpoints as `BoundFact`s and, where the ratios object has the growth key, a real `BoundFact` for the growth rate. Where it does not, the honest output is silence. Any derived number that must ship anyway rides `lake.citations.quoted_value` — `parseMagnitude(c.quoted_value)` at `fit-engine.ts:411` is the *only* channel through which a non-leaf number becomes reachable — and PR.4 must write that citation row, which means the fact needs an anchoring object id. That is a PR.4 mechanism; PR.1's job is to not hand the writer an unciteable number in the first place, which is what `prose_legal: false` enforces.

### `EB-PRICE`

```sql
with bars as (
  select o.id, o.natural_key, o.revision, o.state::text as state, o.effective_date,
         (o.payload->>'close')::numeric as close,     -- NOT numeric_value
         (o.payload->>'volume')::numeric as volume,
         row_number() over (order by o.effective_date desc) as ordinal
    from lake.v_citable_objects o
   where o.security_id = $1 and o.object_type = 'OHLCV.CLOSE'
   order by o.effective_date desc
   limit 260
),
-- Anchors computed over their OWN aggregate window, not over the display window.
w52 as (
  select o.id, o.effective_date, (o.payload->>'close')::numeric as close
    from lake.v_citable_objects o
   where o.security_id = $1 and o.object_type = 'OHLCV.CLOSE'
     and o.effective_date >= current_date - 365
),
anchors as (
  (select 'price.last'    as k, b.* from bars b where b.ordinal = 1)
  union all (select 'price.w52_high', w.* from w52 w order by w.close desc limit 1)
  union all (select 'price.w52_low',  w.* from w52 w order by w.close asc  limit 1)
  union all (select 'price.d_91',     w.* from w52 w where w.effective_date <= current_date - 91  order by w.effective_date desc limit 1)
  union all (select 'price.d_365',    w.* from w52 w where w.effective_date <= current_date - 365 order by w.effective_date desc limit 1)
),
freshness as (
  select (select max(trade_date) from public.ohlcv_daily where security_id = $1) as served_as_of,
         (select max(effective_date) from lake.objects
           where security_id = $1 and object_type = 'OHLCV.CLOSE' and superseded_by is null) as bindable_as_of
)
select * from anchors;
```

Index: `objects_security_idx (security_id, object_type, effective_date desc)` — the query the index was built for. Measured: Index Scan, **no Sort node**, 260 rows, 20 buffers, 9.0 ms. Never omit the LIMIT: unbounded, SABIC is 2,930 rows / 552 kB.

Two corrections to the prior SQL. **Each UNION arm must be parenthesised** — `select … limit 1 union all select …` is a syntax error, and the naive repair (hoisting ORDER BY/LIMIT to the end) silently returns one anchor instead of five, which every prior exit criterion would have passed. **And the 52-week anchors must not be computed over the display window**: `max/min` over a 60-bar `story` window labelled "52w high" is false at every profile except `deep`, and `d_91`/`d_365` match no row inside a 60-bar window and vanish silently.

`bindable_as_of` vs `served_as_of` is reported, never hidden; no fact is emitted past `bindable_as_of`. Measured today: sec 183 bindable 2026-07-14 / served 2026-07-26; sec 573 2026-07-13 / 2026-07-26; sec 431 2026-07-14 / 2026-07-26. Precondition PR.4 must honour: offer a bound price exhibit only when `binding_lag_days <= 1`, else `stale(projection_only)`.

### `EB-QUOTE`

```sql
with by_sec as (
  select o.*, 'security_id' as resolved_by
    from lake.v_citable_objects o
   where o.security_id = $1 and o.object_type = 'QUOTE.LAST'
   order by o.effective_date desc nulls last limit 1
),
nk as (
  select 'QUOTE.LAST:' || $2 || ':' || $3 || ':' || to_char(d.day,'YYYY-MM-DD') as key
    from generate_series(current_date - 10, current_date, interval '1 day') d(day)
),
by_nk as (
  select o.*, 'natural_key' as resolved_by
    from lake.v_citable_objects o
   where o.object_type = 'QUOTE.LAST' and o.natural_key in (select key from nk)
   order by o.effective_date desc nulls last limit 1
)
select * from ((select * from by_sec) union all (select * from by_nk)) q
 order by (resolved_by = 'security_id') desc, effective_date desc nulls last limit 1;
```

Index: `objects_security_idx` primary; `objects_natural_key_live_uni (natural_key) WHERE superseded_by is null` for the fallback — **11 exact equality probes, not a LIKE** (a left-anchored LIKE will not use the index under the default collation). `to_char`, not a JS `Date` — the postgres.js Date trap. `resolved_by` is recorded: a natural-key-resolved quote has a null `security_id`, which is still bindable (the binding is by id) but weaker provenance.

Measured: only 264 `QUOTE.LAST` are VERIFIED, all from one 46-minute window on 2026-07-15, and 55 of 762 securities have no quote at all (`quotes_latest` holds 707 rows). So `fit_bindable AND NOT stale` is effectively empty today — which is exactly why both flags exist independently. Prefer `EB-PRICE` anchors for any price/return fact: `OHLCV.CLOSE` is 100% attributed, `QUOTE.LAST` 57%.

### `EB-PEERS` (statement 3, isolated)

See §7 for the ladder. Shape: rank over `public.securities` ⋈ `public.key_ratios` ⋈ `ops.peer_class` (762 + 736 + 762 rows, ~20 pages, zero `lake.objects` touches), take 2× the requested count, then **one** `security_id = any(...)` probe into `lake.v_citable_objects` for `COMPUTED.RATIOS`/`COMPUTED.SCORE` (ScalarArrayOp → Index Cond, ≤24 probes, ~0.8 ms each ⇒ ~19 ms), then drop peers that produced nothing and keep the first 12 that did.

**Hoist FX out of the lateral.** The prior design's per-row correlated `select rate from public.fx_rates where pair = 'USD'||currency order by as_of desc limit 1` runs 762 index descents on *every* bundle regardless of profile — roughly 1,500–2,300 shared hits before a single peer row, which alone meets or exceeds the whole-bundle buffer ceiling on the cheapest, highest-volume lane. Use `with fx as (select distinct on (pair) pair, rate from public.fx_rates order by pair, as_of desc)` — 6 rows, one scan — and join by currency. Rank by nearest market cap in log space, USD-normalised, per `getPeerComparison`'s precedent (`src/lib/data/stock-overview.ts:229-231`).

### `EB-FILINGS`

```sql
select f.id as filing_id, f.venue_code, f.source_ref, f.filed_at, f.filing_type, f.form_code,
       left(f.title, 200) as title, f.is_market_moving,
       (f.full_text is not null)       as has_full_text,   -- null-bitmap read, no detoast
       (f.extracted_facts is not null) as has_facts,
       f.ai_summary, f.extracted_facts -> 'ai' as facts_ai
  from public.filings f
 where f.security_id = $1
 order by f.filed_at desc
 limit 8;
```

Index: `filings_security_time (security_id, filed_at desc)` (`20260713000006_fundamentals.sql:30`) → Index Scan, top-N stop, no sort, <1 ms.

**Never select `full_text`.** Measured: the 8 most recent SABIC filings carry 618 kB across 5 rows, avg 126,629 chars, max 400,000 (the extractor cap, `scripts/researchers/tier0-triage.mjs:52`). `length()` and `pg_column_size()` both detoast; `IS NOT NULL` reads only the null bitmap. Text comes from a separate capped call:

```sql
create or replace function lake.fn_filing_text(p_filing_id bigint, p_max_chars int default 20000)
returns text language sql stable security definer set search_path = '' set statement_timeout = '5s'
as $$ select left(f.full_text, greatest(1, least(p_max_chars, 60000)))
       from public.filings f where f.id = p_filing_id $$;
grant execute on function lake.fn_filing_text(bigint, int) to marsad_worker, service_role;
```

PR.2 calls it for at most 1–2 documents it has already decided are worth reading.

**The leg has no `facts` field at the type level** — `FilingsBundle.body` carries `documents[]` and `text_handle`, never `facts`. Its status is `unbindable`, never `present`, whenever rows exist. Any figure lifted from filing text must be re-bound through a `FILING.FINANCIALS` object or it fails fit's numeric pass (`fit-engine.ts:405-417`) and `draft.ts:105-112` sends the piece terminally to `reassigned_human` — the exact failure that killed both recorded drafts. When rows exist but none has text the status stays `unbindable` with `reason='no_full_text'` and the handles are **retained**: a text-availability test must never suppress document existence, or the brief says "no filings" while the reader's own filings page lists 37 (measured, sec 431).

### `EB-CALENDAR`, `EB-VENUESTATE`, `EB-REVISIONS`

`EB-CALENDAR` reads ≤6 dividends (`dividends_uni` leads with `security_id`) and ≤6 earnings events (implicit unique index on `(security_id, fiscal_period)`; `earnings_calendar_idx (report_date, security_id)` does not serve this — wrong leading column). Both are `unbindable`: every `dividends.source_object_id` resolves 1,233/1,233 to a live `FILING.FINANCIALS` `equity_change` object and every `earnings_events.source_object_id` resolves to a statement object (`20260720160500:49,60,71`), but those payloads carry `{basis, currency, line_items, period_end, period_kind, fiscal_period, statement_type}` — no `dps`, no `ex_date`, no `report_date`, no consensus. The id is a lineage pointer, not a binding. `unavailable_fields[]` enumerates what was looked for, so PR.2 can report the negative precisely.

`EB-VENUESTATE` is one pkey row from `public.venue_feed_status`, `unbindable(no_lake_object)`, with `status_ref: null` until a `MARKET.STATUS` family exists.

`EB-REVISIONS` walks the supersede chain by natural key and reads superseded values from `public.financial_statement_history` (`20260716095100:161-174`) or the retired row. The corrected object binds; the wrong value stays a literal, per `f-wire.ts:222-229` — `BLK-CORRECTION` keeps `wrong_value` literal "because the lake no longer holds it". Emits `open_correction: boolean` into `RuleContext`.

### CONFLICT objects

Every leg reads `lake.v_citable_objects`, whose predicate is `state in ('VERIFIED','PENDING')` — so `CONFLICT` rows are filtered out with no status of their own, and a cross-check disagreement is returned as absence. Measured live: **37 CONFLICT objects with `superseded_by` null**, all `QUOTE.LAST`, all carrying `security_id` (e.g. `QUOTE.LAST:DFM:AJMANBANK:2026-07-15`). For AJMANBANK the quote leg silently returns the next-older PENDING quote and the brief never mentions that two feeds disagreed on that session's close — the most editorially interesting fact available about that security that day. This inverts the platform's own posture: `BLK-CONFLICT` exists to "show both, pick neither" and can never be fed.

Fix: read `lake.objects` with `superseded_by is null and state in ('VERIFIED','PENDING','CONFLICT')` in the legs that can carry a conflict, emit CONFLICT rows with `fit_bindable: false`, `status: 'present'`, `reason: 'conflicted'`, and a `competing: [{object_id, value, source_rank}]` array. `FINANCIALS.XCHECK` (41,621 live objects) exists to produce this state, so the population only grows.

### Indexes

**One new index, and it ships IN PR.1 — not behind the sector bundle.**

```sql
create index concurrently if not exists objects_live_sec_type_date_idx
  on lake.objects (security_id, object_type, effective_date desc)
  where superseded_by is null;
```

Same column list, same direction, so every existing bundle query uses it unchanged. The argument for shipping now rather than deferring: retired rows are live MVCC tuples, so VACUUM can never reclaim them, and nothing ever deletes from `lake.objects`. Worse, `effective_date` is NULL on `COMPUTED.RATIOS`/`COMPUTED.SCORE`, so all revisions of a natural key tie on the index's third column and are ordered by heap TID ascending — the newly inserted **live** row has the highest TID and is scanned **last**. So `where security_id=$1 and object_type='COMPUTED.RATIOS' limit 1` reads and heap-fetches every retired revision before returning the live one, and that count grows by exactly 1 per security per family per night, forever. Measured today: `COMPUTED.RATIOS:QE:573` is 15 revisions deep; the peer probe reports `Rows Removed by Filter: 15` per probe to return 2 live rows; 88–93% of index entries touched are dead. Six months on, the same key is ~199 revisions deep and every "cheap" leg (identity, ratios, score, quote) degrades on the same curve. Every cost number in this document is valid only for the week it was measured unless this lands.

Expected inner-loop buffer reduction 8.5–15× from the measured ratio (377 ms → est. 40–70 ms on the `unknown` fan-out). `OHLCV.CLOSE` (640,992 rows, never superseded) contributes no dead entries, so the partial index costs only a few percent more storage than the full one today and its value grows linearly with days-since-launch (~1,276 dead entries/night ≈ 466k/year).

**Application.** `create index concurrently` cannot run inside the Supabase CLI's per-file transaction. Apply via the MCP `apply_migration` or psql, then **commit the .sql** — the MCP-apply/repo-drift trap is a documented lesson on this project. Note two migrations are already written and unapplied (`20260727161500` payload_schema, `20260727170000` ohlcv turnover); PR.1 adding a third to that queue is a real cost, and the answer is to apply all three in the same privileged session, not to defer this one.

**No other new index is needed.** Verified: `fin_stmt_lookup`, `filings_security_time`, `dividends_uni`, the `earnings_events` unique `(security_id, fiscal_period)`, `objects_natural_key_live_uni`, `securities_pkey`, `key_ratios_pkey` all already lead with the right column.

### `ops.peer_class` (rung 2, precomputed)

The rung-2 classifier is a `jsonb_object_keys` scan over the latest income statement per security — the slowest query in the pipeline if run inside a per-article bundle at `pipelineConcurrency` 12. Precompute nightly into 762 rows on the ratios cron:

```sql
create table if not exists ops.peer_class (
  security_id     bigint primary key references public.securities(id) on delete cascade,
  statement_class text not null check (statement_class in
                    ('financials_family','insurance_family','general')),
  evidence_keys   text[],
  computed_at     timestamptz not null default now()
);
grant select on ops.peer_class to marsad_worker, service_role;
```

Classifier regexes: bank `(net_)?(special_commission|interest)_income|income_from_(financing|investing)|financing_income`; insurance `premium|claims|takaful|underwrit|policyhold` (insurance wins the tie — a takaful insurer also shows financing income). Keep the patterns beside `ingestion/src/lake/sector-taxonomy.ts` so the two vocabularies cannot drift; keep the SQL as the single executor.

---

## 6. Absence, staleness, and the minimum-evidence bar

### Absence — five statuses, one closed reason enum, one exported constant

```ts
export const LEG_KEYS = [
  "EB-IDENTITY","EB-RATIOS","EB-SCORE","EB-STATEMENTS","EB-PERIODPAIR","EB-PRICE",
  "EB-QUOTE","EB-PEERS","EB-FILINGS","EB-REVISIONS","EB-CALENDAR","EB-VENUESTATE",
] as const;                                   // 12. Imported by SQL status arm, assembler, tests.

export const LegStatus = z.enum([
  "present",     // rows exist, are bound, usable
  "empty",       // the query ran against a LIVE producer and matched zero rows FOR THIS SUBJECT.
                 // Prose-legal: "the company has filed no cash-flow statement since FY23."
  "absent",      // the producer does not exist / the class is unavailable FOR ANYONE.
                 // Prose-ILLEGAL: saying "no consensus estimate is available" implies we looked
                 // at a consensus feed. There is none — estimates 0 rows, eps_consensus 0/9,188.
  "unbindable",  // rows exist AND ARE RETURNED, but carry no live lake.objects.id.
                 // Prose-legal, block-ILLEGAL. The state D-8 creates.
  "stale",       // rows exist and bind, but age_days > tolerance_days
  "refused",     // the leg declined to run: cohort below MIN_COHORT, cap exceeded, switch off
]);

export const LegReason = z.enum([
  "ok","no_rows_for_security","no_producer","producer_dark","projection_only",
  "no_lake_object","no_security_link","superseded_only","no_full_text","conflicted",
  "no_sector","cohort_thin","cohort_unusable","period_not_current","cap_exceeded","switch_off",
]);
```

`empty` vs `absent` is a status distinction, not a reason distinction, and `absent` is decided in SQL from a **producer-existence probe** (`exists(select 1 from public.estimates)`, `exists(select 1 from public.dividends where ex_date is not null)`), never from a fixture's expected value — so the verdict tracks the world the day a producer lands.

**Rule:** `present` is the only status that may carry `BoundFact`s. `unbindable` carries only `UnboundFact`s (or, for `EB-FILINGS`, handles). `empty`/`absent`/`refused` carry no evidence. Checkable in one pass; a PR.1 exit assertion.

### Staleness — per leg *and* per fact, with a verdict

```ts
export const TOLERANCE_DAYS = {
  "EB-QUOTE": 1, "EB-PRICE": 3, "EB-RATIOS": 7, "EB-SCORE": 7,
  "EB-STATEMENTS": 130, "EB-PERIODPAIR": 130, "EB-FILINGS": 90, "EB-PEERS": 7,
  "EB-IDENTITY": 3650, "EB-REVISIONS": 3650, "EB-CALENDAR": 30, "EB-VENUESTATE": 1,
} as const satisfies Record<LegKey, number>;
```

A market-level stamp would have called SABIC fresh: market-wide `max(trade_date)` is 2026-07-26, SABIC's newest bindable bar is 2026-07-14. So staleness is per leg, per security, and carries `{bindable_as_of, served_as_of, binding_lag_days, tolerance_days, age_days, verdict}`.

`as_of` = `effective_date` where present, else `payload.period_end`, else null. `observed_at` = `updated_at`, always. For the four NULL-`effective_date` types, staleness is read from `updated_at`, never `effective_date` — a one-line bug with a silent failure mode, so it gets a test per type. **The clock is injected** (`opts.now` required, never `Date.now()` inside the assembler), or every staleness test rots the day after it is written.

### The minimum-evidence bar

Reuse the house's own thresholds; do not invent new ones.

- **Identity resolvable** (a `securities` row with venue+ticker+currency) or REFUSE.
- **Period currency** passes the §5 guard (`is_latest_any_type AND within_tolerance AND has_history`) or `refused(period_not_current)`, and no pipeline item is created.
- **WIRE floor:** ≥1 `fit_bindable` fact that is not `stale`. `draft.ts:43-46` already defines a wire as one cited fact.
- **Story floor:** ≥3 `fit_bindable` non-stale facts — the minimum for a legal `BLK-STATSTRIP` (`c-tabular.ts:25-46`, `.min(3)`), which is also the minimum for layout 1a to legally place its mandatory premium cut (`fit-engine.ts:778-782` `isDataBlock`, `:853-866` `FIT-CUT-UNPLACEABLE`). A FEATURE with fewer cannot carry a cut and is refused before anyone judges the prose.
- **Longform floor:** ≥8 bound facts across ≥2 object types and ≥2 periods, at least one from a statement object.
- **Peer/comparison blocks:** cohort method ≠ `none` and `peer_count_bindable ≥ MIN_COHORT` (8), imported from `score-engine.ts:103`.

Below the bar the brief returns `verdict: 'insufficient_evidence'` with every leg status attached and **no pipeline item is created**. A bundle that finds nothing is a legitimate empty result, not an exception — `consumer.ts:200-229` turns a throw into pgmq redelivery (600 s × 5) then an `ops.incidents` row at severity `critical`. Only infrastructure failures may throw.

**`prose_legal: false` on every `UnboundFact`, enforced.** Nothing in the brief that lacks a binding may be quoted as a numeral. This is the same rule as `EB-FILINGS`', generalised, and it is what stops the writer producing a number that R-04 blocks at the rules stage and fit refuses at `FIT-NUMBER-MISMATCH`.

---

## 7. The peer-set ladder and the 64% unknown

Rung 1 is `securities.status='listed' AND securities.sector = <subject.sector> AND sector <> 'unknown'`, GCC-wide, keyed **exactly** as `score-engine.ts:399-407` (`const key = input.sector ?? 'unknown'`; venue is not in the key) so the bundle's peer set and the same article's `sector_percentile` cannot disagree. A Saudi bank and a Qatari bank are one cohort by owner decision D-2. `thin` uses the imported `MIN_COHORT = 8` (`score-engine.ts:103`), not a second constant.

| rung | method | predicate | cumulative coverage | permitted blocks |
|---|---|---|---|---|
| 1 | `sector` | `securities.sector`, GCC-wide | 275/762 = **36.1%** | COMPARE, RANKROW, SCATTER (needs cohort ≥8), BARS |
| 2 | `statement_class` | `ops.peer_class` ∈ {financials_family, insurance_family} | 356/762 = **46.7%** | COMPARE, RANKROW, BARS |
| 3 | `market_cap_band` | same venue, ±1 order of magnitude, nearest by \|log(mcap)\| | 674/762 = **88.5%** | **COMPARE only** |
| 4 | `venue` | same venue | 736/762 = **96.6%** | **none** — a venue statistic, F-family only |
| 5 | `none` | — | 26 securities | none |

Rung-1 membership: consumer 70, materials 43, industrials 38, insurance 26, banks 20, healthcare 20, real_estate 19, telecom 10, financials 9, technology 8, energy 6, utilities 6. Energy and utilities sit below `MIN_COHORT` and carry `thin: true`.

```ts
export const PERMITS_BY_METHOD: Record<CohortMethod, BlockCode[]> = {
  sector:          ["BLK-COMPARE","BLK-RANKROW","BLK-SCATTER","BLK-BARS"],
  statement_class: ["BLK-COMPARE","BLK-RANKROW","BLK-BARS"],
  // A size band is not an economic peer set. BLK-COMPARE prints its own column headers so
  // the reader sees exactly who the comparison is against; BLK-SCATTER's quadrant medians
  // would imply a sector structure that does not exist.
  market_cap_band: ["BLK-COMPARE"],
  venue:           [],
  none:            [],
};
```

`method` is required and non-nullable — a degraded rung rendered as if it were rung 1 (a market-cap band printed under the word "peers") is the failure this field exists to prevent. `basis_label` is what PR.4 must call it: "GCC banks", "GCC lenders", "Saudi-listed materials names", "similarly sized Abu Dhabi listings". Never "peers" at rung 3, and never an exchange sector at rung 2.

**`venue_spread` is mandatory** because the "GCC-wide" claim is currently false for six sectors: materials 43/43, healthcare 20/20, technology 8/8, energy 6/6, utilities 6/6, financials 9/9 are 100% TDWL.

**Membership is filtered by object existence, not by `securities.sector` alone** — otherwise the block is composed, spent on, and then refused at fit. `metric_availability` returns the renderable (names × metrics) rectangle, not counts, for the same reason `BoundGrid` does: `BLK-COMPARE.metrics[].values` is `z.array(ObjectBinding).min(2).max(4)`, non-nullable, with a count refinement (`c-tabular.ts:307-338`).

Rung 2's precision on the labelled set is 100% (0 false positives across 203 labelled non-financial names; 19 of 20 labelled banks, 5 of 10 labelled insurers), but the labelled set is only 20 banks and 10 insurers — so the class licenses ratio comparison and never a sector-level assertion, and precision is re-measured against the newly labelled ADX/MSX names as a holdout once the sector backfill lands.

**The 64% is fixable and it is not PR.1's job — but the ladder must not pretend otherwise.** The sector-fix task is ~2–3 days: (1) change the coverage guard from `profile_scraped_at IS NULL` to `sector='unknown' OR isin IS NULL` at `runtime.ts:475` and `tadawul-researcher.mjs:181` — one hour, unlocks 453 currently-locked names; (2) TDWL 142 via the XBRL `[100010]` block, already parsed by `parseTadawulProfile` (`adapters/tadawul/xbrl.ts:297-357`), plus a payload **merge** in `lake-objects.mjs` so shares and identity stop clobbering each other; (3) MSX 110 via the `GetPageData` board, which already carries a sector column, zero extra requests; (4) ADX 90 needs one VPS capture to pin the URL and gateway apikey; (5) DFM 69 and (6) BHB 41 stay blocked (DEF-SECTOR-DATA-DFM-QE, DEF-SECTOR-DATA-BHB). Steps 1–3 are free and reach 652/762 = **85.6%**, moving rung 1 from 36.1% to ~86%. Log it in BUILD-STATUS §7 as a peer-set trigger under DEF-SECTOR-DATA.

---

## 8. Where the code lives

```
ingestion/src/research/
  types.ts      LEG_KEYS, LegStatus, LegReason, CohortMethod, EvidenceBrief interfaces — dependency-free
  envelope.ts   the Zod schemas of §4
  lexicon.ts    METRIC_KEYS, CANON_LINE_ITEMS, RESOLVABLE_FIELD, FIELD_FORMAT, LEXICON_VERSION
  kinds.ts      BUNDLE_KINDS, per-kind {question, sources, kind_version, tolerance}
  queries.ts    the SQL. Thin. Takes LakeSql, returns BundleRaw. NO judgement.
  assemble.ts   PURE: assembleBrief(raw, opts) => EvidenceBrief. ALL judgement lives here.
  cohort.ts     the ladder (imports MIN_COHORT from ../lake/score-engine.js)
  verify.ts     verifyBundle(brief, objects) — the property checker, shared by golden + live lanes
  hydrate.ts    FactRef → ObjectBinding substitution + live re-resolution
  policy.ts     PERMITS_BY_METHOD, block eligibility
  index.ts      barrel
  __fixtures__/ 7 recorded raw snapshots
  *.test.ts     node:test
```

**In `ingestion/`, not `worker/`, and typed against `LakeSql`** (`ingestion/src/lake/db.ts:21-35`), never `postgres.Sql` and never `createDb`. That inherits the free test lane (`node --import tsx --test "src/**/*.test.ts"`, `ingestion/package.json:28`) and `ingestion/src/lake/fake-db.ts`. This is the third instance of an established pattern — `RuleContext` ("The assembled bundle one piece is judged on", `ingestion/src/rules/types.ts:35-54`, assembled at `rules-stage.ts:97-129`) and `FitInput` (`fit.ts:122`) are the first two.

**Wiring cost is one line**: `export * from './research/index.js'` in `ingestion/src/index.ts`. The exports map is root-only (`ingestion/src/index.ts:50-53`) and the worker already static-imports from the package root in five newsroom files (`draft.ts:12`, `edit.ts:11`, `classify.ts:14`, `rules-stage.ts:11`, `fit-engine.ts:23-24`).

**The `queries.ts`/`assemble.ts` seam is the whole testability story.** Anything decided in SQL is untestable without a DB. So `queries.ts` returns rows; the rung ladder, absence classification, staleness verdict, field allow-list, `fit_bindable`, rectangularisation and the minimum-evidence gate all live in `assemble.ts`. Consequence for the peer leg: `queries.ts` returns candidate membership for all four rungs in one pass (from the small `public.*` tables) plus the objects for the union of the top-12 per rung capped at 24 securities, and `assemble.ts` picks the rung.

**Not plpgsql.** A new SQL function costs a migration + a grant + an edit to `ops.check_worker_function_grants()`'s allow-list (`20260726171614:37-42`) per iteration, and a forgotten grant is a silent production freeze — the 5-day OHLCV precedent. `lake.fn_filing_text` is the one exception (it must be `security definer` to read `full_text` under a cap); extend the allow-list for it and for `lake.fn_writer_context(bigint,int,int)` in the same migration.

**Do not reuse `src/lib/data/*.ts`.** Every one is `import "server-only"` + `"use cache"` + `createAnonClient` (`src/lib/supabase/public.ts:25`), and the root `tsconfig.json` excludes `worker` and `ingestion` — four independent blockers. The anon path also sees a deliberately narrowed cut (`v_financials_public` is 4 quarters + 2 annuals, no `line_items`, EPS suppressed for every TDWL row) that would starve a bundle. Reuse the *logic* — `getPeerComparison`'s FX-normalise-before-ranking (`stock-overview.ts:229-231`), `getFxUsdRates`'s `USDxxx → 1/rate` convention (`entities.ts:39-56`) — never the code.

**Ports and hazards.** `binding.ts:39` and `:48` declare `objectId` and `objectField` as module-private `const`; export both, so the envelope reuses the identical uuid check and dotted-path regex rather than a copy that drifts. PR.1 is read-only and needs no principal GUC, but it does need `sql.begin` for the statement timer (§5). Gate the whole path behind an `iam.global_switches` key read via `switchOn` (`shared.ts:26-34`) so it can be deployed dark and killed under load — `switchOn` returns false for a key that does not exist, which is the same pattern the fit stage shipped with. Give the bundle path its own small pool (max 4) or a semaphore below `pipelineConcurrency`, so newsroom research can never consume the ingest budget.

---

## 9. Build order

Each step is independently verifiable and lands with its own assertion.

**Step 0 — Measure what the two prior passes disagreed on.** Under the exact predicate set §5's statements apply (`is_estimate=false`, `statement_type in ('income','balance','cashflow')`, joined to `lake.v_citable_objects`), report `count(*)`, `count(source_object_id)`, and `count(*) filter (where the object resolves live)` for `public.financial_statements`. Reconcile 49,805 vs 52,290. Write the number into the exit criterion; it is currently checked against a figure nobody measured. *Verify:* the three numbers are in the PR description.

**Step 1 — `types.ts` + `envelope.ts` + `lexicon.ts`, no SQL.** `LEG_KEYS` (12), the five statuses, the closed reason enum, the three evidence members, `RESOLVABLE_FIELD`, `FIELD_FORMAT`. Export `objectId`/`objectField` from `binding.ts`. *Verify:* `tsc --noEmit` in ingestion; a unit test asserts every `BUNDLE_KINDS` entry has a `TOLERANCE_DAYS` entry (via `satisfies`) and that `RESOLVABLE_FIELD` rejects `numeric_value`, `natural_key`, `superseded_by`, `revision`, `security_id`, `created_at`.

**Step 2 — `verify.ts` and the four traps, no DB.** `verifyBundle(brief, objects: Map<string, ObjectSnapshot>) → ResolveFailure[]`. Unit tests for: numeric string vs JSON number (postgres.js returns `numeric` as a JS *string* `'902850000'` while `payload.pe` is a JSON number `56.06186582284612`; `'6250000000.00'` differs textually from `6250000000`); an absent `line_items` key (F2 has no `gross_profit`, F1 has no `net_interest_income`); a non-v4 uuid (the `fit.test.ts:44-48` lesson — the old all-1s constant was DB-legal and `z.uuid()`-illegal; 20,000/20,000 live ids are strict v4); a retired object. *Verify:* `npm test` in ingestion passes with the network down.

**Step 3 — the index and `ops.peer_class`.** Apply `objects_live_sec_type_date_idx` out-of-transaction via MCP/psql, alongside the two already-unapplied migrations, and commit the `.sql`. Create `ops.peer_class` + `ops.refresh_peer_class()` and schedule on the ratios cron. *Verify:* re-run the 20-name and 487-name peer EXPLAINs and record the new buffer counts against the 732 / 10,736 baseline; `select count(*), statement_class from ops.peer_class group by 2` returns 762 rows with ≥81 non-`general`.

**Step 4 — `queries.ts`: the guard statement only.** *Verify:* run against the 480 `(security_id, statement_type)` pairs whose max `period_end` is older than 130 days and assert all refuse; run against a security whose only cashflow row is 2021 while income runs to 2026 and assert `is_latest_any_type = false`; run against a December-FY security where FY and Q4 share `period_end` and assert `prior_period_end` differs by `period_kind`.

**Step 5 — `queries.ts`: the 10 cheap legs, fused, with real `Const` limits.** Compile-check the SQL text before anything else — the prior design's `UNION ALL` arms with per-arm `ORDER BY … LIMIT` do not parse. *Verify:* per-leg `EXPLAIN (ANALYZE, BUFFERS)` executed **through the shipped call path with parameters, on the 6th+ invocation** (generic plan), not against literals. Assert: statements Index Scan with no Sort and no WindowAgg; price Index Scan with no Sort; `price_anchors` returns 5 rows for a security with ≥365 days of bars.

**Step 6 — `queries.ts`: the peer statement, isolated.** FX hoisted to a 6-row `distinct on`. *Verify:* buffer count for a `wire` profile (peers=0) is under 200, proving the peer chain is short-circuited; the 12-name path measures ≤25 ms.

**Step 7 — `assemble.ts`.** The ladder, absence classification, staleness with injected clock, rectangularisation, `fit_bindable`, the minimum-evidence gate, `totals`/`allow_set`/`suggested_word_budget`. *Verify:* the 7 fixtures × 12 legs absence matrix (§10 EC-10) and the determinism assertion.

**Step 8 — record the 7 fixtures.** `scripts/research/record-bundle-fixtures.mts`. Securities: **183** TDWL:4290 (rich, every leg present, cohort of 70); **573** QE:QIBK (bank IAH taxonomy — income `line_items` carry `distribution_of_profit_loss_to_investment_account_holders` and **no `gross_profit`/`cost_of_sales`**; 47 of 48 filings have `full_text`; the only venue whose `PROFILE.SECURITY` carries sector); **431** ADX:FCI (unknown sector, not bank-shaped, 0 `full_text`, forces rung 3); **430** ADX:FAB (a real bank the taxonomy does not know is a bank — `net_interest_income`, `interest_income`, `income_from_islamic_financing_and_investing_products` with `sector='unknown'` — forces rung 2); **284** TDWL:8300 (ratios but **no score object**, 21 `full_text` / 0 `extracted_facts`, forces `peer_count_bindable` ≠ `scorer_cohort_size` at 2 vs 26); **10** TDWL:1113 (sparse: ratios + 215 bars + quotes and *nothing else* — no profile object, no statements, no filings rows); **221** TDWL:5022 (the refusal case: 1 bar and 1 VERIFIED quote, both `2026-07-14`, so a naive "≥1 VERIFIED fact" gate *passes* it on a 13-day-old quote). Hard rules on the recorder: record exactly what the caps return; never record `full_text`; assert `JSON.stringify(fixture).length < 250_000` and no string field > 4,096 chars. *Verify:* 7 files, ~350 kB total, size invariants hold.

**Step 9 — `hydrate.ts` with the live resolver.** *Verify:* a brief whose ratios object has been superseded returns `superseded` for every ratios fact and `value_moved` when the live value differs by more than `DRIFT_TOL`; never `ok: true` with a retired uuid.

**Step 10 — `scripts/research/bundle-conformance.mts` (Lane B).** Runs the real queries for the 7 fixtures; runs the **SQL** re-implementation of the resolution property (independent of the TS resolver, so the two cannot be wrong together); runs `EXPLAIN (ANALYZE, BUFFERS)` per leg; runs the object-id-lifetime probe and reports revisions/day; diffs live leg statuses against the fixtures' expectations as *information*, not failure. Writes `/tmp/pr1-conformance-<date>.md`. Exits non-zero only on a resolution violation. **Never in CI** — it needs a privileged DB URL and queries a database that fell over today.

**Step 11 — instrumentation.** Per-leg ms + row counts + statuses into a structured log line on every assembly; a `degraded` `ops.incidents` row when p95 `assembly_ms` crosses 250 ms. The revision-scan decay is a smooth degradation with no step change — without this the first observable symptom is ingest starvation, i.e. the failure, not the trend.

**Step 12 — CI wiring and the doc deltas.** Add `"test"` to `worker/package.json` (parity with ingestion — one line, and it also switches on the 30 kB `fit.test.ts` that has never run); add a `tests` job to `.github/workflows/ci.yml` gated like the existing `worker` job, no secrets; add `scripts/gate.sh` as the local pre-merge ritual, because CI has aborted in 3–5 s on billing since 2026-07-18 (`DEF-RLS-GATE-RED-SINCE-0720`) and `assert-rls.sql` has been failing since 2026-07-20 unnoticed. Land §10's doc corrections in the same commit.

---

## 10. Acceptance criteria

**Correctness**

- [ ] **EC-1** `verifyBundle()` returns `[]` for all 7 fixtures (TS harness).
- [ ] **EC-2** The independent SQL re-implementation of the resolution property returns **0 rows** for all 7 securities against the live DB. *(The criterion the phase rests on: TS and SQL resolvers agree with each other and with Postgres. Tolerance is exactly 0 — the value is a copy, not a computation.)*
- [ ] **EC-3** Every fact survives `ObjectBinding.safeParse` using the real schema from `binding.ts:62-68`. Zero failures.
- [ ] **EC-4** `facts.filter(f => f.value === null).length === 0`. A path that resolved to null produced no fact.
- [ ] **EC-5** Every `field` matches `RESOLVABLE_FIELD`; zero `numeric_value` anywhere, including `EB-SCORE` and `EB-PEERS`; every emitted `(object_type, field)` has a `FIELD_FORMAT` entry.
- [ ] **EC-6** No leg with `status='present'` contains a fact without a live `lake.objects.id`; no leg with `status='unbindable'` contains a `BoundFact`; `empty`/`absent`/`refused` carry zero evidence.

**Sufficiency**

- [ ] **EC-7** For F1–F5, `totals.fit_bindable_facts >= 3` counting only non-stale facts — the minimum for a legal `BLK-STATSTRIP` and therefore for layout 1a to place its mandatory cut. **This passes today on ratios + score alone**: a median security carries ~9–12 non-null ratio facts plus up to 12 score facts, all VERIFIED, at 96.6%/70.9% coverage. PR.1 is useful before the VERIFIED question is settled.
- [ ] **EC-8** F7 returns `verdict:'insufficient_evidence'` with all 12 legs populated and **no throw**, and the reason names staleness (13-day-old quote), not absence. Re-run at `now='2026-07-15'` and it clears the WIRE floor. F6 clears WIRE and fails longform.
- [ ] **EC-9** Every fact has `binding_shape:'scalar'` or rides `BoundSeries.points`. `series_binding` and `grid_binding` are null everywhere. The 8 array-shaped blocks are declared out of scope in the module header.
- [ ] **EC-10** The 7 × 12 absence matrix matches exactly, including `reason`, as a hard assertion with the fixture's `recorded_at` in the failure message. Load-bearing cells: identity on F6/F7 is `unbindable(projection_only)`, not `present` (neither has a `PROFILE.SECURITY` object); calendar on F1–F5 is `absent(no_producer)`, not `empty` (no consensus feed exists for anyone); filings on F3/F4 is `unbindable(no_full_text)` with handles retained, not `absent` (37 and 54 documents exist).
- [ ] **EC-11** No free-text reason anywhere.
- [ ] **EC-12** `EB-FILINGS` has no `facts` field at the type level; grep for `object_id` under the filings leg returns nothing.
- [ ] **EC-13** Per-leg, per-security staleness with an explicit verdict, computed from `updated_at` for the four NULL-`effective_date` types — one test per type.
- [ ] **EC-14** `bindable_as_of` ≠ `served_as_of` is reported on `EB-PRICE`, `bindable_as_of <= served_as_of`, and no fact is emitted past `bindable_as_of`.

**Structural honesty**

- [ ] **EC-15** Every `BoundGrid` satisfies `cells.every(r => r.length === column_labels.length)` with no nullable member, and `rows_dropped`/`columns_dropped` are populated whenever the raw set was ragged.
- [ ] **EC-16** Every leg returns the fact keys it claims for the fixtures where the rows exist — F1 returns 5 price anchors, 11 quote keys, ≥3 statement periods. *(Without this, a leg that silently returns 1 anchor instead of 5 passes every other criterion.)*
- [ ] **EC-17** No `UnboundFact` appears in `totals.bound_facts`; every one carries `prose_legal: false`.
- [ ] **EC-18** A fixture containing a `CONFLICT` object yields `present`/`conflicted` with a `competing[]` array, never absence.

**Cohort**

- [ ] **EC-19** `cohort_method` is required and non-nullable; the ladder degrades one rung at a time and never skips.
- [ ] **EC-20** `MIN_COHORT` is imported from `score-engine.ts:103`, not restated.
- [ ] **EC-21** `peer_count_bindable` and `scorer_cohort_size` are returned under distinct names and F5 shows them disagreeing (26 vs ≤2).
- [ ] **EC-22** The ladder is exercised end to end: `sector` (F1, F2), `statement_class` (F4), `market_cap_band` (F3), `none` (F7 → `refused(cohort_unusable)`, `members: []`, `permits: []`).
- [ ] **EC-23** `venue_spread` is populated on every present peer leg.

**Period currency**

- [ ] **EC-24** The guard refuses all 480 stale `(security_id, statement_type)` pairs; `prior_period_end` is `period_kind`-matched; a single-observation history refuses.

**Operational**

- [ ] **EC-25** ≤3 statements per assembly, logged. `set local statement_timeout = '5s'` is set **inside** `sql.begin` before the first bundle query, and a probe confirms the timer is actually armed (a deliberately slow query aborts at 5 s).
- [ ] **EC-26** Each of the 7 bundles completes in <300 ms and <2,000 shared buffers on a warm DB, **measured through the shipped call path with parameters on the 6th+ invocation**, written into the report.
- [ ] **EC-27** Grep `queries.ts` for `full_text`: the only legal occurrence is `full_text is not null`.
- [ ] **EC-28** Fixtures: <250 kB serialised, no string field > 4,096 chars.
- [ ] **EC-29** Lane A is hermetic — `ingestion/src/research/*.test.ts` imports no `postgres`, opens no socket, passes with the network down.
- [ ] **EC-30** Determinism: two runs over the same `raw` are byte-identical, including array order. `assemble.ts` never calls `Date.now()`/`new Date()`.
- [ ] **EC-31** `hydrate` never returns `ok: true` for a fact whose live revision exceeds the recorded one without re-resolution, and returns `value_moved` when the live value differs by more than `DRIFT_TOL`.
- [ ] **EC-32** `suggested_word_budget` never lands in [40, 89] for a financials trigger.

**Docs (same commit, AGENTS.md discipline)**

- [ ] **EC-33** `docs/BRIDGE-BUILD-PLAN.md:1241-1252` — exit criterion replaced by EC-7; "recent filings … each row carrying the `lake.objects.id`" corrected to the bindable/unbindable split; "given a `security_id` and an `event_type`" corrected to `(security_id, trigger_object_id, now)`.
- [ ] **EC-34** `docs/BRIDGE-BUILD-PLAN.md:1232-1237` and `09 §12.3` item 3 — both claim fit *refuses* a template declaring a legacy key. `fit-engine.ts:332-343` pushes `FIT-TEMPLATE-LEGACY-KEY` as a **warning**; only an emitted legacy code refuses (`:238-247` `FIT-BLOCK-LEGACY`). PR.0c is a quality gate, not a hard blocker.
- [ ] **EC-35** `docs/architecture/09-signal-to-article.md` §4's exhibit table re-pointed: `BLK-INDEXED` has no bindable benchmark (42 `INDEX.LEVEL` objects, `security_id` on 0, `benchmark` required at `d-charts.ts:417`); `BLK-BEATMISS` needs a consensus with 0 rows; `BLK-WATERFALL`/`BLK-STACK` need segment objects no producer writes; `BLK-SCORE` is a legacy code.
- [ ] **EC-36** `src/lib/data/filings.ts:119,121` — claims ~152 `full_text` / ~2.3k `extracted_facts`; measured 5,929 and 3,866. `src/lib/data/financials.ts:23-25` — claims 52,277 rows over 626 securities; measured 49,805 over 599 (and reconcile against step 0).
- [ ] **EC-37** `docs/BUILD-STATUS.md` §7 gains: `DEF-BUNDLE-ARRAY-BINDING` (trigger: a `SERIES.*`/`OHLCV.WINDOW` producer, or PR.5's chart compiler); `DEF-BUNDLE-OBJECT-ID-LIFETIME` (trigger: D-8 resolver policy decided); `DEF-BUNDLE-FILING-UNBINDABLE` (trigger: `filings.source_object_id` or `FILING.REF.security_id` lands); `DEF-BUNDLE-CALENDAR-DEAD` (trigger: a dividend-confirmation producer writes `state='live'` with `ex_date`); *OHLCV projection writes no lake object since 2026-07-14* (trigger: a bound price exhibit is proposed); *`MARKET.STATUS` family* (trigger: the first piece quoting a live price); *`COMPUTED.RATIOS.payload.input_as_of`* (trigger: the first bound valuation multiple is published); *sector backfill as a peer-set trigger* under `DEF-SECTOR-DATA`.

---

## 11. What PR.1 does not do, and what it hands to PR.2

**Does not build**

- **Chart-shaped bundles beyond `BoundSeries.points`.** Families B, D, E, F, H have 0 renderers (20 of 61 exist: A=6, C=8, G=6), PD.6's chart compiler does not exist, and no lake payload holds an array. Keep the question-indexed naming so they slot in unchanged.
- **A bundle aimed at `BLK-FINTABLE`.** Double-blocked: its `piece_types` are `{'DEEP DIVE','NOTE'}`, `classify.ts:95` only ever writes `WIRE` or `ARTICLE`, and `DEEP DIVE` arrives only via TPL-08 which `edit.ts:70-75` assigns only on an `EARNINGS.VERDICT` citation — a family with 0 rows. `EB-STATEMENTS` still returns the grid; PR.4 spends it on `BLK-STATSTRIP` and `BLK-COMPARE`.
- **Segments, desk estimates, ownership, IPO, index benchmark, glossary.** Tier 3, not declared, not requestable.
- **Derived numbers as prose material.** Deltas, medians and computed returns are not emitted at all where a bound equivalent exists in `COMPUTED.RATIOS`, and carry `prose_legal: false` where one does not.
- **Brief persistence.** PR.1 is read-only. `ops.research_briefs (id, content_id, security_id, contract_version int not null, kind_versions jsonb, brief jsonb, assembled_at, assembly_ms)` — with `contract_version` as a *column* so a reader dispatches without parsing — is PR.2's migration, and `marsad_worker` will need an INSERT grant it does not have.
- **A sector-wide bundle.** The owner's goal names "a stock **or sector**", but the sector fan-out is the 377 ms / 10,736-buffer path and 64% of the universe is `unknown`. It lands after the partial index (step 3) and the sector backfill. The ladder returns `cohort_method` so a sector-shaped claim is at least honest about its basis in the meantime.

**Hands to PR.2**

An `EvidenceBrief` with: all 12 legs present with a status and a closed reason; every fact resolved, formatted and stamped; `allow_set` as the server-built citation allow-set that dissolves DEF-WRITER-CITATION-ALLOWSET by construction; `fit_bindable` per fact so PR.2 knows what will survive fit before spending a token; `cohort_method` + `permits[]` so block selection is a lookup, not a judgement; `notes[]` per leg for the "what I looked for and did not find" half of the brief; and `verdict` + `suggested_word_budget` so PR.3/PR.4 never compose into a guaranteed-refusal band.

**Blocks on decisions outside PR.1**

Three, all recorded here because PR.1's numbers move if they resolve:

1. **The VERIFIED wall.** `fit-engine.ts:386-395` refuses any bound object that is not VERIFIED. Options: widen it to read a new `ops.materiality_prefilter.citable_states text[]` column (distinct from `accepted_states`, because widening that for `OHLCV.CLOSE` would open *intake* for 640,992 objects) — the identical D-10 argument PE.6 already won for intake, ~4 lines at `fit-engine.ts:386` plus one column in `assembleFitInput` (`fit.ts:147-159`); or keep it and cap PR.1's ambition. Today an earnings recap can state a P/E and a score but **no reported revenue figure**. EC-7 is written against today's rule and passes either way; if the wall widens, its floor rises from 3 to ~15 and the fixtures' `fit_bindable` columns all flip.
2. **Object-id lifetime.** (a) the resolver follows `superseded_by` forward; (b) bindings carry `(natural_key, revision)` rather than a raw uuid — a `binding.ts` change that ripples into fit-engine's structural detector (`index.ts:165-172`); (c) the COMPUTED producers stop retiring and carry revisions with `superseded_by` only, leaving state VERIFIED. PR.1 ships `rebind` on every fact so all three stay open, and `hydrate`'s live re-resolution makes PR.4 safe under any of them — but which is authoritative is a decision, not a detail: today D-8's second promise ("fix the object once and every citing piece updates") is false in the opposite direction for `COMPUTED.*`.
3. **Array addressing.** Mint a `SERIES.*`/`OHLCV.WINDOW` family whose payload holds the point array (the data exists — 640,992 `OHLCV.CLOSE` rows), or amend `ChartSeries` (`binding.ts:89-101`) to take an ordered binding list. Option (a) preserves D-8 exactly and gives `BLK-DOWNLOAD` a real object; (b) ripples into fit-engine. Eight blocks are dead until one is chosen. PR.1 emits points either way.

**Adjacent unblocks this design exposes, ranked by leverage/cost:** (1) `MARKET.STATUS` — a 7-row producer from `public.venue_feed_status`, unblocks `BLK-FRESH` which is mandatory on any live figure; belongs in PR.0. (2) The VERIFIED decision above. (3) `ops.materiality_prefilter` rows for `COMPUTED.RATIOS` and `FINANCIALS.XCHECK` — both currently pass the intake gate *by accident* (no prefilter row → `v_verdict` NULL → not `not_material`), and `COMPUTED.RATIOS` is 736 VERIFIED objects with succeeded parse runs routing to the **paid** LLM classifier tier the moment `pipeline_intake_enabled` flips. (4) The `lake-objects.mjs` PENDING-branch merge — one function, stops the profile clobber in both directions. (5) Sector backfill steps 1–3 — free, reaches 85.6%.