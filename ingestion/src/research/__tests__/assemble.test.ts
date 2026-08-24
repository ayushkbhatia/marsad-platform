/**
 * PR.1 — the assembler, tested with no database.
 *
 * A fake `sql` tagged-template returns canned rows per query, so every property below is checked
 * offline: the legs' shapes, the absence contract, and the invariant that matters most — the
 * allow-set is derived from what was BOUND, never from anything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { assembleBrief, coversAllLegs, EMITTED_LEGS } from "../assemble.js";
import { verifyBundle, type ObjectSnapshot } from "../verify.js";
import { LEG_KEYS } from "../types.js";
import type { Sql } from "../../core/db.js";

const RATIOS_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const SCORE_ID = "bbbbbbbb-2222-4222-8222-222222222222";
const FIN_ID = "cccccccc-3333-4333-8333-333333333333";
const PROFILE_ID = "dddddddd-4444-4444-8444-444444444444";

const NOW = new Date("2026-07-28T00:00:00.000Z");

const obj = (over: Partial<Record<string, unknown>> & { id: string }) => ({
  object_type: "COMPUTED.RATIOS",
  natural_key: "COMPUTED.RATIOS:TDWL:15",
  revision: 14,
  state: "PENDING",
  payload: {},
  unit: null,
  effective_date: "2026-07-26",
  updated_at: "2026-07-26T23:00:00.000Z",
  source_rank: 1,
  ...over,
});

/** lake.objects is queried by type, so route on the bound parameter instead of the text. */
function lakeAwareSql(byType: Record<string, unknown[]>, rest: Record<string, unknown[]>): Sql {
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join(" ").replace(/\s+/g, " ").trim();
    if (text.includes("from lake.objects")) {
      const t = vals.find((v) => typeof v === "string" && v.includes(".")) as string | undefined;
      return Promise.resolve(t ? (byType[t] ?? []) : []);
    }
    for (const [needle, out] of Object.entries(rest)) {
      if (text.includes(needle)) return Promise.resolve(out);
    }
    if (text === "" || text === "and sector =") return { strings, vals } as never;
    return Promise.resolve([]);
  };
  return fn as unknown as Sql;
}

function db(over: { byType?: Record<string, unknown[]>; rest?: Record<string, unknown[]> } = {}): Sql {
  const byType: Record<string, unknown[]> = over.byType ?? {
    "COMPUTED.RATIOS": [obj({ id: RATIOS_ID, payload: { pe: 18.4, roe: 0.2, dividend_yield: null } })],
    "COMPUTED.SCORE": [obj({
      id: SCORE_ID, object_type: "COMPUTED.SCORE", natural_key: "COMPUTED.SCORE:TDWL:15",
      state: "VERIFIED", payload: { score: 67, rating: "BUY", sector_percentile: 82, thin_cohort: true },
    })],
    "PROFILE.SECURITY": [obj({
      id: PROFILE_ID, object_type: "PROFILE.SECURITY", natural_key: "PROFILE.SECURITY:TDWL:15",
      payload: { sharesOutstanding: 2_000_000_000 },
    })],
  };
  const rest: Record<string, unknown[]> = over.rest ?? {
    "from public.financial_statements": [{
      statement_type: "income", basis: "consolidated", period_kind: "quarter",
      fiscal_period: "Q2 2026", period_end: "2026-06-30", currency: "SAR", is_restated: false,
      line_items: { revenue: 12_000_000, net_income: 4_430_000 },
      source_object_id: FIN_ID, obj_id: FIN_ID, obj_state: "PENDING", obj_type: "FILING.FINANCIALS",
      natural_key: "FINANCIALS:TDWL:2010:income:Q2 2026", revision: 1,
      obj_payload: { currency: "SAR", line_items: { revenue: 12_000_000, net_income: 4_430_000 } },
      obj_updated_at: "2026-07-20T10:00:00.000Z", source_rank: 1,
    }],
    "from public.securities where id =": [{ sector: "banks", venue_code: "TDWL" }],
    "status = 'listed'": Array.from({ length: 8 }, (_, i) => ({
      id: 100 + i, ticker: `10${i}0`, name_en: `Peer ${i}`, venue_code: "TDWL", sector: "banks",
    })),
    "from public.dividends": [{ div_dated: 0, ee_consensus: 0 }],
  };
  return lakeAwareSql(byType, rest);
}

const legOf = (b: Awaited<ReturnType<typeof assembleBrief>>, k: string) =>
  b.legs.find((l) => l.bundle === k)!;

// ---------------------------------------------------------------------------

test("the assembler covers the closed leg vocabulary exactly", () => {
  assert.equal(coversAllLegs(), true);
  assert.equal(EMITTED_LEGS.length, LEG_KEYS.length);
  assert.deepEqual([...EMITTED_LEGS].sort(), [...LEG_KEYS].sort());
});

