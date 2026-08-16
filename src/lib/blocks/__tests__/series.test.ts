import { test } from "node:test";
import assert from "node:assert/strict";
import { applySeries, seriesBindingsIn, seriesKey, SERIES_LIMIT_BY_SHAPE } from "../bindings";

const A = "00000000-0000-4000-a000-0000000000a1";
const B = "00000000-0000-4000-a000-0000000000b2";

const line = (series: unknown[]) => ({ code: "BLK-LINE", payload: { shape: "line", series } });
const bars = (series: unknown[]) => ({ code: "BLK-BARS", payload: { shape: "bars", series } });

test("a bar asks for ONE point per entry; a line asks for a family", () => {
  // Expanding a bar's family would silently turn "who is biggest" into twelve of one company.
  assert.equal(SERIES_LIMIT_BY_SHAPE.bars, 1);
  assert.ok(SERIES_LIMIT_BY_SHAPE.line > 1);

  const got = seriesBindingsIn([
    line([{ label: "Revenue", object_id: A, field: "revenue" }]),
    bars([{ label: "SABIC", object_id: A }, { label: "Aramco", object_id: B }]),
  ]);
  assert.deepEqual(got.map((g) => g.limit), [12, 1, 1]);
});

test("a non-chart payload contributes no series bindings", () => {
  // The scalar walk still owns those; double-handling them would resolve the same id twice.
  assert.deepEqual(seriesBindingsIn([{ code: "BLK-BIGNUM", payload: { value: { object_id: A, field: "v" } } }]), []);
});

test("the same object on two fields is two series", () => {
  assert.notEqual(seriesKey(A, "revenue"), seriesKey(A, "net_income"));
});

test("applySeries replaces the binding with points, leaving no bare object_id behind", () => {
  // This is the load-bearing property: isBinding fires on anything with an object_id, so a
  // ChartSeries that survived this pass would be collapsed into one formatted string by the
  // scalar walk — losing the label and every period but the anchor.
  const points = new Map([
    [seriesKey(A, "revenue"), [{ label: "Q1", date: "2026-03-31", value: 10, objectId: A, state: "VERIFIED" }]],
  ]);
  const out = applySeries(line([{ label: "Revenue", object_id: A, field: "revenue" }]).payload, points) as {
    series: { label: string; points: unknown[]; object_id?: string }[];
  };
  assert.equal(out.series[0]!.label, "Revenue");
  assert.equal(out.series[0]!.points.length, 1);
  assert.equal(out.series[0]!.object_id, undefined);
});

test("a series the lake had nothing for becomes empty, never partial", () => {
  const out = applySeries(line([{ label: "Revenue", object_id: A, field: "revenue" }]).payload, new Map()) as {
    series: { points: unknown[] }[];
  };
  assert.deepEqual(out.series[0]!.points, []);
});

test("a payload with no shape is returned untouched", () => {
  const payload = { series: [{ label: "x", object_id: A }] };
  assert.equal(applySeries(payload, new Map()), payload);
});
