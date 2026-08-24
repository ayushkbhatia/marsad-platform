/**
 * PR.1 step 2 — golden tests for the brief verifier.
 *
 * Exit criterion for this step, from the spec: **these pass with the network down.** No DB, no
 * fixtures fetched at runtime, no credentials. The four traps each get a test because each is a way
 * a brief can look correct and be wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUNDLE_CONTRACT_VERSION,
  type EvidenceBrief,
  type EvidenceLeg,
} from "../envelope.js";
import { FIELD_FORMAT, formatFor, isResolvableField } from "../lexicon.js";
import { LEG_KEYS, TOLERANCE_DAYS } from "../types.js";
import {
  isStrictUuidV4,
  resolveField,
  valuesAgree,
  verifyBundle,
  type ObjectSnapshot,
} from "../verify.js";

// ---------------------------------------------------------------------------
// Fixtures — strict RFC v4 uuids, because the binding schema is strict.
// ---------------------------------------------------------------------------

const RATIOS_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const FIN_ID = "bbbbbbbb-2222-4222-8222-222222222222";

function snap(over: Partial<ObjectSnapshot> & { id: string }): ObjectSnapshot {
  return {
    object_type: "COMPUTED.RATIOS",
    natural_key: "COMPUTED.RATIOS:TDWL:15",
    revision: 14,
    state: "VERIFIED",
    superseded_by: null,
    effective_date: null,
    unit: null,
    payload: { pe: 18.4, roe: 0.2, dividend_yield: null },
    ...over,
  };
}

function fact(over: Record<string, unknown> = {}) {
  return {
    kind: "fact" as const,
    fact_id: "f1",
    bundle: "EB-RATIOS" as const,
    binding: { object_id: RATIOS_ID, field: "payload.pe" },
    binding_shape: "scalar" as const,
    object_state: "VERIFIED" as const,
    fit_bindable: true,
    rebind: { object_type: "COMPUTED.RATIOS", natural_key: "COMPUTED.RATIOS:TDWL:15", revision: 14 },
    volatility: "recomputed" as const,
    source_rank: null,
    label: "P/E",
    metric_key: "pe",
    value: 18.4,
    format: FIELD_FORMAT["COMPUTED.RATIOS|payload.pe"]!,
    as_of: null,
    observed_at: "2026-07-26T23:00:41.059Z",
    input_as_of: null,
    age_days: 1,
    freshness: "fresh" as const,
    period: null,
    ...over,
  };
}

function leg(over: Partial<EvidenceLeg> = {}): EvidenceLeg {
  return {
    bundle: "EB-RATIOS",
    status: "present",
    reason: "ok",
    evidence: [fact()],
    notes: [],
    unavailable_fields: [],
    tolerance_days: 7,
    newest_as_of: null,
    query_ms: 3,
    ...over,
  } as EvidenceLeg;
}

function brief(over: Partial<EvidenceBrief> = {}): EvidenceBrief {
  const legs = over.legs ?? [leg()];
  const allow =
    over.allow_set ??
    [...new Set(legs.flatMap((l) => l.evidence.filter((e) => e.kind !== "unbound").map((e) => e.binding.object_id)))];
  return {
    contract_version: BUNDLE_CONTRACT_VERSION,
    security_id: 15,
    venue_code: "TDWL",
    trigger_object_id: null,
    assembled_at: "2026-07-27T22:00:00.000Z",
    assembly_ms: 12,
    legs,
    allow_set: allow,
    ...over,
  } as EvidenceBrief;
}

const objectsFor = (...s: ObjectSnapshot[]) => new Map(s.map((x) => [x.id, x]));

// ---------------------------------------------------------------------------
// 0. The happy path must actually be clean, or every test below is vacuous.
// ---------------------------------------------------------------------------

test("verify: a well-formed brief returns no failures", () => {
  const r = verifyBundle(brief(), objectsFor(snap({ id: RATIOS_ID })));
  assert.deepEqual(r, []);
});

// ---------------------------------------------------------------------------
// TRAP 1 — numeric string vs JSON number across the postgres.js/jsonb boundary
// ---------------------------------------------------------------------------

test("trap 1: a numeric STRING and a JSON number are the same fact", () => {
  // postgres.js returns `numeric` as a JS string; jsonb numbers arrive as numbers.
  assert.equal(valuesAgree("902850000", 902850000), true);
  assert.equal(valuesAgree("6250000000.00", 6250000000), true);
  assert.equal(valuesAgree(56.06186582284612, "56.06186582284612"), true);
  // ...but a genuinely different number is still different.
  assert.equal(valuesAgree("902850000", 902850001), false);
  // and a non-numeric string is compared as a string, not coerced to NaN
  assert.equal(valuesAgree("BUY", "BUY"), true);
  assert.equal(valuesAgree("BUY", "SELL"), false);
});

test("trap 1: a string-valued frozen fact verifies against a numeric payload", () => {
  const b = brief({ legs: [leg({ evidence: [fact({ value: "18.4" })] })] });
  assert.deepEqual(verifyBundle(b, objectsFor(snap({ id: RATIOS_ID }))), []);
});

// ---------------------------------------------------------------------------
// TRAP 2 — a well-shaped path whose key does not exist
// ---------------------------------------------------------------------------

test("trap 2: an absent line_items key is a failure, not a null fact", () => {
  const b = brief({
    legs: [
      leg({
        bundle: "EB-STATEMENTS",
        evidence: [
          fact({
            bundle: "EB-STATEMENTS",
            binding: { object_id: FIN_ID, field: "payload.line_items.gross_profit" },
            value: 1000,
          }),
        ],
      }),
    ],
  });
  const bank = snap({
    id: FIN_ID,
    object_type: "FILING.FINANCIALS",
    natural_key: "FINANCIALS:QE:QNBK:income:Q2 2026",
    // A bank files net_interest_income and has no gross_profit line at all.
    payload: { line_items: { net_interest_income: 8_000_000 }, currency: "QAR" },
  });
  const r = verifyBundle(b, objectsFor(bank));
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].code, "field_missing");
  assert.match(r[0].detail, /gross_profit/);
});

test("trap 2: a key that EXISTS and is null is not 'missing' — the distinction is load-bearing", () => {
  // dividend_yield is null on all 736 live COMPUTED.RATIOS rows. Present-and-null is a real
  // observation; absent is an assembler bug. Only the second may fail.
  const s = snap({ id: RATIOS_ID });
  assert.deepEqual(resolveField(s, "payload.dividend_yield"), { found: true, value: null });
  assert.deepEqual(resolveField(s, "payload.nope"), { found: false, value: undefined });
});

// ---------------------------------------------------------------------------
// TRAP 3 — a DB-legal uuid that the binding schema refuses
// ---------------------------------------------------------------------------

test("trap 3: an 8-4-4-4-12 hex that is not RFC v4 is refused", () => {
  // Postgres accepts this; z.uuid() does not. It was living in fit.test.ts's own OBJ constant.
  assert.equal(isStrictUuidV4("11111111-1111-1111-1111-111111111111"), false);
  assert.equal(isStrictUuidV4("11111111-1111-4111-8111-111111111111"), true);
  // version nibble right, variant nibble wrong
  assert.equal(isStrictUuidV4("11111111-1111-4111-1111-111111111111"), false);

  const bad = "11111111-1111-1111-1111-111111111111";
  const b = brief({
    legs: [leg({ evidence: [fact({ binding: { object_id: bad, field: "payload.pe" } })] })],
    allow_set: [bad],
  });
  const r = verifyBundle(b, objectsFor(snap({ id: bad })));
  assert.ok(r.some((f) => f.code === "unknown_object" && /strict RFC v4/.test(f.detail)));
});

// ---------------------------------------------------------------------------
// TRAP 4 — a superseded revision
// ---------------------------------------------------------------------------

test("trap 4: a superseded object is refused even though it resolves correctly", () => {
  // COMPUTED.RATIOS carries 13.9 revisions per natural key, rebuilt nightly. The value here is
  // RIGHT — that is what makes this trap dangerous.
  const r = verifyBundle(
    brief(),
    objectsFor(snap({ id: RATIOS_ID, superseded_by: "cccccccc-3333-4333-8333-333333333333" })),
  );
  assert.equal(r.length, 1, JSON.stringify(r));
  assert.equal(r[0].code, "superseded");
});

test("trap 4: a RETIRED object is refused", () => {
  const r = verifyBundle(brief(), objectsFor(snap({ id: RATIOS_ID, state: "RETIRED" })));
  assert.equal(r[0]?.code, "retired");
});

// ---------------------------------------------------------------------------
// The field allow-list
// ---------------------------------------------------------------------------

test("lexicon: numeric_value is excluded absolutely", () => {
  assert.equal(isResolvableField("numeric_value"), false);
  assert.equal(isResolvableField("payload.pe"), true);
  assert.equal(isResolvableField("effective_date"), true);
  assert.equal(isResolvableField("unit"), true);
  // schema-legal per binding.ts, semantically wrong, unprintable
  for (const f of ["natural_key", "superseded_by", "revision", "security_id", "created_at"]) {
    assert.equal(isResolvableField(f), false, f);
  }
});

test("lexicon: a binding to numeric_value fails verification", () => {
  const b = brief({
    legs: [leg({ evidence: [fact({ binding: { object_id: RATIOS_ID, field: "numeric_value" } })] })],
  });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  assert.equal(r[0]?.code, "field_not_resolvable");
});

test("lexicon: the margin/return family is stored as a FRACTION and prints x100", () => {
  // ratios-compute.ts:202 computes roe = netIncome/equity; its test asserts 0.2 for 200/1000.
  const roe = formatFor("COMPUTED.RATIOS", "payload.roe")!;
  assert.equal(roe.multiplier, 100);
  assert.equal(roe.unit, "%");
  // a multiple is NOT a percent
  assert.equal(formatFor("COMPUTED.RATIOS", "payload.pe")!.multiplier, 1);
  assert.equal(formatFor("COMPUTED.RATIOS", "payload.pe")!.unit, "x");
  // the score is 0-100 already — giving it x100 would print 6,700%
  assert.equal(formatFor("COMPUTED.SCORE", "payload.score")!.multiplier, 1);
  // changePct arrives already-percent on the wire
  assert.equal(formatFor("QUOTE.LAST", "payload.changePct")!.multiplier, 1);
});

test("lexicon: an unmapped (type, field) pair fails rather than guessing a format", () => {
  const b = brief({
    legs: [
      leg({ evidence: [fact({ binding: { object_id: RATIOS_ID, field: "payload.made_up_key" }, value: 1 })] }),
    ],
  });
  const r = verifyBundle(
    b,
    objectsFor(snap({ id: RATIOS_ID, payload: { made_up_key: 1 } })),
  );
  assert.ok(r.some((f) => f.code === "format_missing"));
});

// ---------------------------------------------------------------------------
// Status / evidence coherence and the allow-set
// ---------------------------------------------------------------------------

test("status: 'absent' may not carry evidence — the contradiction that licenses invention", () => {
  const b = brief({ legs: [leg({ status: "absent", reason: "no_producer" })] });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  assert.ok(r.some((f) => f.code === "status_carries_evidence"));
});

test("status: 'unbindable' may carry unbound facts but never a bound one", () => {
  const b = brief({
    legs: [leg({ status: "unbindable", reason: "no_lake_object" })],
  });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  assert.ok(r.some((f) => f.code === "bound_fact_in_unbound_status"));
});

test("allow_set: a bound object missing from the allow-set is a failure", () => {
  const b = brief({ allow_set: [] });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  assert.ok(r.some((f) => f.code === "allow_set_mismatch" && /missing from allow_set/.test(f.detail)));
});

test("allow_set: an entry no evidence binds is also a failure", () => {
  const orphan = "dddddddd-4444-4444-8444-444444444444";
  const b = brief({ allow_set: [RATIOS_ID, orphan] });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  assert.ok(r.some((f) => f.code === "allow_set_mismatch" && /no evidence binds it/.test(f.detail)));
});

test("verify: every failure is reported, not just the first", () => {
  const b = brief({
    legs: [
      leg({
        evidence: [
          fact({ fact_id: "f1", binding: { object_id: RATIOS_ID, field: "numeric_value" } }),
          fact({ fact_id: "f1", value: 99.9 }), // duplicate id AND a value mismatch
        ],
      }),
    ],
  });
  const r = verifyBundle(b, objectsFor(snap({ id: RATIOS_ID })));
  const codes = r.map((f) => f.code);
  assert.ok(codes.includes("field_not_resolvable"), codes.join(","));
  assert.ok(codes.includes("duplicate_fact_id"), codes.join(","));
  assert.ok(codes.includes("value_mismatch"), codes.join(","));
});

// ---------------------------------------------------------------------------
// Vocabulary completeness
// ---------------------------------------------------------------------------

test("types: all 12 legs are declared and each has a tolerance entry", () => {
  assert.equal(LEG_KEYS.length, 12);
  assert.equal(new Set(LEG_KEYS).size, 12);
  for (const k of LEG_KEYS) {
    assert.ok(k in TOLERANCE_DAYS, `${k} has no TOLERANCE_DAYS entry`);
  }
  // A filing is an event; an old one is history, not staleness.
  assert.equal(TOLERANCE_DAYS["EB-FILINGS"], null);
  assert.equal(TOLERANCE_DAYS["EB-REVISIONS"], null);
});
