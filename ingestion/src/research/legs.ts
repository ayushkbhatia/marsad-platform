/**
 * PR.1 step 3 — the evidence legs. Deterministic SQL, no LLM, no wall-clock inside a query.
 *
 * ── WHY THIS EXISTS ALONGSIDE `lake.fn_writer_context` ──────────────────────────────────────────
 * `fn_writer_context` + `pack.ts` already give the WRITER a context pack, and it is a real fix to a
 * real bug. But it is the writer's *input*, not a research desk:
 *
 *   · it reads `public.key_ratios` and `public.scores` — the PROJECTIONS — so those facts carry no
 *     `lake.objects.id` and are therefore not citable. Measured: `statements` is the only section
 *     with a per-fact `source_object_id`.
 *   · it covers ONE security. There is no peer set, so "how does this compare" has no evidence.
 *   · it cannot say what it looked for and did not find. An empty section and a dead producer are
 *     indistinguishable, which is exactly the licence a writer needs to invent a reason.
 *
 * These legs bind to `lake.objects` directly, so every fact carries the id and dotted field path
 * D-8 needs, and every leg reports a status even when it returns nothing.
 *
 * ── THE ACCESS PATTERN ──────────────────────────────────────────────────────────────────────────
 * Every security-scoped query is shaped to ride `btree (security_id, object_type, effective_date
 * DESC)`, which already exists. `superseded_by is null` restricts to live revisions — necessary
 * because COMPUTED.RATIOS carries 13.9 revisions per natural key and a binding to a retired one
 * either refuses at fit or, worse, renders a new value under frozen prose.
 *
 * @see docs/architecture/build-specs/PR1-evidence-bundles.md §5
 */
import type { Sql } from "../core/db.js";

import type { Evidence, EvidenceLeg, FactFormat } from "./envelope.js";
import { formatFor, isLineItemField, isResolvableField } from "./lexicon.js";
import { TOLERANCE_DAYS, type LegKey, type LegReason, type LegStatus } from "./types.js";

/** One live lake object row, as every leg reads it. */
interface ObjRow {
  id: string;
  object_type: string;
  natural_key: string;
  revision: number;
  state: string;
  payload: Record<string, unknown> | null;
  unit: string | null;
  effective_date: string | null;
  updated_at: string;
  source_rank: number | null;
}

/** Volatility by family — how a value behaves, so a consumer knows if re-resolving can move it. */
const VOLATILITY: Record<string, "immutable" | "recomputed" | "perishable"> = {
  "FILING.FINANCIALS": "immutable",
  "COMPUTED.RATIOS": "recomputed",
  "COMPUTED.SCORE": "recomputed",
  "PROFILE.SECURITY": "recomputed",
  "QUOTE.LAST": "perishable",
  "OHLCV.CLOSE": "immutable",
};

/**
 * A timestamp as ISO, or the epoch when it is missing or unparseable.
 *
 * `new Date(undefined).toISOString()` throws RangeError, and a single malformed or absent
 * `updated_at` on one row would otherwise take down the ENTIRE brief — twelve legs lost to one bad
 * timestamp. The envelope requires an `observed_at`, so the honest degradation is a value that is
 * obviously wrong rather than an exception: an epoch date reads as "we do not know when this was
 * observed", which is true.
 */
function isoOrEpoch(v: string | null | undefined): string {
  if (!v) return new Date(0).toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
}

