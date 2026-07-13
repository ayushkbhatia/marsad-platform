// Tests for the ADX config-driven filings_list + filing_detail parsers. Zero network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAdxFilingsList,
  parseAdxFilingDetail,
  classifyAdxCategory,
  adxFilingsList,
  type AdxFilingFieldMap,
} from "../filings.js";
import { makeSnapshot } from "../../tdwl/__tests__/support.js";

const MAP: AdxFilingFieldMap = {
  rowsPath: "payload.items",
  externalId: "discId",
  title: "headline",
  filedAt: "publishedTs",
  filedAtKind: "epoch_ms",
  detailUrl: "url",
  pdfUrl: "pdf",
  symbol: "ticker",
  category: "type",
};

const LIST = JSON.stringify({
  payload: {
    items: [
      {
        discId: "ADX-2026-1001",
        headline: "FAB Q2 2026 interim financial results",
        ticker: "FAB",
        type: "Financial Statements",
        publishedTs: 1_752_408_000_000,
        url: "https://adx.ae/disclosures/1001",
        pdf: "https://adx.ae/disclosures/1001.pdf",
      },
      { discId: "ADX-2026-1002", headline: "Cash dividend distribution", type: "Dividends", publishedTs: 1_752_411_600_000, url: "https://adx.ae/disclosures/1002" },
      { headline: "orphan no id", type: "Other" },
    ],
  },
});

test("classifyAdxCategory maps to the frozen taxonomy", () => {
  assert.equal(classifyAdxCategory("Financial Statements"), "RESULTS");
  assert.equal(classifyAdxCategory("Dividends"), "DIVIDEND");
  assert.equal(classifyAdxCategory("New Listing"), "PROSPECTUS");
  assert.equal(classifyAdxCategory(null), "OTHER");
});

test("parseAdxFilingsList maps via field map, drops idless rows", () => {
  const snap = makeSnapshot({ venue: "ADX", dataType: "filings_list", body: LIST, contentType: "application/json", meta: { filingFieldMap: MAP } });
  const { rows } = parseAdxFilingsList(snap);
  assert.equal(rows.length, 2);
  const fs = rows.find((r) => r.externalId === "ADX-2026-1001")!;
  assert.equal(fs.venue, "ADX");
  assert.equal(fs.title, "FAB Q2 2026 interim financial results");
  assert.equal(fs.filedAt, new Date(1_752_408_000_000).toISOString());
  assert.equal(fs.pdfUrl, "https://adx.ae/disclosures/1001.pdf");
  const div = rows.find((r) => r.externalId === "ADX-2026-1002")!;
  assert.equal(div.pdfUrl, undefined);
});

test("parseAdxFilingsList throws on bad JSON / missing rows path", () => {
  assert.throws(() => parseAdxFilingsList(makeSnapshot({ venue: "ADX", dataType: "filings_list", body: "<html>" })), /not valid JSON/);
  assert.throws(
    () => parseAdxFilingsList(makeSnapshot({ venue: "ADX", dataType: "filings_list", body: "{}", meta: { filingFieldMap: MAP } })),
    /no rows array/,
  );
});

test("parseAdxFilingDetail builds NormalizedFiling from PDF snapshot + meta", () => {
  const snap = makeSnapshot({
    venue: "ADX",
    dataType: "filing_detail",
    body: Buffer.from("%PDF"),
    contentType: "application/pdf",
    externalId: "ADX-2026-1001",
    meta: { title: "FAB Q2 2026 interim financial results", category: "Financial Statements", filedAt: new Date(1_752_408_000_000).toISOString(), symbol: "FAB", pdfStoragePath: "ADX/filing_detail/2026/07/13/x.pdf.gz" },
  });
  const f = parseAdxFilingDetail(snap).rows[0]!;
  assert.equal(f.filingType, "RESULTS");
  assert.equal(f.securityTicker, "FAB");
  assert.equal(f.pdfStoragePath, "ADX/filing_detail/2026/07/13/x.pdf.gz");
});

test("parseAdxFilingDetail throws without externalId", () => {
  assert.throws(
    () => parseAdxFilingDetail(makeSnapshot({ venue: "ADX", dataType: "filing_detail", body: Buffer.from("x"), contentType: "application/pdf" })),
    /no externalId/,
  );
});

test("filingsList task exposes frozen dataType", () => {
  assert.equal(adxFilingsList.dataType, "filings_list");
});
