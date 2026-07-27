import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Registers the extensionless-`.ts` resolve hook. Must be a STATIC import (so it evaluates before
// the dynamic import below) and the schemas must be reached DYNAMICALLY (so the hook is already
// installed when their specifiers are resolved). See ts-resolve.mjs for why this exists.
import "../ts-resolve.mjs";

/**
 * PD.3 — the block payload schemas.
 *
 * WHAT THIS PROVES. `ops.story_blocks.payload_schema` is the projection of these Zod schemas, and
 * nothing in the pipeline reads it yet — the fit stage (PD.8) and the chart compiler (PD.6) are
 * both unbuilt. So there is no live surface that would notice if a schema were wrong. This file is
 * that notice, and it covers the three things that would actually hurt:
 *
 *   1. **coverage** — every active block code has a schema, checked against
 *      `docs/design/block-registry.json` rather than against a list maintained here, so adding a
 *      block to the design and forgetting its schema fails rather than passes;
 *   2. **the binding rule (D-8)** — a block that requires a binding rejects a literal number. This
 *      is the load-bearing decision of the whole design: it is what makes a fabricated figure
 *      structurally impossible rather than statistically unlikely;
 *   3. **the closed chart vocabulary (D-12)** — a chart block rejects a shape outside the fifteen,
 *      and rejects another block's shape.
 *
 * RUNNING IT: the Next app has no test runner in `package.json` and adding one is out of scope, so
 * this runs on Node's built-in runner with native TypeScript type-stripping — no dependency, no
 * config:
 *
 *     node --test "src/lib/blocks/schemas/__tests__/schemas.test.ts"
 */

type SchemaModule = typeof import("../index");

const SPECIFIER = "../index" + ".ts";
const schemas: SchemaModule = (await import(SPECIFIER)) as SchemaModule;

const {
  BLOCK_CODES,
  BLOCK_PAYLOAD_SCHEMAS,
  BLOCK_BINDING_EXCEPTIONS,
  BLOCK_BINDING_STRICTER_THAN_REGISTRY,
  CHART_SHAPES,
  SHAPE_BY_BLOCK,
  CHART_QUESTION_BY_SHAPE,
  blockPayloadSchema,
  safeParseBlockPayload,
  carriesObjectBinding,
  isBlockCode,
} = schemas;

/** The design handoff's machine-readable extraction — the same file the PD.2 registry seed reads. */
const registry = JSON.parse(
  readFileSync(new URL("../../../../../docs/design/block-registry.json", import.meta.url), "utf8"),
) as {
  blocks: Array<{ code: string; family: string; binds_to?: string | null }>;
};

/** `requires_binding` exactly as `scripts/design/generate-registry-seed.mjs` computes it. */
const requiresBinding = (b: (typeof registry.blocks)[number]) =>
  Boolean(b.binds_to) || b.family === "C" || b.family === "D";

/** A syntactically valid v4 uuid — the shape `lake.objects.id` has. */
const OBJ = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const binding = (field = "numeric_value") => ({ object_id: OBJ, field });
const series = (label: string, field = "numeric_value") => ({ label, object_id: OBJ, field });

function parse(code: string, payload: unknown) {
  const schema = blockPayloadSchema(code);
  assert.ok(schema, `${code} has no schema`);
  return schema.safeParse(payload);
}

// ── 1. coverage ──────────────────────────────────────────────────────────────

test("every active block in the design registry has a payload schema", () => {
  const designCodes = registry.blocks.map((b) => b.code).sort();
  assert.equal(designCodes.length, 61, "the design vocabulary is 61 blocks");
  assert.deepEqual([...BLOCK_CODES].sort(), designCodes);

  for (const code of designCodes) {
    assert.ok(blockPayloadSchema(code), `${code} has no payload schema`);
  }
  assert.equal(Object.keys(BLOCK_PAYLOAD_SCHEMAS).length, 61);
});

test("the 8 legacy keys have no schema — the design splits them, it does not rename them", () => {
  for (const legacy of [
    "BLK-QUOTE",
    "BLK-TABLE",
    "BLK-CHART",
    "BLK-SCORE",
    "BLK-YIELD",
    "BLK-COVERAGE",
    "BLK-HOLDERS",
    "BLK-FILING",
  ]) {
    assert.equal(blockPayloadSchema(legacy), undefined, `${legacy} should have no schema`);
    assert.equal(isBlockCode(legacy), false);
  }
});

test("every schema emits JSON Schema, named after its block, closed to unknown keys", () => {
  for (const code of BLOCK_CODES) {
    // `unrepresentable` defaults to "throw", so this also asserts nothing in the schema is a
    // construct the provider could not be given.
    const json = z.toJSONSchema(BLOCK_PAYLOAD_SCHEMAS[code], { io: "input" }) as {
      title?: string;
      additionalProperties?: boolean;
    };
    assert.ok(
      json.title?.startsWith(`${code} · `),
      `${code}: emitted schema is titled "${json.title}" — a validation error must name the block`,
    );
    assert.equal(
      json.additionalProperties,
      false,
      `${code}: payloads are closed — the publisher refuses, it does not degrade`,
    );
  }
});

// ── 2. the binding rule (D-8) ────────────────────────────────────────────────

test("D-8: a bound datum rejects a literal number", () => {
  const valid = {
    caption: "Aluminium Bahrain net margin, Q1 2026",
    context_line: "FROM 8.9% A YEAR AGO",
    value: binding(),
  };
  assert.equal(parse("BLK-BIGNUM", valid).success, true);

  // The whole point: the figure the headline rests on may not be typed.
  const literal = parse("BLK-BIGNUM", { ...valid, value: 11.4 });
  assert.equal(literal.success, false);

  // Nor may it be a string that looks like the rendered figure.
  assert.equal(parse("BLK-BIGNUM", { ...valid, value: "11.4%" }).success, false);

  // Nor a binding missing the field it reads.
  assert.equal(parse("BLK-BIGNUM", { ...valid, value: { object_id: OBJ } }).success, false);

  // Nor a natural key in place of the uuid.
  assert.equal(
    parse("BLK-BIGNUM", { ...valid, value: { object_id: "FILING.MARGIN.2222", field: "numeric_value" } })
      .success,
    false,
  );
});

test("D-8: a tabular cell rejects a literal number", () => {
  const cell = (value: unknown) => ({ label: "REVENUE", value, is_change: false });
  assert.equal(
    parse("BLK-STATSTRIP", { cells: [cell(binding()), cell(binding()), cell(binding())] }).success,
    true,
  );
  assert.equal(parse("BLK-STATSTRIP", { cells: [cell(3.2), cell(binding()), cell(binding())] }).success, false);
});

test("every block the registry marks requires_binding either binds, or is a declared exception", () => {
  const carriesBinding = (code: string) =>
    carriesObjectBinding(
      z.toJSONSchema(BLOCK_PAYLOAD_SCHEMAS[code as keyof typeof BLOCK_PAYLOAD_SCHEMAS], { io: "input" }),
    );

  const exceptions = Object.keys(BLOCK_BINDING_EXCEPTIONS);
  const stricter = Object.keys(BLOCK_BINDING_STRICTER_THAN_REGISTRY);
  const unexpectedlyUnbound: string[] = [];

  for (const b of registry.blocks) {
    if (requiresBinding(b) && !carriesBinding(b.code) && !exceptions.includes(b.code)) {
      unexpectedlyUnbound.push(b.code);
    }
    if (!requiresBinding(b) && carriesBinding(b.code)) {
      assert.ok(
        stricter.includes(b.code),
        `${b.code} binds but the registry says requires_binding=false and it is not a declared exception`,
      );
    }
  }
  assert.deepEqual(unexpectedlyUnbound, [], "requires_binding blocks with no binding and no reason given");

  // The exceptions must stay *declared*, not accumulate silently.
  assert.deepEqual(exceptions.sort(), ["BLK-GLOSSARY", "BLK-PAYWALL", "BLK-RULE", "BLK-TERM"]);
  assert.deepEqual(stricter.sort(), ["BLK-SNAPSHOT", "BLK-SPARK"]);
});

test("BLK-GLOSSARY takes no writer payload at all — it is assembled from the page", () => {
  assert.equal(parse("BLK-GLOSSARY", {}).success, true);
  assert.equal(parse("BLK-GLOSSARY", { terms: [{ term: "float", definition: "…" }] }).success, false);
});

test("BLK-CONFLICT has nowhere to put a resolved figure — the gap is the point", () => {
  const source = (label: string, is_primary: boolean) => ({ label, value: binding(), is_primary });
  const valid = {
    figure_label: "FY25 net income",
    period_label: "FY25",
    source_a: source("Vendor feed", false),
    source_b: source("FY25 annual report", true),
    resolution_statement: "Not quoted until the desk resolves it; primary wins unless overridden.",
  };
  assert.equal(parse("BLK-CONFLICT", valid).success, true);
  assert.equal(parse("BLK-CONFLICT", { ...valid, resolved_value: binding() }).success, false);
  // Both primary, or neither, is a refusal.
  assert.equal(
    parse("BLK-CONFLICT", { ...valid, source_a: source("Vendor feed", true) }).success,
    false,
  );
});

// ── 3. the closed chart vocabulary (D-12) ────────────────────────────────────

test("a chart block rejects an out-of-vocabulary shape", () => {
  const valid = {
    shape: "waterfall",
    caption: "What moved FY26E EBITDA",
    start: series("FY25"),
    series: [series("Volume"), series("Price"), series("Cost"), series("FX")],
    end: { ...series("FY26E"), is_estimate: true },
  };
  assert.equal(parse("BLK-WATERFALL", valid).success, true);

  // Not a shape at all.
  assert.equal(parse("BLK-WATERFALL", { ...valid, shape: "sankey" }).success, false);
  // A real shape, but another block's — a spec is layout, so the block picks the shape, not the agent.
  assert.equal(parse("BLK-WATERFALL", { ...valid, shape: "line" }).success, false);
  // Fewer drivers than the card's 4–6.
  assert.equal(parse("BLK-WATERFALL", { ...valid, series: [series("Volume")] }).success, false);
});

test("every D-family block pins its own shape, and the fifteen are distinct", () => {
  const shapes = Object.values(SHAPE_BY_BLOCK);
  assert.equal(shapes.length, 15);
  assert.equal(new Set(shapes).size, 15);
  assert.deepEqual([...shapes].sort(), [...CHART_SHAPES].sort());

  for (const [code, shape] of Object.entries(SHAPE_BY_BLOCK)) {
    const json = z.toJSONSchema(BLOCK_PAYLOAD_SCHEMAS[code as keyof typeof BLOCK_PAYLOAD_SCHEMAS], {
      io: "input",
    }) as { properties?: Record<string, { const?: string }> };
    assert.equal(json.properties?.shape?.const, shape, `${code} must pin shape="${shape}"`);
  }
});

test("the chart-selection contract carries the design's own questions", () => {
  assert.equal(CHART_QUESTION_BY_SHAPE.waterfall, "WHAT MOVED IT?");
  assert.equal(CHART_QUESTION_BY_SHAPE.range, "WHERE'S FAIR?");
  // Three shapes have a subject on the card, not a question, and are not given an invented one.
  assert.equal(CHART_QUESTION_BY_SHAPE.candle, null);
});

test("BLK-LINE requires its inflection annotation — a line without one is decoration", () => {
  const valid = {
    shape: "line",
    caption: "Net interest margin, 2019–2026",
    series: [series("NIM")],
    annotation: { at: "2024-03-31", what_happened: "The deposit repricing cycle turned." },
  };
  assert.equal(parse("BLK-LINE", valid).success, true);
  assert.equal(
    parse("BLK-LINE", { shape: valid.shape, caption: valid.caption, series: valid.series }).success,
    false,
  );
});

// ── cross-field rules that JSON Schema cannot carry ──────────────────────────

test("BLK-THESIS is exactly three lines; BLK-FALSIFY has no fixed count", () => {
  const claim = "Margins expand through 2027 as the smelter's power contract resets.";
  assert.equal(parse("BLK-THESIS", { claims: [claim, claim, claim] }).success, true);
  assert.equal(parse("BLK-THESIS", { claims: [claim, claim] }).success, false);
  assert.equal(parse("BLK-THESIS", { claims: [claim, claim, claim, claim] }).success, false);

  // The card says "3 in the specimen", not "exactly three" — reading an example as a rule would
  // make the newsroom refuse legitimate copy.
  assert.equal(parse("BLK-FALSIFY", { falsifiers: ["Alumina above $420/t for two quarters."] }).success, true);
});

test("BLK-AGENTS: the human is always last in the chain", () => {
  const base = {
    narrative: "Extracted by DATA-TDWL, modelled by DESK-MODEL, edited by the desk.",
    chain: [
      { name: "DATA-TDWL", is_agent: true },
      { name: "A. Editor", is_agent: false },
    ],
  };
  assert.equal(parse("BLK-AGENTS", base).success, true);
  assert.equal(
    parse("BLK-AGENTS", { ...base, chain: [{ name: "A. Editor", is_agent: false }, { name: "DATA-TDWL", is_agent: true }] })
      .success,
    false,
  );
});

test("BLK-FINTABLE: every row carries one value per period column", () => {
  const periods = [
    { label: "FY24", is_estimate: false },
    { label: "FY25", is_estimate: false },
    { label: "FY26", is_estimate: true },
  ];
  const valid = {
    unit: "OMR M",
    periods,
    rows: [{ label: "Revenue", values: [binding(), binding(), binding()] }],
    estimate_footnote: "FY26E is a Marsad desk estimate, not a company disclosure.",
  };
  assert.equal(parse("BLK-FINTABLE", valid).success, true);
  assert.equal(
    parse("BLK-FINTABLE", { ...valid, rows: [{ label: "Revenue", values: [binding(), binding()] }] }).success,
    false,
  );
  // Max 8 rows inline; longer tables go to the XLSX.
  assert.equal(
    parse("BLK-FINTABLE", {
      ...valid,
      rows: Array.from({ length: 9 }, (_, i) => ({
        label: `Line ${i}`,
        values: [binding(), binding(), binding()],
      })),
    }).success,
    false,
  );
});

test("BLK-KEYSTATS takes 4 or 8 cells and no other count", () => {
  const cells = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `L${i}`, value: binding() }));
  assert.equal(parse("BLK-KEYSTATS", { cells: cells(4) }).success, true);
  assert.equal(parse("BLK-KEYSTATS", { cells: cells(8) }).success, true);
  assert.equal(parse("BLK-KEYSTATS", { cells: cells(6) }).success, false);
});