test("a rich security produces bound facts across the implemented legs", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  assert.equal(b.contract_version, 1);
  assert.equal(legOf(b, "EB-RATIOS").status, "present");
  assert.equal(legOf(b, "EB-SCORE").status, "present");
  assert.equal(legOf(b, "EB-IDENTITY").status, "present");
  assert.equal(legOf(b, "EB-STATEMENTS").status, "present");
  const pe = legOf(b, "EB-RATIOS").evidence.find((e) => e.kind === "fact" && e.metric_key === "pe");
  assert.ok(pe && pe.kind === "fact");
  assert.equal(pe.value, 18.4);
  assert.equal(pe.binding.object_id, RATIOS_ID);
  assert.equal(pe.binding.field, "payload.pe");
});

test("the fraction/percent decision comes from the lexicon, not the value", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const roe = legOf(b, "EB-RATIOS").evidence.find((e) => e.kind === "fact" && e.metric_key === "roe");
  assert.ok(roe && roe.kind === "fact");
  // stored 0.2, printed 20% — the ×100 lives in FIELD_FORMAT, read off ratios-compute.ts
  assert.equal(roe.value, 0.2);
  assert.equal(roe.format.multiplier, 100);
  assert.equal(roe.format.unit, "%");
});

test("a null ratio is reported as unavailable, never emitted as a fact", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const l = legOf(b, "EB-RATIOS");
  assert.ok(!l.evidence.some((e) => e.kind === "fact" && e.metric_key === "dividend_yield"));
  assert.ok(l.unavailable_fields.includes("dividend_yield"));
  assert.ok(l.notes.some((n) => /Not computed/.test(n)));
});

test("D-14: fit_bindable tracks the per-type citable states, not the state alone", async () => {
  const closed = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const peClosed = legOf(closed, "EB-RATIOS").evidence.find((e) => e.kind === "fact")!;
  assert.equal(peClosed.kind === "fact" && peClosed.fit_bindable, false, "PENDING is not citable by default");

  const open = await assembleBrief({
    sql: db(), securityId: 15, now: NOW,
    citableStates: { "COMPUTED.RATIOS": ["VERIFIED", "PENDING"] },
  });
  const peOpen = legOf(open, "EB-RATIOS").evidence.find((e) => e.kind === "fact")!;
  assert.equal(peOpen.kind === "fact" && peOpen.fit_bindable, true);
});

test("statements bind to the lake object, and carry the period they belong to", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const rev = legOf(b, "EB-STATEMENTS").evidence.find((e) => e.kind === "fact" && e.metric_key === "revenue");
  assert.ok(rev && rev.kind === "fact");
  assert.equal(rev.binding.object_id, FIN_ID);
  assert.equal(rev.binding.field, "payload.line_items.revenue");
  assert.equal(rev.period?.fiscal_period, "Q2 2026");
  // format is derived from the object's own reporting currency, not guessed
  assert.equal(rev.format.currency, "SAR");
});

test("a statement whose object no longer resolves is unbindable and SAYS so", async () => {
  const orphan = {
    statement_type: "income", basis: "consolidated", period_kind: "quarter",
    fiscal_period: "Q1 2026", period_end: "2026-03-31", currency: "SAR", is_restated: false,
    line_items: { revenue: 1 }, source_object_id: FIN_ID,
    obj_id: null, obj_state: null, obj_type: null, natural_key: null, revision: null,
    obj_payload: null, obj_updated_at: null, source_rank: null,
  };
  const b = await assembleBrief({
    sql: db({ rest: { "from public.financial_statements": [orphan], "from public.securities where id =": [{ sector: "banks", venue_code: "TDWL" }], "from public.dividends": [{ div_dated: 0, ee_consensus: 0 }] } }),
    securityId: 15, now: NOW,
  });
  const l = legOf(b, "EB-STATEMENTS");
  assert.equal(l.status, "unbindable");
  assert.ok(l.notes.some((n) => /NOT citable/.test(n)));
});

test("EB-CALENDAR reports ABSENT, not empty — the producer is dark for everyone", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const l = legOf(b, "EB-CALENDAR");
  // The distinction a writer acts on: `empty` licenses "this company declared none";
  // `absent` licenses nothing, because no feed was consulted.
  assert.equal(l.status, "absent");
  assert.equal(l.reason, "producer_dark");
  assert.ok(l.notes.some((n) => /do not write/i.test(n)));
  assert.ok(l.unavailable_fields.includes("eps_consensus"));
});

