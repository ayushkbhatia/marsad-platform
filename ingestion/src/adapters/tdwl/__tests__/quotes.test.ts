// Golden + unit tests for the TDWL quotes parser + fetcher. Zero network. Run with:
//   node --import tsx --test src/adapters/tdwl/__tests__/quotes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseTdwlQuotes,
  parseTdwlNumber,
  parseTdwlTimestampToUtc,
  mapTdwlRow,
  tdwlQuotes,
  tdwlNomuQuotes,
  TDWL_QUOTES_PARSER_VERSION,
} from "../quotes.js";
import { makeSnapshot, makeSource, makeCtx, FakeBrowserClient, rawResponse } from "./support.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "..", "fixtures", "tdwl", "market-details.sample.json");

test("parseTdwlNumber handles numbers, separators, glyphs, blanks", () => {
  assert.equal(parseTdwlNumber(51.5), 51.5);
  assert.equal(parseTdwlNumber("2,841,220"), 2841220);
  assert.equal(parseTdwlNumber("0.59%"), 0.59);
  assert.equal(parseTdwlNumber(""), null);
  assert.equal(parseTdwlNumber("-"), null);
  assert.equal(parseTdwlNumber(null), null);
  assert.equal(parseTdwlNumber(undefined), null);
  assert.equal(parseTdwlNumber(NaN), null);
});

test("parseTdwlTimestampToUtc converts AST wall-clock → UTC (UTC+3)", () => {
  // 3:18:51 PM AST = 15:18:51 AST = 12:18:51 UTC
  assert.equal(parseTdwlTimestampToUtc("Jul 13, 2026 3:18:51 PM"), "2026-07-13T12:18:51.000Z");
  // Midnight boundary: 12:00:00 AM AST = 00:00 AST = previous day 21:00 UTC
  assert.equal(parseTdwlTimestampToUtc("Jul 13, 2026 12:00:00 AM"), "2026-07-12T21:00:00.000Z");
  // Noon: 12:00:00 PM AST = 12:00 AST = 09:00 UTC
  assert.equal(parseTdwlTimestampToUtc("Jul 13, 2026 12:00:00 PM"), "2026-07-13T09:00:00.000Z");
  // No seconds
  assert.equal(parseTdwlTimestampToUtc("Jan 5, 2026 9:30 AM"), "2026-01-05T06:30:00.000Z");
  assert.equal(parseTdwlTimestampToUtc("garbage"), null);
  assert.equal(parseTdwlTimestampToUtc(null), null);
});

test("golden: parseTdwlQuotes maps the real sample fixture correctly", () => {
  const body = readFileSync(FIXTURE);
  const snap = makeSnapshot({ venue: "TDWL", dataType: "quotes", body, contentType: "text/html" });
  const { rows, parserVersion } = parseTdwlQuotes(snap);

  assert.equal(parserVersion, TDWL_QUOTES_PARSER_VERSION);
  assert.equal(rows.length, 2);

  const sarco = rows.find((r) => r.ticker === "SARCO");
  assert.ok(sarco, "SARCO row present");
  assert.equal(sarco!.venue, "TDWL");
  assert.equal(sarco!.last, 51.5);
  assert.equal(sarco!.change, 0.3);
  assert.equal(sarco!.changePct, 0.59);
  assert.equal(sarco!.open, 51.0);
  assert.equal(sarco!.high, 51.8);
  assert.equal(sarco!.low, 50.9);
  assert.equal(sarco!.volume, 128340);
  assert.equal(sarco!.bid, 51.4);
  assert.equal(sarco!.ask, 51.5);
  // transactionDate "Jul 13, 2026 3:18:51 PM" AST → 12:18:51 UTC
  assert.equal(sarco!.asOf, "2026-07-13T12:18:51.000Z");

  const rajhi = rows.find((r) => r.ticker === "ALRAJHI");
  assert.ok(rajhi);
  assert.equal(rajhi!.last, 92.1);
  assert.equal(rajhi!.volume, 2841220);
});

test("derives change/changePct from previousClose when board omits them", () => {
  const row = { acrynomName: "TEST", lastTradePrice: 110, previousClosePrice: 100 };
  const q = mapTdwlRow(row);
  assert.ok(q);
  assert.equal(q!.change, 10);
  assert.equal(q!.changePct, 10);
});

