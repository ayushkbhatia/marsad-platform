// Golden + unit tests for the Mubasher-backed TDWL quotes parser + fetcher. Zero network. Run with:
//   node --import tsx --test src/adapters/mubasher/__tests__/tdwl-quotes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseMubasherTdwlQuotes,
  parseMubasherNumber,
  parseMubasherTimestampToUtc,
  mapMubasherRow,
  fetchMubasherTdwlQuotes,
  mubasherTdwlQuotes,
  MUBASHER_TDWL_QUOTES_PARSER_VERSION,
} from "../tdwl-quotes.js";
import type {
  FetchContext,
  FetchOptions,
  HttpClient,
  RawResponse,
  SourceRecord,
  StoredSnapshot,
} from "../../../core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "..", "..", "fixtures", "mubasher", "tdwl-quotes.json");

function makeSnapshot(body: Buffer | string, contentType = "application/json;charset=UTF-8"): StoredSnapshot {
  return {
    snapshotId: 1,
    sourceId: 1,
    venue: "TDWL",
    dataType: "quotes",
    contentType,
    externalId: null,
    body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
    fetchedAt: "2026-07-13T12:00:00.000Z",
    meta: { lang: "en" },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("parseMubasherNumber: strips commas/%, keeps signs and zeros, nulls blanks", () => {
  assert.equal(parseMubasherNumber("26.50"), 26.5);
  assert.equal(parseMubasherNumber("6,549,051"), 6549051);
  assert.equal(parseMubasherNumber("174,585,242.96"), 174585242.96);
  assert.equal(parseMubasherNumber("12.71%"), 12.71);
  assert.equal(parseMubasherNumber("-1.05%"), -1.05);
  assert.equal(parseMubasherNumber("-0.28"), -0.28);
  assert.equal(parseMubasherNumber("0"), 0);
  assert.equal(parseMubasherNumber(""), null);
  assert.equal(parseMubasherNumber("-"), null);
  assert.equal(parseMubasherNumber(null), null);
  assert.equal(parseMubasherNumber(undefined), null);
  assert.equal(parseMubasherNumber("N/A"), null);
});

test("parseMubasherTimestampToUtc: AST (UTC+3) wall-clock → UTC", () => {
  // 12:19:09 AST = 09:19:09 UTC
  assert.equal(parseMubasherTimestampToUtc("2026-07-13 12:19:09"), "2026-07-13T09:19:09.000Z");
  // 15:30:00 AST = 12:30:00 UTC
  assert.equal(parseMubasherTimestampToUtc("2026-07-13 15:30:00"), "2026-07-13T12:30:00.000Z");
  // Midnight boundary: 01:00 AST = previous day 22:00 UTC
  assert.equal(parseMubasherTimestampToUtc("2026-07-13 01:00:00"), "2026-07-12T22:00:00.000Z");
  // Missing seconds tolerated
  assert.equal(parseMubasherTimestampToUtc("2026-07-13 09:30"), "2026-07-13T06:30:00.000Z");
  assert.equal(parseMubasherTimestampToUtc("garbage"), null);
  assert.equal(parseMubasherTimestampToUtc(null), null);
});

// ---------------------------------------------------------------------------
// Golden parse against the real captured fixture (387 TDWL rows)
// ---------------------------------------------------------------------------

test("golden: parses the real Mubasher TDWL board with >=1 sane Saudi quote", () => {
  const body = readFileSync(FIXTURE);
  const { rows, parserVersion } = parseMubasherTdwlQuotes(makeSnapshot(body));

  assert.equal(parserVersion, MUBASHER_TDWL_QUOTES_PARSER_VERSION);
  assert.ok(rows.length >= 1, "expected at least one quote");
  assert.ok(rows.length >= 380, `expected the full ~387-row board, got ${rows.length}`);

  // Every row carries the TDWL venue + a non-empty numeric ticker + a UTC as_of.
  for (const q of rows) {
    assert.equal(q.venue, "TDWL");
    assert.ok(q.ticker.length > 0, "ticker must be non-empty");
    assert.ok(q.asOf.endsWith("Z"), "as_of must be an ISO UTC instant");
  }

  // Known ticker 2222 (SAUDI ARAMCO) — verbatim fixture values, incl. a negative change.
  const aramco = rows.find((r) => r.ticker === "2222");
  assert.ok(aramco, "2222 (Aramco) must be present");
  assert.equal(aramco!.last, 26.5);
  assert.equal(aramco!.change, -0.28);
  assert.equal(aramco!.changePct, -1.05);
  assert.equal(aramco!.open, 26.78);
  assert.equal(aramco!.high, 26.78);
  assert.equal(aramco!.low, 26.5);
  assert.equal(aramco!.volume, 6549051);
  // updatedAt "2026-07-13 12:19:09" AST → 09:19:09 UTC
  assert.equal(aramco!.asOf, "2026-07-13T09:19:09.000Z");

  // Known ticker 1120 (ALRAJHI) — spot-check comma-grouped volume + positive change.
  const rajhi = rows.find((r) => r.ticker === "1120");
  assert.ok(rajhi, "1120 (Al Rajhi) must be present");
  assert.equal(rajhi!.last, 65.55);
  assert.equal(rajhi!.change, 0.45);
  assert.equal(rajhi!.changePct, 0.69);
  assert.equal(rajhi!.volume, 4643965);
});

test("mapMubasherRow: drops rows with no code (ticker); falls back to board as_of", () => {
  const noCode = mapMubasherRow({ exchange: "TDWL", value: "5.00" }, "2026-07-13T12:30:00.000Z");
  assert.equal(noCode, null);

  // Row without its own updatedAt falls back to the board feed timestamp.
  const fell = mapMubasherRow(
    { exchange: "TDWL", code: "7010", value: "40.0" },
    "2026-07-13T12:30:00.000Z",
  );
  assert.ok(fell);
  assert.equal(fell!.ticker, "7010");
  assert.equal(fell!.asOf, "2026-07-13T12:30:00.000Z");
  assert.equal(fell!.last, 40);
});

test("parse: filters stray non-TDWL rows defensively", () => {
  const body = JSON.stringify({
    lastUpdate: "2026-07-13 15:30:00",
    prices: [
      { exchange: "TDWL", code: "2222", value: "26.50" },
      { exchange: "DFM", code: "EMAAR", value: "8.00" }, // stray — must be dropped
    ],
  });
  const { rows } = parseMubasherTdwlQuotes(makeSnapshot(body));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ticker, "2222");
});

test("parse: throws on non-JSON and on missing prices array (hard drift)", () => {
  assert.throws(() => parseMubasherTdwlQuotes(makeSnapshot("<html>blocked</html>", "text/html")), /not valid JSON/);
  assert.throws(() => parseMubasherTdwlQuotes(makeSnapshot('{"foo":1}')), /missing top-level/);
});

test("parse: empty board is valid (zero rows, no throw) — PARSE_DRIFT is the harness's call", () => {
  const { rows } = parseMubasherTdwlQuotes(makeSnapshot('{"lastUpdate":"2026-07-13 15:30:00","prices":[]}'));
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// fetch(): plain HTTP (ctx.http), URL from config, raw bytes verbatim
// ---------------------------------------------------------------------------

/** Scripted HttpClient double: returns a single queued response; records the URL fetched. */
class FakeHttpClient implements HttpClient {
  public gets: string[] = [];
  constructor(private readonly res: RawResponse) {}
  async get(url: string, _opts?: FetchOptions): Promise<RawResponse> {
    this.gets.push(url);
    return this.res;
  }
  async request(url: string, opts: FetchOptions): Promise<RawResponse> {
    return this.get(url, opts);
  }
}

function throwingBrowser(): FetchContext["browser"] {
  const boom = () => {
    throw new Error("Mubasher TDWL quotes is plain http — must not use ctx.browser");
  };
  return {
    bootstrap: boom as never,
    refreshIfChallenged: boom as never,
    get: boom as never,
    request: boom as never,
    close: async () => {},
  } as unknown as FetchContext["browser"];
}

function makeSource(overrides: Partial<SourceRecord>): SourceRecord {
  return {
    id: 1,
    venue: "TDWL",
    dataType: "quotes",
    entryUrl: "https://english.mubasher.info/markets/TDWL",
    endpointConfig: { responseKind: "json" },
    normalizeRules: [],
    transport: "http",
    robotsStatus: "allowed",
    active: true,
    lastContentHash: null,
    ...overrides,
  };
}

test("fetch: GETs the configured Mubasher URL via ctx.http and returns raw bytes verbatim", async () => {
  const jsonBody = readFileSync(FIXTURE);
  const http = new FakeHttpClient({
    url: "https://english.mubasher.info/api/1/stocks/prices?country=sa",
    status: 200,
    headers: { "content-type": "application/json;charset=UTF-8" },
    body: jsonBody,
    fromCache304: false,
  });
  const source = makeSource({
    endpointConfig: {
      responseKind: "json",
      urlTemplate: "https://english.mubasher.info/api/1/stocks/prices?country=sa",
    },
  });
  const ctx: FetchContext = {
    source,
    http,
    browser: throwingBrowser(),
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    now: () => "2026-07-13T12:00:00.000Z",
  };

  const results = await mubasherTdwlQuotes.fetch(ctx);
  assert.equal(results.length, 1);
  // URL comes from endpoint_config.urlTemplate, not hardcoded.
  assert.equal(http.gets[0], "https://english.mubasher.info/api/1/stocks/prices?country=sa");
  assert.equal(results[0]!.httpStatus, 200);
  assert.ok(results[0]!.body.equals(jsonBody), "raw bytes stored verbatim (snapshot-first)");
  assert.equal(results[0]!.meta!.lang, "en");
  assert.equal(results[0]!.meta!.delayed, true);
  // fetch→parse roundtrip yields the full board.
  const snap = makeSnapshot(results[0]!.body);
  assert.ok(parseMubasherTdwlQuotes(snap).rows.length >= 380);
});

test("fetch: falls back to source.entryUrl when urlTemplate is absent", async () => {
  const http = new FakeHttpClient({
    url: "https://english.mubasher.info/markets/TDWL",
    status: 200,
    headers: {},
    body: Buffer.from('{"lastUpdate":"2026-07-13 15:30:00","prices":[]}'),
    fromCache304: false,
  });
  const source = makeSource({ endpointConfig: { responseKind: "json" } }); // no urlTemplate
  const ctx: FetchContext = {
    source,
    http,
    browser: throwingBrowser(),
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    now: () => "2026-07-13T12:00:00.000Z",
  };
  await fetchMubasherTdwlQuotes(ctx);
  assert.equal(http.gets[0], "https://english.mubasher.info/markets/TDWL");
});