function ageDays(asOf: string | null, now: Date): number | null {
  if (!asOf) return null;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

function freshnessOf(age: number | null, tolerance: number | null): Evidence["freshness"] {
  if (age === null || tolerance === null) return "unknown";
  if (age <= tolerance) return "fresh";
  if (age <= tolerance * 3) return "aging";
  return "stale";
}

/**
 * Read a dotted path off a row. Mirrors `verify.resolveField`, but returns `undefined` for a
 * missing key so the caller can DROP the fact rather than emit a null one — a fact whose field does
 * not exist is an assembler bug, not an observation.
 */
function readField(row: ObjRow, field: string): unknown {
  if (field === "effective_date") return row.effective_date;
  if (field === "unit") return row.unit;
  const parts = field.split(".");
  if (parts[0] !== "payload") return undefined;
  let cur: unknown = row.payload;
  for (const k of parts.slice(1)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

interface FactBuildOpts {
  bundle: LegKey;
  row: ObjRow;
  field: string;
  label: string;
  metricKey: string;
  now: Date;
  citableStates: string[];
  /** For a DERIVED family, the oldest input the producer consumed. */
  inputAsOf?: string | null;
  seq: () => string;
}

/**
 * Build one BoundFact, or null when it must not be emitted.
 *
 * Returns null — rather than a fact with a null value — in three cases, all of which are assembler
 * errors rather than observations:
 *   · the field path is outside RESOLVABLE_FIELD (`numeric_value` is excluded absolutely);
 *   · the key does not exist on the object;
 *   · there is no FIELD_FORMAT entry, so we would have to guess how to print it.
 *
 * A key that EXISTS and is null is different and also returns null here, because a fact with no
 * value is not evidence — but the leg records it in `notes` so the absence is still reported.
 * Measured: `dividend_yield`, `payout_ratio` and `nim` are null on all 736 COMPUTED.RATIOS rows.
 */
function buildFact(o: FactBuildOpts): Evidence | null {
  if (!isResolvableField(o.field)) return null;
  const raw = readField(o.row, o.field);
  if (raw === undefined || raw === null) return null;

  // Line items cannot be enumerated in FIELD_FORMAT — the key set differs by statement type and by
  // filer (a bank has net_interest_income and no gross_profit). Their format is derived from the
  // object's own reporting currency instead, which is the only honest source for it.
  let format: FactFormat | null = formatFor(o.row.object_type, o.field);
  if (!format && isLineItemField(o.row.object_type, o.field)) {
    const ccy = o.row.payload?.["currency"];
    format = {
      value_kind: "number",
      multiplier: 1,
      unit: null,
      currency: typeof ccy === "string" && ccy.length === 3 ? ccy : null,
      scale: "unit",
      decimals: 2,
    };
  }
  if (!format) return null;

  const asOf = o.row.effective_date ?? (o.row.payload?.["period_end"] as string | undefined) ?? null;
  const age = ageDays(asOf, o.now);
  const value =
    typeof raw === "number" || typeof raw === "boolean" ? raw : String(raw);

  return {
    kind: "fact",
    fact_id: o.seq(),
    bundle: o.bundle,
    binding: { object_id: o.row.id, field: o.field },
    binding_shape: "scalar",
    object_state: o.row.state as "VERIFIED" | "PENDING" | "CONFLICT",
    // D-14: fit refuses a binding whose citations are all outside the type's citable states, so a
    // fact is marked here rather than discovered after the tokens are spent.
    fit_bindable: o.citableStates.includes(o.row.state),
    rebind: {
      object_type: o.row.object_type,
      natural_key: o.row.natural_key,
      revision: o.row.revision,
    },
    volatility: VOLATILITY[o.row.object_type] ?? "recomputed",
    source_rank: o.row.source_rank,
    label: o.label,
    metric_key: o.metricKey,
    value,
    format,
    as_of: asOf,
    observed_at: isoOrEpoch(o.row.updated_at),
    input_as_of: o.inputAsOf ?? null,
    age_days: age,
    freshness: freshnessOf(age, TOLERANCE_DAYS[o.bundle]),
    period: null,
  };
}

/** Assemble a leg envelope from whatever the query produced. */
function leg(
  bundle: LegKey,
  status: LegStatus,
  reason: LegReason,
  evidence: Evidence[],
  notes: string[],
  unavailable: string[],
  queryMs: number,
): EvidenceLeg {
  const dated = evidence
    .map((e) => (e.kind === "unbound" || e.kind === "fact" ? e.as_of : e.as_of))
    .filter((d): d is string => typeof d === "string")
    .sort();
  return {
    bundle,
    status,
    reason,
    evidence,
    notes,
    unavailable_fields: unavailable,
    tolerance_days: TOLERANCE_DAYS[bundle],
    newest_as_of: dated.length > 0 ? dated[dated.length - 1]! : null,
    query_ms: Math.max(0, Math.round(queryMs)),
  };
}

export interface LegContext {
  sql: Sql;
  securityId: number;
  now: Date;
  /** From `ops.materiality_prefilter.citable_states`, per object_type. Fail closed on absence. */
  citableStates: Record<string, string[]>;
  seq: () => string;
}

const statesFor = (ctx: LegContext, t: string): string[] => ctx.citableStates[t] ?? ["VERIFIED"];

/** The live object of a given type for this security, newest first. */
async function liveObjects(ctx: LegContext, objectType: string, limit: number): Promise<ObjRow[]> {
  return (await ctx.sql`
    select id::text as id, object_type, natural_key, revision, state::text as state,
           payload, unit, effective_date::text as effective_date,
           updated_at::text as updated_at, source_rank
      from lake.objects
     where security_id = ${ctx.securityId}
       and object_type = ${objectType}
       and superseded_by is null
     order by effective_date desc nulls last, updated_at desc
     limit ${limit}
  `) as unknown as ObjRow[];
}

/** Every ratio key worth citing, in the order a desk would reach for them. */
const RATIO_FIELDS: Array<[field: string, label: string]> = [
  ["payload.pe", "P/E"],
  ["payload.pb", "P/B"],
  ["payload.ps", "P/S"],
  ["payload.ev_ebitda", "EV/EBITDA"],
  ["payload.roe", "Return on equity"],
  ["payload.roce", "Return on capital employed"],
  ["payload.nim", "Net interest margin"],
  ["payload.net_margin", "Net margin"],
  ["payload.gross_margin", "Gross margin"],
  ["payload.dividend_yield", "Dividend yield"],
  ["payload.payout_ratio", "Payout ratio"],
  ["payload.market_cap", "Market capitalisation"],
  ["payload.eps_ttm", "EPS (TTM)"],
  ["payload.book_value_ps", "Book value per share"],
  ["payload.rev_growth_yoy", "Revenue growth, y/y"],
  ["payload.eps_growth_yoy", "EPS growth, y/y"],
  ["payload.rev_cagr_3y", "Revenue CAGR, 3y"],
  ["payload.eps_cagr_3y", "EPS CAGR, 3y"],
  ["payload.ret_3m", "Return, 3m"],
  ["payload.ret_6m", "Return, 6m"],
  ["payload.ret_12_1", "Return, 12m-1m"],
];

/** EB-RATIOS — what is it worth, bound to the lake rather than to the projection. */
export async function legRatios(ctx: LegContext): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = await liveObjects(ctx, "COMPUTED.RATIOS", 1);
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-RATIOS", "empty", "no_rows_for_security", [], [
      "No live COMPUTED.RATIOS object for this security. The ratios producer runs nightly; a gap means it has not covered this name yet.",
    ], [], ms);
  }

  const row = rows[0]!;
  const states = statesFor(ctx, "COMPUTED.RATIOS");
  const facts: Evidence[] = [];
  const missing: string[] = [];
  for (const [field, label] of RATIO_FIELDS) {
    const f = buildFact({
      bundle: "EB-RATIOS", row, field, label,
      metricKey: field.replace("payload.", ""),
      now: ctx.now, citableStates: states, seq: ctx.seq,
    });
    if (f) facts.push(f);
    else missing.push(field.replace("payload.", ""));
  }

  const notes: string[] = [];
  if (missing.length > 0) {
    // Reported, not silently dropped: a writer that does not know a ratio is unavailable will
    // reach for a substitute and call it the same thing.
    notes.push(`Not computed for this security: ${missing.join(", ")}.`);
  }
  return leg(
    "EB-RATIOS",
    facts.length > 0 ? "present" : "empty",
    facts.length > 0 ? "ok" : "no_rows_for_security",
    facts, notes, missing, ms,
  );
}

const SCORE_FIELDS: Array<[field: string, label: string]> = [
  ["payload.score", "Marsad score"],
  ["payload.rating", "Rating"],
  ["payload.sector_percentile", "Sector percentile"],
  ["payload.sector_peer_count", "Sector peer count"],
];

