/**
 * Every renderer must degrade, never crash.
 *
 * `MissingBlock`'s own card states the principle — "LOUD, LOGGED, NON-FATAL AT RENDER · THE
 * PUBLISHER IS THE THING THAT REFUSES" — and a renderer that throws breaks it: it takes the whole
 * page down, which is strictly worse than rendering a gap.
 *
 * This is not hypothetical. The styleguide's "unregistered code" demo used `BLK-WATERFALL` with an
 * empty payload, which was safe only while family D was unbuilt. The moment those renderers landed
 * it crashed the entire page on `drivers.length` — and `tsc` could not see it, because the payload
 * was cast at the fixture.
 *
 * Renderers are server components with no hooks or effects, so they are invoked as plain functions
 * rather than mounted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BLOCK_RENDERERS, IMPLEMENTED_BLOCK_CODES } from "../registry";

/**
 * Families D, E, F and the two H blocks this branch added.
 *
 * The guard is scoped rather than universal because **21 pre-existing renderers in families A, B,
 * C, G and main's H throw on an empty payload too** — measured, not assumed. That is a real gap and
 * it is logged as DEF-RENDERER-THROWS-ON-EMPTY, but fixing thirty files this branch did not write
 * is a separate change. The scope can only widen from here.
 */
const AUTHORED_HERE = new Set([
  "BLK-STACK", "BLK-WATERFALL", "BLK-SCATTER", "BLK-DIST", "BLK-DUMBBELL", "BLK-SLOPE",
  "BLK-RANGE", "BLK-HEAT", "BLK-INDEXED", "BLK-DONUT", "BLK-COVER", "BLK-CANDLE",
  "BLK-TIMELINE", "BLK-STEPS", "BLK-FLOW", "BLK-ANATOMY", "BLK-WORKED", "BLK-MYTH",
  "BLK-DECISION", "BLK-GLOSSARY",
  "BLK-TAPEROW", "BLK-CHIPROW", "BLK-SNAPSHOT", "BLK-COUNTDOWN", "BLK-HALT",
  "BLK-CORRECTION", "BLK-BREADTH", "BLK-VENUEHEAD",
  "BLK-ALERTCTA", "BLK-DOWNLOAD",
]);

test("all 61 codes are registered", () => {
  assert.equal(IMPLEMENTED_BLOCK_CODES.length, 61);
});

test("every renderer survives an empty payload", () => {
  const failed: string[] = [];
  for (const code of IMPLEMENTED_BLOCK_CODES.filter((c) => AUTHORED_HERE.has(c))) {
    const Renderer = BLOCK_RENDERERS[code] as unknown as (p: { node: unknown }) => unknown;
    try {
      Renderer({ node: { _key: "t", code, payload: {} } });
    } catch (err) {
      failed.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(failed, [], `renderers threw on an empty payload:\n${failed.join("\n")}`);
});

test("every renderer survives null-valued data", () => {
  // The commoner production case: the shape is right, the bindings did not resolve. A chart with
  // nothing to draw must say so, not divide by zero or emit NaN into an SVG path.
  const nulls = {
    caption: "x", segments: [{ label: "a", value: null, objectId: "", state: "PENDING" }],
    series: [{ label: "a", points: [{ label: "p", date: null, value: null, objectId: "", state: "PENDING" }] }],
    rows: [{ label: "a", from: null, to: null, objectId: "", state: "PENDING" }],
    points: [{ label: "a", x: null, y: null, r: null, objectId: "", state: "PENDING" }],
    candles: [{ label: "a", open: null, high: null, low: null, close: null, objectId: "", state: "PENDING" }],
    cells: [[{ value: null, objectId: "", state: "PENDING" }]],
    rowLabels: ["r"], colLabels: ["c"],
    start: { label: "s", value: null, objectId: "", state: "PENDING" },
    end: { label: "e", value: null, objectId: "", state: "PENDING" },
    drivers: [], objectIds: [], covered: null, scaleMax: 5,
    subject: { label: "s", points: [] }, benchmark: { label: "b", points: [] },
    centreValue: "—", centreLabel: "x", method: "m", basis: "b",
    bear: null, base: null, bull: null, live: null,
  };
  const failed: string[] = [];
  for (const code of IMPLEMENTED_BLOCK_CODES.filter((c) => AUTHORED_HERE.has(c))) {
    const Renderer = BLOCK_RENDERERS[code] as unknown as (p: { node: unknown }) => unknown;
    try {
      Renderer({ node: { _key: "t", code, payload: nulls } });
    } catch (err) {
      failed.push(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(failed, [], `renderers threw on unresolved data:\n${failed.join("\n")}`);
});