test("drops rows with no symbol; keeps null numerics", () => {
  const noSym = mapTdwlRow({ lastTradePrice: 5 });
  assert.equal(noSym, null);
  const halted = mapTdwlRow({ acrynomName: "HALT", lastTradePrice: null });
  assert.ok(halted);
  assert.equal(halted!.last, null);
  assert.equal(halted!.change, null);
});

test("parseTdwlQuotes throws on non-JSON and on missing data array (hard drift)", () => {
  const bad = makeSnapshot({ venue: "TDWL", dataType: "quotes", body: "<html>403</html>" });
  assert.throws(() => parseTdwlQuotes(bad), /not valid JSON/);
  const noData = makeSnapshot({ venue: "TDWL", dataType: "quotes", body: '{"foo":1}' });
  assert.throws(() => parseTdwlQuotes(noData), /missing top-level/);
});

test("empty board is valid (zero rows, no throw) — PARSE_DRIFT is the harness's call", () => {
  const empty = makeSnapshot({ venue: "TDWL", dataType: "quotes", body: '{"data":[]}' });
  const { rows } = parseTdwlQuotes(empty);
  assert.equal(rows.length, 0);
});

test("Nomu task shares the same pure parser (identical output on same bytes)", () => {
  const body = readFileSync(FIXTURE);
  const snap = makeSnapshot({ venue: "TDWL", dataType: "quotes", body });
  assert.deepEqual(tdwlNomuQuotes.parse(snap), tdwlQuotes.parse(snap));
});

test("fetch: uses browser (not http), bootstraps, snapshots raw bytes verbatim", async () => {
  const jsonBody = readFileSync(FIXTURE);
  const browser = new FakeBrowserClient("https://tdwl.test/action/NJ...=/?_={epochMs}", [
    rawResponse({ url: "https://tdwl.test/action/resolved", body: jsonBody, contentType: "text/html" }),
  ]);
  const source = makeSource({
    id: 10,
    venue: "TDWL",
    dataType: "quotes",
    endpointConfig: {
      responseKind: "json",
      actionDiscovery: {
        navigateUrl: "https://www.saudiexchange.sa/.../main-market-watch",
        extract: "datatable_ajax",
      },
    },
  });
  const ctx = makeCtx({ source, browser });
  const results = await tdwlQuotes.fetch(ctx);

  assert.equal(browser.bootstrapCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.httpStatus, 200);
  assert.equal(results[0]!.contentType, "text/html"); // verbatim — JSON served as text/html
  assert.ok(results[0]!.body.equals(jsonBody), "raw bytes stored verbatim");
  // The returned snapshot bytes re-parse to the same rows (fetch→parse roundtrip).
  const snap = makeSnapshot({ venue: "TDWL", dataType: "quotes", body: results[0]!.body });
  assert.equal(parseTdwlQuotes(snap).rows.length, 2);
});

test("fetch: a persistent WAF challenge propagates as a WAF_CHALLENGE FetchError", async () => {
  // The real BrowserClient.get already does the one-free-retry + re-bootstrap internally and throws
  // WAF_CHALLENGE if still blocked; the adapter must NOT swallow it (the harness maps the class).
  const browser = new FakeBrowserClient("https://tdwl.test/resolved", [
    rawResponse({ url: "https://tdwl.test/resolved", status: 403, body: "blocked" }),
  ]);
  const source = makeSource({
    id: 11,
    venue: "TDWL",
    dataType: "quotes",
    endpointConfig: {
      responseKind: "json",
      actionDiscovery: { navigateUrl: "https://x.test", extract: "datatable_ajax" },
    },
  });
  await assert.rejects(() => tdwlQuotes.fetch(makeCtx({ source, browser })), (err: unknown) => {
    assert.equal((err as { errorClass?: string }).errorClass, "WAF_CHALLENGE");
    return true;
  });
});

test("fetch: throws when source lacks actionDiscovery config", async () => {
  const browser = new FakeBrowserClient("https://x", []);
  const source = makeSource({ id: 12, venue: "TDWL", dataType: "quotes", endpointConfig: { responseKind: "json" } });
  await assert.rejects(() => tdwlQuotes.fetch(makeCtx({ source, browser })), /no endpoint_config.actionDiscovery/);
});
