// Tests for the ADX config-driven quotes parser + fetcher. Zero network.
// ADX field names are unknown until the first VPS capture, so the parser is driven by a fieldMap
// (endpointConfig.fieldMap → snapshot.meta.fieldMap). These tests exercise a synthetic golden with
// a NON-default field map to prove the config-over-code mapping, plus the default-map path.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAdxQuotes,
  mapAdxRow,
  getPath,
  adxNumber,
  adxAsOfToUtc,
  adxQuotes,
  ADX_QUOTES_PARSER_VERSION,
  type AdxFieldMap,
} from "../quotes.js";
import {
  makeSnapshot,
  makeSource,
  makeCtx,
  FakeBrowserClient,
  rawResponse,
} from "../../tdwl/__tests__/support.js";

test("getPath resolves dotted paths and returns undefined on misses", () => {
  assert.equal(getPath({ a: { b: { c: 5 } } }, "a.b.c"), 5);
  assert.equal(getPath({ a: { b: {} } }, "a.b.c"), undefined);
  assert.equal(getPath(null, "a"), undefined);
  assert.equal(getPath({ a: 1 }, undefined), undefined);
});

test("adxNumber + adxAsOfToUtc normalize scalar shapes", () => {
  assert.equal(adxNumber("1,234.5"), 1234.5);
  assert.equal(adxNumber(""), null);
  assert.equal(adxNumber(42), 42);
  assert.equal(adxAsOfToUtc("2026-07-13T12:00:00Z", "iso"), "2026-07-13T12:00:00.000Z");
  assert.equal(adxAsOfToUtc(1_752_408_000_000, "epoch_ms"), new Date(1_752_408_000_000).toISOString());
  assert.equal(adxAsOfToUtc(1_752_408_000, "epoch_s"), new Date(1_752_408_000_000).toISOString());
  assert.equal(adxAsOfToUtc("", "iso"), "");
  assert.equal(adxAsOfToUtc("nonsense", "iso"), "");
});

// Synthetic golden using a NON-default field map (proves the parser is config-driven, not hardcoded
// to any guessed ADX field names). Rows live under result.rows; fields have ADX-ish names.
const SYNTHETIC = JSON.stringify({
  result: {
    rows: [
      {
        secCode: "FAB",
        px: "12.34",
        chg: "0.14",
        chgPct: "1.15",
        o: "12.20",
        h: "12.40",
        l: "12.10",
        pc: "12.20",
        vol: "1,250,000",
        bidPx: "12.33",
        askPx: "12.35",
        ts: 1_752_408_000_000,
      },
      { secCode: "ADNOCDIST", px: "3.50", pc: "3.50", vol: "800000", ts: 1_752_408_000_000 }, // change derives to 0
      { px: "9.9" }, // no symbol → dropped
    ],
  },
});

const ADX_MAP: AdxFieldMap = {
  rowsPath: "result.rows",
  symbol: "secCode",
  last: "px",
  change: "chg",
  changePct: "chgPct",
  open: "o",
  high: "h",
  low: "l",
  prevClose: "pc",
  volume: "vol",
  bid: "bidPx",
  ask: "askPx",
  asOf: "ts",
  asOfKind: "epoch_ms",
};

test("golden: parseAdxQuotes maps via the configured field map", () => {
  const snap = makeSnapshot({
    venue: "ADX",
    dataType: "quotes",
    body: SYNTHETIC,
    contentType: "application/json",
    meta: { fieldMap: ADX_MAP },
  });
  const { rows, parserVersion } = parseAdxQuotes(snap);
  assert.equal(parserVersion, ADX_QUOTES_PARSER_VERSION);
  assert.equal(rows.length, 2);

  const fab = rows.find((r) => r.ticker === "FAB")!;
  assert.equal(fab.venue, "ADX");
  assert.equal(fab.last, 12.34);
  assert.equal(fab.change, 0.14);
  assert.equal(fab.changePct, 1.15);
  assert.equal(fab.open, 12.2);
  assert.equal(fab.high, 12.4);
  assert.equal(fab.low, 12.1);
  assert.equal(fab.volume, 1250000);
  assert.equal(fab.bid, 12.33);
  assert.equal(fab.ask, 12.35);
  assert.equal(fab.asOf, new Date(1_752_408_000_000).toISOString());

  const adnoc = rows.find((r) => r.ticker === "ADNOCDIST")!;
  assert.equal(adnoc.change, 0); // derived: last(3.50) - prevClose(3.50)
  assert.equal(adnoc.changePct, 0);
});

