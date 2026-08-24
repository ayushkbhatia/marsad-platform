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
    observed_at: new Date(o.row.updated_at).toISOString(),
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
      updated_at: r.obj_updated_at ?? new Date(0).toISOString(),
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