/** EB-SCORE — how it grades, plus the cohort the score was computed against. */
export async function legScore(ctx: LegContext): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = await liveObjects(ctx, "COMPUTED.SCORE", 1);
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-SCORE", "empty", "no_rows_for_security", [], [
      "No live COMPUTED.SCORE object. 540 of 762 listed securities are scored; this one is not.",
    ], [], ms);
  }

  const row = rows[0]!;
  const states = statesFor(ctx, "COMPUTED.SCORE");
  const facts: Evidence[] = [];
  for (const [field, label] of SCORE_FIELDS) {
    const f = buildFact({
      bundle: "EB-SCORE", row, field, label,
      metricKey: field.replace("payload.", ""),
      now: ctx.now, citableStates: states, seq: ctx.seq,
    });
    if (f) facts.push(f);
  }

  const notes: string[] = [];
  // thin_cohort is the scorer's own admission that the percentile is weakly supported. Carrying it
  // forward is the difference between "ranked 3rd of 40" and "ranked 3rd of 4".
  if (row.payload?.["thin_cohort"] === true) {
    notes.push("The scorer flagged this cohort as THIN — the sector percentile is weakly supported and should not be quoted as a rank.");
  }
  return leg("EB-SCORE", facts.length > 0 ? "present" : "empty", facts.length > 0 ? "ok" : "no_rows_for_security", facts, notes, [], ms);
}

/** EB-IDENTITY — who this is. One bindable fact; the rest is identity, not evidence. */
export async function legIdentity(ctx: LegContext): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = await liveObjects(ctx, "PROFILE.SECURITY", 1);
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-IDENTITY", "empty", "no_rows_for_security", [], [
      "No PROFILE.SECURITY object — shares outstanding is unavailable, so any per-share derivation is unsupported.",
    ], ["sharesOutstanding"], ms);
  }
  const row = rows[0]!;
  const f = buildFact({
    bundle: "EB-IDENTITY", row, field: "payload.sharesOutstanding",
    label: "Shares outstanding", metricKey: "sharesOutstanding",
    now: ctx.now, citableStates: statesFor(ctx, "PROFILE.SECURITY"), seq: ctx.seq,
  });
  return leg(
    "EB-IDENTITY",
    f ? "present" : "empty",
    f ? "ok" : "no_rows_for_security",
    f ? [f] : [],
    f ? [] : ["Shares outstanding is not populated on the profile object."],
    f ? [] : ["sharesOutstanding"],
    ms,
  );
}

/**
 * EB-CALENDAR — what is scheduled.
 *
 * This leg exists to report an ABSENCE honestly, and it is the clearest case in the inventory:
 * `public.dividends` holds 1,233 rows with `ex_date` null on **every one**, and
 * `earnings_events.eps_consensus` is null on all 9,188. So the producer exists but is dark.
 *
 * The distinction matters to a writer. `empty` licenses "the company has not declared a dividend";
 * `absent` licenses nothing at all — writing "no consensus estimate is available" would imply we
 * consulted a consensus feed, and there is none. Decided from a producer probe rather than from a
 * fixture, so the verdict tracks the world on the day a producer lands.
 */
export async function legCalendar(ctx: LegContext): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const probe = (await ctx.sql`
    select
      (select count(*) from public.dividends where ex_date is not null)::int as div_dated,
      (select count(*) from public.earnings_events where eps_consensus is not null)::int as ee_consensus
  `) as unknown as Array<{ div_dated: number; ee_consensus: number }>;
  const ms = Date.now() - t0;
  const p = probe[0] ?? { div_dated: 0, ee_consensus: 0 };

  const notes: string[] = [];
  const unavailable: string[] = [];
  if (p.div_dated === 0) {
    notes.push("No dividend in the database carries an ex-date — the producer is dark, not merely empty for this security. Do not write that this company has no dividend scheduled.");
    unavailable.push("ex_date", "pay_date", "dps");
  }
  if (p.ee_consensus === 0) {
    notes.push("No earnings event carries a consensus estimate. There is no consensus feed — do not write that an estimate is unavailable, which would imply one was consulted.");
    unavailable.push("eps_consensus", "surprise_pct");
  }
  const dark = p.div_dated === 0 && p.ee_consensus === 0;
  return leg("EB-CALENDAR", dark ? "absent" : "empty", dark ? "producer_dark" : "no_rows_for_security", [], notes, unavailable, ms);
}

/** The line items a desk reaches for first, by statement type. Others are reachable but unranked. */
const HEADLINE_LINES: Record<string, string[]> = {
  income: ["revenue", "gross_profit", "operating_income", "net_income", "eps", "net_interest_income"],
  balance: ["total_assets", "total_equity", "total_liabilities", "cash_and_equivalents", "total_debt"],
  cashflow: ["cash_from_operations", "capex", "free_cash_flow", "dividends_paid"],
};

interface StmtRow {
  statement_type: string;
  basis: string;
  period_kind: string;
  fiscal_period: string;
  period_end: string;
  currency: string | null;
  is_restated: boolean;
  line_items: Record<string, unknown> | null;
  source_object_id: string | null;
  obj_id: string | null;
  obj_state: string | null;
  obj_type: string | null;
  natural_key: string | null;
  revision: number | null;
  obj_payload: Record<string, unknown> | null;
  obj_updated_at: string | null;
  source_rank: number | null;
}

/**
 * EB-STATEMENTS — what it reported.
 *
 * The only leg where the projection and the lake agree completely: measured 2026-07-27,
 * `public.financial_statements` holds 52,290 rows and **52,290 carry `source_object_id`** — 100%
 * bindable. So this joins the projection (which is indexed and readable) to the object (which is
 * what a citation must name), and every emitted fact binds to the object.
 *
 * `is_restated` rides along because a restated period is a different claim about the same quarter,
 * and a writer comparing periods without knowing one was restated will describe a revision as a
 * result.
 */
