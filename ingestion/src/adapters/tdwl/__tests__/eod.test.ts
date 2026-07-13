// Tests for the TDWL EOD bulletin parser (header-driven; decoded rows arrive on snapshot.meta).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTdwlEod, tdwlEodBulletin, TDWL_EOD_PARSER_VERSION } from "../eod.js";
import { makeSnapshot } from "./support.js";

const DECODED = [
  { Symbol: "2030", "Closing Price": "51.50", "Opening": "51.00", High: "51.80", Low: "50.90", Volume: "128,340", "Value Traded": "6,608,510" },
  { Symbol: "1120", "Closing Price": "92.10", "Opening": "91.50", High: "92.40", Low: "91.30", Volume: "2,841,220", "Value Traded": "261,470,000" },
  // no close → dropped (close is NOT NULL in ohlcv_daily)
  { Symbol: "9999", "Opening": "10.0" },
];

test("parseTdwlEod resolves columns by header label and coerces numbers", () => {
  const snap = makeSnapshot({
    venue: "TDWL",
    dataType: "eod_bulletin",
    body: Buffer.from("<xlsx-bytes>"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    meta: { decodedRows: DECODED, tradeDate: "2026-07-13" },
  });
  const { rows, parserVersion } = parseTdwlEod(snap);
  assert.equal(parserVersion, TDWL_EOD_PARSER_VERSION);
  assert.equal(rows.length, 2);
  const r0 = rows[0]!;
  assert.equal(r0.venue, "TDWL");
  assert.equal(r0.ticker, "2030");
  assert.equal(r0.tradeDate, "2026-07-13");
  assert.equal(r0.close, 51.5);
  assert.equal(r0.open, 51.0);
  assert.equal(r0.high, 51.8);
  assert.equal(r0.volume, 128340);
  assert.equal(r0.valueTraded, 6608510);
});

test("parseTdwlEod throws without decodedRows or a valid tradeDate", () => {
  assert.throws(
    () => parseTdwlEod(makeSnapshot({ venue: "TDWL", dataType: "eod_bulletin", body: Buffer.from("x"), meta: { tradeDate: "2026-07-13" } })),
    /no meta.decodedRows/,
  );
  assert.throws(
    () => parseTdwlEod(makeSnapshot({ venue: "TDWL", dataType: "eod_bulletin", body: Buffer.from("x"), meta: { decodedRows: DECODED } })),
    /missing meta.tradeDate/,
  );
  assert.throws(
    () => parseTdwlEod(makeSnapshot({ venue: "TDWL", dataType: "eod_bulletin", body: Buffer.from("x"), meta: { decodedRows: DECODED, tradeDate: "13/07/2026" } })),
    /missing meta.tradeDate/,
  );
});

test("eod task exposes the frozen dataType", () => {
  assert.equal(tdwlEodBulletin.dataType, "eod_bulletin");
});
