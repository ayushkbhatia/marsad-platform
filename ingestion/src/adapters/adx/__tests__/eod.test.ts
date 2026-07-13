// Tests for the ADX EOD daily-trading-report parser (header-driven; decoded rows on meta).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdxEod, adxEodBulletin } from "../eod.js";
import { makeSnapshot } from "../../tdwl/__tests__/support.js";

const DECODED = [
  { Security: "FAB", Close: "12.34", Open: "12.20", High: "12.40", Low: "12.10", Volume: "1,250,000", Turnover: "15,400,000" },
  { Security: "IHC", Close: "402.0", Open: "400.0", High: "404.0", Low: "399.0", Volume: "45,000", Turnover: "18,090,000" },
  { Security: "NOCLOSE" }, // dropped
];

test("parseAdxEod resolves columns and coerces", () => {
  const snap = makeSnapshot({ venue: "ADX", dataType: "eod_bulletin", body: Buffer.from("<xlsx>"), meta: { decodedRows: DECODED, tradeDate: "2026-07-13" } });
  const { rows } = parseAdxEod(snap);
  assert.equal(rows.length, 2);
  const fab = rows[0]!;
  assert.equal(fab.venue, "ADX");
  assert.equal(fab.ticker, "FAB");
  assert.equal(fab.close, 12.34);
  assert.equal(fab.volume, 1250000);
  assert.equal(fab.valueTraded, 15400000);
  assert.equal(fab.tradeDate, "2026-07-13");
});

test("parseAdxEod throws without decodedRows / tradeDate", () => {
  assert.throws(() => parseAdxEod(makeSnapshot({ venue: "ADX", dataType: "eod_bulletin", body: Buffer.from("x"), meta: { tradeDate: "2026-07-13" } })), /no meta.decodedRows/);
  assert.throws(() => parseAdxEod(makeSnapshot({ venue: "ADX", dataType: "eod_bulletin", body: Buffer.from("x"), meta: { decodedRows: DECODED } })), /missing meta.tradeDate/);
});

test("eod task exposes frozen dataType", () => {
  assert.equal(adxEodBulletin.dataType, "eod_bulletin");
});