export async function legStatements(ctx: LegContext, periods = 6): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = (await ctx.sql`
    select fs.statement_type, fs.basis, fs.period_kind, fs.fiscal_period,
           fs.period_end::text as period_end, fs.currency, fs.is_restated, fs.line_items,
           fs.source_object_id::text as source_object_id,
           o.id::text as obj_id, o.state::text as obj_state, o.object_type as obj_type,
           o.natural_key, o.revision, o.payload as obj_payload,
           o.updated_at::text as obj_updated_at, o.source_rank
      from public.financial_statements fs
      left join lake.objects o
             on o.id = fs.source_object_id and o.superseded_by is null
     where fs.security_id = ${ctx.securityId}
       and fs.is_estimate = false
       and fs.statement_type in ('income','balance','cashflow')
     order by fs.period_end desc, fs.statement_type
     limit ${periods * 3}
  `) as unknown as StmtRow[];
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-STATEMENTS", "empty", "no_rows_for_security", [], [
      "No non-estimate income, balance or cash-flow statement on file for this security.",
    ], [], ms);
  }

  const states = statesFor(ctx, "FILING.FINANCIALS");
  const facts: Evidence[] = [];
  const notes: string[] = [];
  let unbindable = 0;

  for (const r of rows) {
    if (!r.obj_id || !r.obj_state || !r.obj_type) {
      // The projection row exists but its object does not resolve live — a superseded or deleted
      // object. Counted and reported rather than silently skipped.
      unbindable += 1;
      continue;
    }
    const objRow: ObjRow = {
      id: r.obj_id,
      object_type: r.obj_type,
      natural_key: r.natural_key ?? "",
      revision: r.revision ?? 1,
      state: r.obj_state,
      payload: r.obj_payload,
      unit: null,
      effective_date: null,
      updated_at: isoOrEpoch(r.obj_updated_at),
      source_rank: r.source_rank,
    };
    const wanted = HEADLINE_LINES[r.statement_type] ?? [];
    for (const key of wanted) {
      const f = buildFact({
        bundle: "EB-STATEMENTS", row: objRow,
        field: `payload.line_items.${key}`,
        label: `${key.replace(/_/g, " ")} · ${r.fiscal_period}`,
        metricKey: key,
        now: ctx.now, citableStates: states, seq: ctx.seq,
      });
      if (!f || f.kind !== "fact") continue;
      facts.push({
        ...f,
        period: {
          statement_type: r.statement_type as "income" | "balance" | "cashflow" | "oci" | "equity_change",
          basis: (r.basis === "standalone" ? "standalone" : "consolidated") as "consolidated" | "standalone",
          period_kind: (r.period_kind === "annual" ? "annual" : r.period_kind === "ttm" ? "ttm" : "quarter") as
            "quarter" | "annual" | "ttm",
          fiscal_period: r.fiscal_period,
          period_end: r.period_end,
          is_restated: r.is_restated === true,
        },
        as_of: r.period_end,
      });
    }
  }

  if (unbindable > 0) {
    notes.push(`${unbindable} statement rows reference an object that no longer resolves live — their figures are readable but NOT citable.`);
  }
  const restated = rows.filter((r) => r.is_restated).length;
  if (restated > 0) {
    notes.push(`${restated} of the periods returned are RESTATED. A restated period is a different claim about the same quarter — do not describe a revision as a result.`);
  }

  return leg(
    "EB-STATEMENTS",
    facts.length > 0 ? "present" : unbindable > 0 ? "unbindable" : "empty",
    facts.length > 0 ? "ok" : unbindable > 0 ? "no_lake_object" : "no_rows_for_security",
    facts, notes, [], ms,
  );
}

interface PeerRow {
  id: number;
  ticker: string;
  name_en: string;
  venue_code: string;
  sector: string | null;
}

/**
 * EB-PEERS — who it sits against.
 *
 * The rung that is available depends on the security, and the ladder degrades deliberately rather
 * than failing:
 *
 *   1. **Same sector, same market.** The real cohort. Sector coverage was 275 of 762 in July and is
 *      now far better after the classification work (#94/#95), but `unknown` still exists.
 *   2. **Same venue.** Weaker — a venue is not an industry — but it is at least the same market,
 *      currency and disclosure regime.
 *   3. **Refuse.** Below MIN_COHORT a comparison is not evidence, it is an anecdote. The leg
 *      returns `refused` rather than a two-name "peer set" a writer would treat as a ranking.
 *
 * `cohort_method` is reported in the notes so a sector-shaped claim is at least honest about its
 * basis — the difference between "cheapest of its sector" and "cheapest of the four names we could
 * group it with".
 */
const MIN_COHORT = 4;

export async function legPeers(ctx: LegContext, limit = 12): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const subject = (await ctx.sql`
    select sector, venue_code from public.securities where id = ${ctx.securityId}
  `) as unknown as Array<{ sector: string | null; venue_code: string }>;
  const subj = subject[0];
  if (!subj) {
    return leg("EB-PEERS", "refused", "no_rows_for_security", [], ["The subject security does not exist."], [], Date.now() - t0);
  }

  const sectored = subj.sector && subj.sector !== "unknown";
  let method = sectored ? "sector+venue" : "venue";
  let peers = (await ctx.sql`
    select id, ticker, name_en, venue_code, sector
      from public.securities
     where status = 'listed'
       and id <> ${ctx.securityId}
       and venue_code = ${subj.venue_code}
       ${sectored ? ctx.sql`and sector = ${subj.sector}` : ctx.sql``}
     order by ticker
     limit ${limit}
  `) as unknown as PeerRow[];

  // Rung 2 — a sectored subject whose sector cohort is too thin falls back to its venue.
  if (sectored && peers.length < MIN_COHORT) {
    method = "venue (sector cohort too thin)";
    peers = (await ctx.sql`
      select id, ticker, name_en, venue_code, sector
        from public.securities
       where status = 'listed' and id <> ${ctx.securityId} and venue_code = ${subj.venue_code}
       order by ticker limit ${limit}
    `) as unknown as PeerRow[];
  }
  const ms = Date.now() - t0;

  if (peers.length < MIN_COHORT) {
    return leg("EB-PEERS", "refused", "cohort_thin", [], [
      `Only ${peers.length} comparable securities found (minimum ${MIN_COHORT}). A cohort this small is an anecdote, not a ranking — no comparative claim is supported.`,
    ], [], ms);
  }

  const notes = [
    `Cohort built by ${method}: ${peers.length} names. Any comparative claim must be scoped to this basis, not to "the sector" in general.`,
  ];
  if (!sectored) {
    notes.push("The subject has no classified sector, so this cohort is same-market rather than same-industry — a venue is not an industry.");
  }

  // The peers' own bound facts are fetched by the caller per security; this leg reports the cohort
  // itself, which is what makes a comparison legible. Returning ids without values keeps one query.
  return leg("EB-PEERS", "present", "ok", [], [
    ...notes,
    `Cohort: ${peers.map((p) => `${p.venue_code}:${p.ticker}`).join(", ")}.`,
  ], [], ms);
}