test("BLK-TAPEROW caps the body at 40 words — a pattern the provider can enforce too", () => {
  const base = {
    at: "2026-07-27T10:14:00+03:00",
    venue: "TDWL",
    category: "DIVIDEND",
    ticker: "7010",
    filing_reference: "CG-1",
    headline: "STC declares an interim dividend of SAR 1.00",
    body: "The board approved an interim cash dividend of one riyal a share.",
  };
  assert.equal(parse("BLK-TAPEROW", base).success, true);
  assert.equal(parse("BLK-TAPEROW", { ...base, body: "word ".repeat(41).trim() }).success, false);
  // The venue vocabulary is closed to `public.venues.code`.
  assert.equal(parse("BLK-TAPEROW", { ...base, venue: "NASDAQ" }).success, false);
});

// ── refusal surface ──────────────────────────────────────────────────────────

test("payloads are strict — an unknown key is a refusal, not a silent drop", () => {
  const valid = { host_paragraph: "…", label: "NOTE", body: "Alba's power contract resets in 2027." };
  assert.equal(parse("BLK-MARGIN", valid).success, true);
  assert.equal(parse("BLK-MARGIN", { ...valid, colour: "#c0342b" }).success, false);
});

test("safeParseBlockPayload names the block, and refuses an invented one", () => {
  const invented = safeParseBlockPayload("BLK-SANKEY", {});
  assert.equal(invented.ok, false);
  assert.match(invented.ok ? "" : invented.error, /BLK-SANKEY/);
  assert.match(invented.ok ? "" : invented.error, /no agent may invent a new block/);

  const bad = safeParseBlockPayload("BLK-BIGNUM", { caption: "x", context_line: "y", value: 11.4 });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /^BLK-BIGNUM: /);
  assert.match(bad.ok ? "" : bad.error, /value/);

  const good = safeParseBlockPayload("BLK-MARGIN", {
    host_paragraph: "…",
    body: "Alba's power contract resets in 2027.",
  });
  assert.equal(good.ok, true);
});