test("mapAdxRow derives change/pct from prevClose when omitted", () => {
  const q = mapAdxRow({ secCode: "X", px: 110, pc: 100 }, { symbol: "secCode", last: "px", prevClose: "pc" });
  assert.ok(q);
  assert.equal(q!.change, 10);
  assert.equal(q!.changePct, 10);
});

test("parseAdxQuotes uses DEFAULT map when meta.fieldMap absent", () => {
  const body = JSON.stringify({ data: [{ symbol: "AAA", last: "5.0", previousClose: "4.0", volume: "10", timestamp: "2026-07-13T12:00:00Z" }] });
  const snap = makeSnapshot({ venue: "ADX", dataType: "quotes", body, contentType: "application/json" });
  const { rows } = parseAdxQuotes(snap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ticker, "AAA");
  assert.equal(rows[0]!.last, 5);
  assert.equal(rows[0]!.change, 1); // 5 - 4
});

test("parseAdxQuotes throws on bad JSON / missing rows path", () => {
  assert.throws(() => parseAdxQuotes(makeSnapshot({ venue: "ADX", dataType: "quotes", body: "<html>403</html>" })), /not valid JSON/);
  assert.throws(
    () => parseAdxQuotes(makeSnapshot({ venue: "ADX", dataType: "quotes", body: '{"data":{}}' })),
    /no rows array/,
  );
});

test("empty board → zero rows, no throw", () => {
  const { rows } = parseAdxQuotes(makeSnapshot({ venue: "ADX", dataType: "quotes", body: '{"data":[]}' }));
  assert.equal(rows.length, 0);
});

test("fetch: browser-only, bootstraps via network_capture, copies fieldMap onto meta", async () => {
  const browser = new FakeBrowserClient("https://adx.test/board.json", [
    rawResponse({ url: "https://adx.test/board.json", body: SYNTHETIC, contentType: "application/json" }),
  ]);
  const source = makeSource({
    id: 20,
    venue: "ADX",
    dataType: "quotes",
    endpointConfig: {
      responseKind: "json",
      actionDiscovery: {
        navigateUrl: "https://www.adx.ae/en/market-watch",
        extract: "network_capture",
        responseUrlPattern: "board",
      },
      // fieldMap stashed on the source config (extra key beyond the frozen EndpointConfig — ADX-specific)
      ...( { fieldMap: ADX_MAP } as object ),
    },
  });
  const results = await adxQuotes.fetch(makeCtx({ source, browser }));
  assert.equal(browser.bootstrapCalls, 1);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]!.meta!.fieldMap, ADX_MAP);
  // roundtrip
  const snap = makeSnapshot({ venue: "ADX", dataType: "quotes", body: results[0]!.body, meta: { fieldMap: ADX_MAP } });
  assert.equal(parseAdxQuotes(snap).rows.length, 2);
});

test("fetch: a persistent WAF challenge propagates as a WAF_CHALLENGE FetchError", async () => {
  const browser = new FakeBrowserClient("https://adx.test/board.json", [
    rawResponse({ url: "https://adx.test/board.json", status: 403, body: "blocked" }),
  ]);
  const source = makeSource({
    id: 21,
    venue: "ADX",
    dataType: "quotes",
    endpointConfig: {
      responseKind: "json",
      actionDiscovery: { navigateUrl: "https://x", extract: "network_capture" },
    },
  });
  await assert.rejects(() => adxQuotes.fetch(makeCtx({ source, browser })), (err: unknown) => {
    assert.equal((err as { errorClass?: string }).errorClass, "WAF_CHALLENGE");
    return true;
  });
});

test("fetch throws without actionDiscovery", async () => {
  const browser = new FakeBrowserClient("https://x", []);
  const source = makeSource({ id: 22, venue: "ADX", dataType: "quotes", endpointConfig: { responseKind: "json" } });
  await assert.rejects(() => adxQuotes.fetch(makeCtx({ source, browser })), /missing endpoint_config.actionDiscovery/);
});
