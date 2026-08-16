import { test } from "node:test";
import assert from "node:assert/strict";
import { project, seriesProvenance, type SeriesPoint } from "../chart-svg";

const pt = (label: string, value: number | null, i = 0): SeriesPoint => ({
  label, value, date: `2026-0${(i % 9) + 1}-01`, objectId: `obj-${label}`, state: "PENDING",
});

test("a hole breaks the path instead of bridging it", () => {
  // Interpolating across a missing quarter invents a figure the lake does not have — the exact
  // failure the binding contract exists to prevent.
  const g = project([pt("Q1", 1, 0), pt("Q2", null, 1), pt("Q3", 3, 2)]);
  assert.equal(g.hasGaps, true);
  assert.equal((g.linePath.match(/M/g) ?? []).length, 2, "two segments, not one bridged line");
});

test("a complete series draws one continuous path", () => {
  const g = project([pt("Q1", 1, 0), pt("Q2", 2, 1), pt("Q3", 3, 2)]);
  assert.equal(g.hasGaps, false);
  assert.equal((g.linePath.match(/M/g) ?? []).length, 1);
});

test("a flat series does not divide by zero or fill the frame", () => {
  const g = project([pt("Q1", 5, 0), pt("Q2", 5, 1)]);
  assert.ok(Number.isFinite(g.points[0]!.y));
  assert.ok(g.points[0]!.y > 0 && g.points[0]!.y < g.height);
});

test("bars are measured against zero, not against the series minimum", () => {
  // A bar chart whose baseline floats overstates every difference.
  const g = project([pt("A", 100, 0), pt("B", 110, 1)]);
  const [a, b] = g.bars;
  assert.ok(a!.h > 0 && b!.h > 0);
  assert.ok(Math.abs(a!.h - b!.h) < a!.h, "bar heights must not differ by more than their own size");
});

test("an area only closes when the series is unbroken", () => {
  assert.equal(project([pt("Q1", 1, 0), pt("Q2", null, 1), pt("Q3", 3, 2)]).areaPath, "");
  assert.match(project([pt("Q1", 1, 0), pt("Q2", 2, 1)]).areaPath, /Z$/);
});

test("an empty series yields no geometry rather than a degenerate chart", () => {
  const g = project([]);
  assert.equal(g.linePath, "");
  assert.deepEqual(g.bars, []);
});

test("provenance travels with the series, one entry per distinct object", () => {
  const s = [pt("Q1", 1, 0), pt("Q2", 2, 1)];
  const p = seriesProvenance(s);
  assert.equal(p.objectIds.length, 2);
  assert.equal(p.allVerified, false);
});