/**
 * Build one UnboundFact — real, readable, and NOT bindable.
 *
 * The shape has no `binding` key at all, so a composer physically cannot emit a D-8 binding from
 * it, and `prose_legal: false` says the rest: an unbound figure may not be quoted as a numeral in
 * prose either, because the fit stage's numeric pass would have nothing to check it against and
 * R-04 would refuse the piece. It is context for the researcher, not material for the writer.
 */
function buildUnbound(o: {
  bundle: LegKey;
  reason: "no_lake_object" | "no_security_link" | "projection_only";
  table: string;
  rowRef: string | number;
  label: string;
  metricKey: string;
  value: string | number | boolean | null;
  asOf: string | null;
  observedAt: string;
  now: Date;
  seq: () => string;
}): Evidence {
  const age = ageDays(o.asOf, o.now);
  return {
    kind: "unbound",
    fact_id: o.seq().replace(/^f/, "u"),
    bundle: o.bundle,
    unbindable_reason: o.reason,
    prose_legal: false,
    provenance: { table: o.table, row_ref: String(o.rowRef) },
    label: o.label,
    metric_key: o.metricKey,
    value: o.value,
    format: { value_kind: "string", multiplier: 1, unit: null, currency: null, scale: "unit", decimals: 0 },
    as_of: o.asOf,
    observed_at: o.observedAt,
    input_as_of: null,
    age_days: age,
    freshness: freshnessOf(age, TOLERANCE_DAYS[o.bundle]),
    period: null,
  };
}

interface PairRow {
  statement_type: string;
  basis: string;
  period_kind: string;
  fiscal_period: string;
  period_end: string;
  is_restated: boolean;
  obj_id: string | null;
  obj_state: string | null;
  obj_type: string | null;
  natural_key: string | null;
  revision: number | null;
  obj_payload: Record<string, unknown> | null;
  obj_updated_at: string | null;
  source_rank: number | null;
}

/**
 * EB-PERIODPAIR — how this print compares with the one before it.
 *
 * ── THE RULE THAT SHAPES THIS LEG ───────────────────────────────────────────────────────────────
 * It emits BOTH periods as bound facts and **never a delta**. No lake object holds "revenue grew
 * 11.2%", so a delta cannot be bound, and an unbound numeral in prose is refused by R-04 —
 * correctly. Handing a writer a computed delta would therefore be handing it something that
 * guarantees a refusal, or worse, something it prints without a citation.
 *
 * Where a bound equivalent DOES exist the writer should use it: `COMPUTED.RATIOS` carries
 * rev_growth_yoy, eps_growth_yoy and the 3-year CAGRs as real objects, and EB-RATIOS already emits
 * them. The note says so, because the difference between "compute it" and "cite the one that
 * exists" is invisible from the payload.
 *
 * Restatement matters here more than anywhere: 13,181 of 52,415 statements are restated (25%), so
 * a naive period pair has a one-in-four chance of comparing a revision with a result.
 */
export async function legPeriodPair(ctx: LegContext): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = (await ctx.sql`
    select fs.statement_type, fs.basis, fs.period_kind, fs.fiscal_period,
           fs.period_end::text as period_end, fs.is_restated,
           o.id::text as obj_id, o.state::text as obj_state, o.object_type as obj_type,
           o.natural_key, o.revision, o.payload as obj_payload,
           o.updated_at::text as obj_updated_at, o.source_rank
      from public.financial_statements fs
      left join lake.objects o on o.id = fs.source_object_id and o.superseded_by is null
     where fs.security_id = ${ctx.securityId}
       and fs.is_estimate = false
       and fs.statement_type = 'income'
     order by fs.period_end desc
     limit 8
  `) as unknown as PairRow[];
  const ms = Date.now() - t0;

  if (rows.length < 2) {
    return leg("EB-PERIODPAIR", "empty", "no_rows_for_security", [], [
      "Fewer than two income statements on file — there is no prior period to compare against.",
    ], [], ms);
  }

  // Pair like with like: the same period_kind and basis, or the comparison is meaningless.
  const current = rows[0]!;
  const prior = rows.slice(1).find(
    (r) => r.period_kind === current.period_kind && r.basis === current.basis,
  );
  if (!prior) {
    return leg("EB-PERIODPAIR", "empty", "period_not_current", [], [
      `No prior ${current.period_kind} on the same (${current.basis}) basis — a quarter compared with an annual is not a comparison.`,
    ], [], ms);
  }

  const states = statesFor(ctx, "FILING.FINANCIALS");
  const facts: Evidence[] = [];
  const notes: string[] = [];

  for (const [r, which] of [[current, "current"], [prior, "prior"]] as const) {
    if (!r.obj_id || !r.obj_state || !r.obj_type) {
      notes.push(`The ${which} period (${r.fiscal_period}) has no live lake object — it is readable but not citable.`);
      continue;
    }
    const objRow: ObjRow = {
      id: r.obj_id, object_type: r.obj_type, natural_key: r.natural_key ?? "",
      revision: r.revision ?? 1, state: r.obj_state, payload: r.obj_payload,
      unit: null, effective_date: null,
      updated_at: isoOrEpoch(r.obj_updated_at), source_rank: r.source_rank,
    };
    for (const key of HEADLINE_LINES.income ?? []) {
      const f = buildFact({
        bundle: "EB-PERIODPAIR", row: objRow, field: `payload.line_items.${key}`,
        label: `${key.replace(/_/g, " ")} · ${r.fiscal_period}`,
        metricKey: `${which}.${key}`,
        now: ctx.now, citableStates: states, seq: ctx.seq,
      });
      if (f && f.kind === "fact") {
        facts.push({
          ...f,
          as_of: r.period_end,
          period: {
            statement_type: "income",
            basis: (r.basis === "standalone" ? "standalone" : "consolidated") as "consolidated" | "standalone",
            period_kind: (r.period_kind === "annual" ? "annual" : r.period_kind === "ttm" ? "ttm" : "quarter") as
              "quarter" | "annual" | "ttm",
            fiscal_period: r.fiscal_period,
            period_end: r.period_end,
            is_restated: r.is_restated === true,
          },
        });
      }
    }
  }

  notes.push(
    `Pairing ${current.fiscal_period} against ${prior.fiscal_period}. BOTH are emitted as bound facts and NO delta is computed — no lake object holds a growth figure, so a computed delta could not be cited and R-04 would refuse it. Where a bound growth figure exists, EB-RATIOS already carries it (rev_growth_yoy, eps_growth_yoy, rev_cagr_3y, eps_cagr_3y): cite that instead of deriving one.`,
  );
  if (current.is_restated || prior.is_restated) {
    const which = [current.is_restated ? current.fiscal_period : null, prior.is_restated ? prior.fiscal_period : null]
      .filter(Boolean).join(" and ");
    notes.push(`RESTATED: ${which}. A restated period is a revision of the same quarter, not a result — describing the change as performance would be wrong.`);
  }

  return leg(
    "EB-PERIODPAIR",
    facts.length > 0 ? "present" : "unbindable",
    facts.length > 0 ? "ok" : "no_lake_object",
    facts, notes, ["growth_pct", "delta"], ms,
  );
}