test("a thin cohort is REFUSED rather than returned as a ranking", async () => {
  const thin = Array.from({ length: 2 }, (_, i) => ({
    id: 200 + i, ticker: `20${i}0`, name_en: `Peer ${i}`, venue_code: "TDWL", sector: "banks",
  }));
  const b = await assembleBrief({
    sql: db({ rest: {
      "from public.securities where id =": [{ sector: "banks", venue_code: "TDWL" }],
      "status = 'listed'": thin,
      "from public.dividends": [{ div_dated: 0, ee_consensus: 0 }],
    } }),
    securityId: 15, now: NOW,
  });
  const l = legOf(b, "EB-PEERS");
  assert.equal(l.status, "refused");
  assert.equal(l.reason, "cohort_thin");
  assert.ok(l.notes.some((n) => /anecdote, not a ranking/.test(n)));
});

test("an unclassified subject gets a venue cohort, and the brief says so", async () => {
  const b = await assembleBrief({
    sql: db({ rest: {
      "from public.securities where id =": [{ sector: "unknown", venue_code: "ADX" }],
      "status = 'listed'": Array.from({ length: 9 }, (_, i) => ({
        id: 300 + i, ticker: `30${i}0`, name_en: `Peer ${i}`, venue_code: "ADX", sector: "unknown",
      })),
      "from public.dividends": [{ div_dated: 0, ee_consensus: 0 }],
    } }),
    securityId: 15, now: NOW,
  });
  const l = legOf(b, "EB-PEERS");
  assert.equal(l.status, "present");
  assert.ok(l.notes.some((n) => /a venue is not an industry/.test(n)));
});

test("the thin-cohort score flag is carried forward, not silently dropped", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  assert.ok(legOf(b, "EB-SCORE").notes.some((n) => /THIN/.test(n)));
});

test("declared-but-unbuilt legs report absent and explain what not to infer", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  for (const k of ["EB-PERIODPAIR", "EB-PRICE", "EB-QUOTE", "EB-FILINGS", "EB-REVISIONS", "EB-VENUESTATE"]) {
    const l = legOf(b, k);
    assert.equal(l.status, "absent", k);
    assert.equal(l.evidence.length, 0, k);
    assert.ok(l.notes.length > 0, k);
  }
  // The one that would otherwise invite a fabricated delta.
  assert.ok(legOf(b, "EB-PERIODPAIR").notes.some((n) => /no lake object holds it/.test(n)));
});

test("the allow-set is exactly what the legs bound — and verifyBundle agrees", async () => {
  const b = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const bound = new Set(
    b.legs.flatMap((l) => l.evidence.filter((e) => e.kind !== "unbound").map((e) => e.binding.object_id)),
  );
  assert.deepEqual([...b.allow_set].sort(), [...bound].sort());

  // And the brief passes its own verifier against the snapshots it claims to rest on.
  const snaps = new Map<string, ObjectSnapshot>([
    [RATIOS_ID, { id: RATIOS_ID, object_type: "COMPUTED.RATIOS", natural_key: "COMPUTED.RATIOS:TDWL:15", revision: 14, state: "PENDING", superseded_by: null, effective_date: "2026-07-26", unit: null, payload: { pe: 18.4, roe: 0.2, dividend_yield: null } }],
    [SCORE_ID, { id: SCORE_ID, object_type: "COMPUTED.SCORE", natural_key: "COMPUTED.SCORE:TDWL:15", revision: 14, state: "VERIFIED", superseded_by: null, effective_date: "2026-07-26", unit: null, payload: { score: 67, rating: "BUY", sector_percentile: 82, thin_cohort: true } }],
    [PROFILE_ID, { id: PROFILE_ID, object_type: "PROFILE.SECURITY", natural_key: "PROFILE.SECURITY:TDWL:15", revision: 14, state: "PENDING", superseded_by: null, effective_date: "2026-07-26", unit: null, payload: { sharesOutstanding: 2_000_000_000 } }],
    [FIN_ID, { id: FIN_ID, object_type: "FILING.FINANCIALS", natural_key: "FINANCIALS:TDWL:2010:income:Q2 2026", revision: 1, state: "PENDING", superseded_by: null, effective_date: null, unit: null, payload: { currency: "SAR", line_items: { revenue: 12_000_000, net_income: 4_430_000 } } }],
  ]);
  assert.deepEqual(verifyBundle(b, snaps), []);
});

test("assembly is reproducible — same database, same facts and same ids", async () => {
  const a = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const c = await assembleBrief({ sql: db(), securityId: 15, now: NOW });
  const ids = (x: typeof a) => x.legs.flatMap((l) => l.evidence.map((e) => `${e.fact_id}:${e.kind}`));
  assert.deepEqual(ids(a), ids(c));
  assert.deepEqual(a.allow_set.sort(), c.allow_set.sort());
});