/**
 * EB-PRICE — what the stock has done.
 *
 * `OHLCV.CLOSE` is the one family that populates `effective_date` on every row (640,992 of
 * 640,992), so it is the only leg where staleness is computed from the column rather than from a
 * payload period. It is also fully bindable: every bar is its own object.
 *
 * Returns the window plus NAMED ANCHORS — first, last, high, low — because those are the four
 * points a piece actually quotes, and naming them here means the writer cites the anchor object
 * rather than scanning a series and picking a number itself.
 */
export async function legPrice(ctx: LegContext, days = 90): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = await liveObjects(ctx, "OHLCV.CLOSE", days);
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-PRICE", "empty", "no_rows_for_security", [], [
      "No OHLCV.CLOSE objects for this security — no price history is bindable.",
    ], [], ms);
  }

  const states = statesFor(ctx, "OHLCV.CLOSE");
  const withVal = rows
    .map((r) => ({ row: r, close: Number(readField(r, "payload.close")) }))
    .filter((x) => Number.isFinite(x.close));

  if (withVal.length === 0) {
    return leg("EB-PRICE", "empty", "no_rows_for_security", [], [
      `${rows.length} price objects returned but none carries a close — the series is unusable.`,
    ], [], ms);
  }

  // liveObjects returns newest first.
  const latest = withVal[0]!;
  const earliest = withVal[withVal.length - 1]!;
  const high = withVal.reduce((a, b) => (b.close > a.close ? b : a));
  const low = withVal.reduce((a, b) => (b.close < a.close ? b : a));

  const anchors: Array<[typeof latest, string, string]> = [
    [latest, "Latest close", "close.latest"],
    [earliest, `Close, ${days}d ago`, "close.window_start"],
    [high, `High, ${days}d`, "close.high"],
    [low, `Low, ${days}d`, "close.low"],
  ];

  const facts: Evidence[] = [];
  const seen = new Set<string>();
  for (const [a, label, metric] of anchors) {
    // The same bar can be two anchors (latest and high). Emit it once, under the first name, so a
    // citation count is not inflated by a duplicate binding to one object.
    const key = `${a.row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const f = buildFact({
      bundle: "EB-PRICE", row: a.row, field: "payload.close",
      label, metricKey: metric, now: ctx.now, citableStates: states, seq: ctx.seq,
    });
    if (f) facts.push(f);
  }

  const notes = [
    `${withVal.length} sessions in the window. Only the four anchors are emitted as facts — a writer quoting an arbitrary mid-series bar should bind that bar, not describe the shape of the series from prose.`,
  ];
  if (withVal.length < days / 2) {
    notes.push(`The window is sparse: ${withVal.length} sessions against a ${days}-day request. Treat any "over the last quarter" claim with care.`);
  }

  return leg("EB-PRICE", facts.length > 0 ? "present" : "empty", facts.length > 0 ? "ok" : "no_rows_for_security", facts, notes, [], ms);
}

interface QuoteRow {
  id: string;
  object_type: string;
  natural_key: string;
  revision: number;
  state: string;
  payload: Record<string, unknown> | null;
  unit: string | null;
  effective_date: string | null;
  updated_at: string;
  source_rank: number | null;
}

const QUOTE_FIELDS: Array<[string, string]> = [
  ["payload.last", "Last"],
  ["payload.changePct", "Change"],
  ["payload.open", "Open"],
  ["payload.high", "Session high"],
  ["payload.low", "Session low"],
  ["payload.week52High", "52-week high"],
  ["payload.week52Low", "52-week low"],
  ["payload.volume", "Volume"],
];

/**
 * EB-QUOTE — where it is now.
 *
 * ── THE JOIN THAT CANNOT BE NAIVE ───────────────────────────────────────────────────────────────
 * `QUOTE.LAST` carries `security_id` on 19,437 of 34,383 live rows — **56.5%**. So
 * `where security_id = $1` silently returns nothing for over four in ten securities, and the leg
 * would report `empty` when the quote exists. That is the failure this codebase keeps meeting: an
 * absence that is really a broken join.
 *
 * The fallback matches on the natural key's venue and ticker, which every row carries. It is
 * looser, so it is REPORTED — a brief that fell back says so, because a quote matched by ticker
 * rather than by id is a slightly weaker claim about identity.
 */
export async function legQuote(ctx: LegContext, venueCode?: string | null, ticker?: string | null): Promise<EvidenceLeg> {
  const t0 = Date.now();
  let matchedBy = "security_id";
  let rows = await liveObjects(ctx, "QUOTE.LAST", 1);

  if (rows.length === 0 && venueCode && ticker) {
    matchedBy = "venue+ticker (security_id is null on 43% of QUOTE.LAST rows)";
    rows = (await ctx.sql`
      select id::text as id, object_type, natural_key, revision, state::text as state,
             payload, unit, effective_date::text as effective_date,
             updated_at::text as updated_at, source_rank
        from lake.objects
       where object_type = 'QUOTE.LAST'
         and superseded_by is null
         and natural_key like ${`QUOTE.LAST:${venueCode}:${ticker}:%`}
       order by effective_date desc nulls last, updated_at desc
       limit 1
    `) as unknown as QuoteRow[];
  }
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-QUOTE", "empty", "no_rows_for_security", [], [
      venueCode && ticker
        ? "No live QUOTE.LAST object by id or by venue+ticker."
        : "No live QUOTE.LAST object by security_id, and no venue/ticker was supplied to try the fallback join.",
    ], [], ms);
  }

  const row = rows[0]!;
  const states = statesFor(ctx, "QUOTE.LAST");
  const facts: Evidence[] = [];
  for (const [field, label] of QUOTE_FIELDS) {
    const f = buildFact({
      bundle: "EB-QUOTE", row, field, label,
      metricKey: field.replace("payload.", ""),
      now: ctx.now, citableStates: states, seq: ctx.seq,
    });
    if (f) facts.push(f);
  }

  const notes = [`Quote matched by ${matchedBy}.`];
  // A quote is the one perishable family. Age is the whole story, and QUOTE.LAST is VERIFIED on
  // only 264 rows — so most quotes are bindable only if config says PENDING is citable.
  const age = ageDays(row.effective_date, ctx.now);
  if (age !== null && age > 1) {
    notes.push(`This quote is ${age} days old. It is a DELAYED price at best; do not describe it as the current level.`);
  }

  return leg(
    "EB-QUOTE",
    facts.length > 0 ? (age !== null && age > (TOLERANCE_DAYS["EB-QUOTE"] ?? 2) ? "stale" : "present") : "empty",
    facts.length > 0 ? "ok" : "no_rows_for_security",
    facts, notes, [], ms,
  );
}

interface FilingRow {
  id: number;
  title: string | null;
  form_code: string | null;
  filing_type: string | null;
  filed_at: string | null;
  is_market_moving: boolean | null;
  has_text: boolean;
  text_chars: number | null;
  ai_summary: string | null;
  created_at: string;
}

/**
 * EB-FILINGS — what it said.
 *
 * ── STRUCTURALLY UNBINDABLE, AND THAT IS THE POINT ──────────────────────────────────────────────
 * `public.filings` has no `source_object_id` column, and `FILING.REF` carries `security_id` on
 * **0 of 669** rows — by design, because a filing list is a venue-level announcement stream rather
 * than a per-security fact. So there is no join from a security to a citable filing object.
 *
 * That makes filings evidence a researcher READS, never data a writer BINDS. Every row here is an
 * `UnboundFact`: the shape has no `binding` key, so a composer cannot emit a D-8 binding from one
 * even by accident, and `prose_legal: false` stops the figures inside being quoted as numerals.
 *
 * What the leg reports instead is READABILITY — whether the document has `full_text` at all. Only
 * about 40% of the corpus does, and a researcher told "there are 8 filings" without being told 5 of
 * them are unread will assume it has seen them.
 */
export async function legFilings(ctx: LegContext, limit = 8): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = (await ctx.sql`
    select f.id, f.title, f.form_code, f.filing_type, f.filed_at::text as filed_at,
           f.is_market_moving,
           (f.full_text is not null) as has_text,
           length(f.full_text) as text_chars,
           f.ai_summary,
           f.created_at::text as created_at
      from public.filings f
     where f.security_id = ${ctx.securityId}
     order by f.filed_at desc nulls last, f.id desc
     limit ${limit}
  `) as unknown as FilingRow[];
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-FILINGS", "empty", "no_rows_for_security", [], [
      "No filings on record for this security.",
    ], [], ms);
  }

  const evidence: Evidence[] = rows.map((r) =>
    buildUnbound({
      bundle: "EB-FILINGS",
      reason: "no_lake_object",
      table: "public.filings",
      rowRef: r.id,
      label: r.title ?? r.form_code ?? `Filing ${r.id}`,
      metricKey: r.form_code ?? r.filing_type ?? "filing",
      value: r.filed_at,
      asOf: r.filed_at,
      observedAt: isoOrEpoch(r.created_at),
      now: ctx.now,
      seq: ctx.seq,
    }),
  );

  const unread = rows.filter((r) => !r.has_text).length;
  const moving = rows.filter((r) => r.is_market_moving).length;
  const notes = [
    "Filings are UNBINDABLE by construction: public.filings has no source_object_id and FILING.REF carries security_id on 0 of 669 rows. Read them; do not cite a figure to one. A number taken from a filing must be cited to the FILING.FINANCIALS object that extraction produced (EB-STATEMENTS).",
  ];
  if (unread > 0) {
    notes.push(`${unread} of ${rows.length} have NO extracted text — they are titles only. Do not summarise a document that has not been read.`);
  }
  if (moving > 0) notes.push(`${moving} are flagged market-moving.`);

  return leg("EB-FILINGS", "unbindable", "no_lake_object", evidence, notes, ["source_object_id"], ms);
}

interface RevisionRow {
  fiscal_period: string;
  statement_type: string;
  period_end: string;
  is_restated: boolean;
  version: number | null;
  updated_at: string;
}

/**
 * EB-REVISIONS — what changed, and was it corrected.
 *
 * ── WHY THIS LEG IS NOT OPTIONAL ────────────────────────────────────────────────────────────────
 * It is the only source of `RuleContext.open_correction`, which is what blocks auto-publish under
 * R-07. Dropping it does not merely lose a nicety — it silently removes the restatement guard, so a
 * wire could auto-publish a figure the issuer has already revised.
 *
 * ⚠️ My own spec named `public.financial_statement_history` as a source. **That table does not
 * exist** — checked before writing this. So revisions are detected from what does: the `is_restated`
 * flag and `version` on `public.financial_statements`, plus the lake's supersede chain.
 *
 * Measured: 13,181 of 52,415 statements are restated — **one in four**. This is not a rare edge.
 */
export async function legRevisions(ctx: LegContext, limit = 8): Promise<EvidenceLeg> {
  const t0 = Date.now();
  const rows = (await ctx.sql`
    select fs.fiscal_period, fs.statement_type, fs.period_end::text as period_end,
           fs.is_restated, fs.version, fs.updated_at::text as updated_at
      from public.financial_statements fs
     where fs.security_id = ${ctx.securityId}
       and (fs.is_restated = true or fs.version > 1)
     order by fs.updated_at desc
     limit ${limit}
  `) as unknown as RevisionRow[];

  const superseded = (await ctx.sql`
    select count(*)::int as n
      from lake.objects
     where security_id = ${ctx.securityId}
       and object_type = 'FILING.FINANCIALS'
       and superseded_by is not null
  `) as unknown as Array<{ n: number }>;
  const ms = Date.now() - t0;

  const supersededCount = superseded[0]?.n ?? 0;

  if (rows.length === 0 && supersededCount === 0) {
    return leg("EB-REVISIONS", "empty", "no_rows_for_security", [], [
      "No restated periods and no superseded financial objects for this security — nothing has been revised.",
    ], [], ms);
  }

  const evidence: Evidence[] = rows.map((r) =>
    buildUnbound({
      bundle: "EB-REVISIONS",
      reason: "projection_only",
      table: "public.financial_statements",
      rowRef: `${r.statement_type}:${r.fiscal_period}`,
      label: `${r.fiscal_period} ${r.statement_type} · restated`,
      metricKey: "restatement",
      value: `v${r.version ?? 1}`,
      asOf: r.period_end,
      observedAt: isoOrEpoch(r.updated_at),
      now: ctx.now,
      seq: ctx.seq,
    }),
  );

  const notes = [
    `${rows.length} restated or re-versioned periods, and ${supersededCount} superseded FILING.FINANCIALS objects.`,
    "A restated period is a revision of the same quarter, NOT a result. Comparing a restated figure with an original and calling the difference performance is the specific error this leg exists to prevent.",
  ];
  // R-07's input. Said explicitly so the flag is not inferred from a count somewhere downstream.
  if (rows.length > 0) {
    notes.push("OPEN CORRECTION present — R-07 blocks auto-publish for this security until a human clears it.");
  }

  return leg("EB-REVISIONS", "unbindable", "projection_only", evidence, notes, [], ms);
}

interface VenueStateRow {
  venue_code: string;
  state: string | null;
  detail: string | null;
  last_sync_at: string | null;
  latency_ms: number | null;
}

/**
 * EB-VENUESTATE — is the market live.
 *
 * Reads `public.venue_feed_status`, which is real and populated. But there is **no `MARKET.STATUS`
 * object family**, so nothing here can be bound — and that has a consequence worth stating plainly:
 * `BLK-FRESH` is mandatory on any live figure and binds a `market.status` ObjectRef, so strictly,
 * every piece quoting a live price is unpublishable until that family is minted.
 *
 * Reported as an unbound fact rather than omitted, so a researcher knows the venue state exists and
 * is simply not citable yet.
 */
export async function legVenueState(ctx: LegContext, venueCode?: string | null): Promise<EvidenceLeg> {
  const t0 = Date.now();
  if (!venueCode) {
    return leg("EB-VENUESTATE", "empty", "no_rows_for_security", [], [
      "No venue supplied, so feed state could not be read.",
    ], ["market_status"], Date.now() - t0);
  }

  const rows = (await ctx.sql`
    select venue_code, state, detail, last_sync_at::text as last_sync_at, latency_ms
      from public.venue_feed_status where venue_code = ${venueCode} limit 1
  `) as unknown as VenueStateRow[];
  const ms = Date.now() - t0;

  if (rows.length === 0) {
    return leg("EB-VENUESTATE", "empty", "no_rows_for_security", [], [
      `No feed-status row for ${venueCode}.`,
    ], ["market_status"], ms);
  }

  const r = rows[0]!;
  const evidence: Evidence[] = [
    buildUnbound({
      bundle: "EB-VENUESTATE",
      reason: "no_lake_object",
      table: "public.venue_feed_status",
      rowRef: r.venue_code,
      label: `${r.venue_code} feed state`,
      metricKey: "venue_state",
      value: r.state,
      asOf: r.last_sync_at ? r.last_sync_at.slice(0, 10) : null,
      observedAt: r.last_sync_at ? isoOrEpoch(r.last_sync_at) : ctx.now.toISOString(),
      now: ctx.now,
      seq: ctx.seq,
    }),
  ];

  const notes = [
    "Venue state is readable but NOT bindable: no MARKET.STATUS object family exists. BLK-FRESH binds a market.status ObjectRef and is mandatory on any live figure, so a piece quoting a live price cannot satisfy it until that family is minted.",
  ];
  if (r.state && r.state.toLowerCase() !== "ok" && r.state.toLowerCase() !== "live") {
    notes.push(`The ${r.venue_code} feed is '${r.state}'${r.detail ? ` — ${r.detail}` : ""}. Any live figure from this venue is degraded and must be named as such, not footnoted.`);
  }

  return leg("EB-VENUESTATE", "unbindable", "no_lake_object", evidence, notes, ["market_status"], ms);
}
