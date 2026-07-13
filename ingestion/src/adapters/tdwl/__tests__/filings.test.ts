// Tests for the TDWL filings_list + filing_detail parsers. Zero network.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseTdwlFilingsList,
  parseTdwlFilingDetail,
  classifyTdwlCategory,
  tdwlFilingsList,
  TDWL_FILINGS_LIST_PARSER_VERSION,
  TDWL_FILING_DETAIL_PARSER_VERSION,
} from "../filings.js";
import { makeSnapshot } from "./support.js";

// Hand-built list golden — shape per fixtures/tdwl/README.md (real golden captured on VPS).
const LIST_JSON = JSON.stringify({
  totalCount: 3,
  data: [
    {
      announcementId: "CG-1-2026-4471",
      titleEn: "stc announces interim dividend of SAR 0.55 per share",
      companySymbol: "STC",
      companyRef: 7010,
      category: "Dividend Distribution",
      categoryCode: "DIV",
      publishDate: "Jul 13, 2026 9:05:00 AM",
      detailUrl: "https://www.saudiexchange.sa/.../detail?id=CG-1-2026-4471",
      pdfUrl: "https://www.saudiexchange.sa/.../CG-1-2026-4471-en.pdf",
    },
    {
      newsId: "CG-1-2026-4472",
      title: "Board resolution: appointment of external auditor",
      companySymbol: "ALRAJHI",
      category: "Board of Directors",
      disclosureDate: "Jul 13, 2026 10:00:00 AM",
      detailUrl: "https://www.saudiexchange.sa/.../detail?id=CG-1-2026-4472",
    },
    // row with no id → must be dropped
    { title: "orphan with no id", category: "Other", publishDate: "Jul 13, 2026 11:00:00 AM" },
  ],
});

test("classifyTdwlCategory maps labels to the frozen taxonomy", () => {
  assert.equal(classifyTdwlCategory("Dividend Distribution"), "DIVIDEND");
  assert.equal(classifyTdwlCategory("Interim Financial Results"), "RESULTS");
  assert.equal(classifyTdwlCategory("Board of Directors"), "GOVERNANCE");
  assert.equal(classifyTdwlCategory("Credit Rating Update"), "RATING");
  assert.equal(classifyTdwlCategory("New Contract Award"), "CONTRACT");
  assert.equal(classifyTdwlCategory("Prospectus"), "PROSPECTUS");
  assert.equal(classifyTdwlCategory(null), "OTHER");
  assert.equal(classifyTdwlCategory("random noise"), "OTHER");
});

test("parseTdwlFilingsList: emits refs with stable external ids, drops idless rows", () => {
  const snap = makeSnapshot({ venue: "TDWL", dataType: "filings_list", body: LIST_JSON });
  const { rows, parserVersion } = parseTdwlFilingsList(snap);
  assert.equal(parserVersion, TDWL_FILINGS_LIST_PARSER_VERSION);
  assert.equal(rows.length, 2);

  const div = rows.find((r) => r.externalId === "CG-1-2026-4471");
  assert.ok(div);
  assert.equal(div!.venue, "TDWL");
  assert.equal(div!.sourceRef, "CG-1-2026-4471");
  assert.match(div!.title, /interim dividend/);
  assert.equal(div!.filedAt, "2026-07-13T06:05:00.000Z"); // 9:05 AM AST → 06:05 UTC
  assert.equal(div!.pdfUrl, "https://www.saudiexchange.sa/.../CG-1-2026-4471-en.pdf");
  assert.equal(div!.formCode, "DIV");

  const board = rows.find((r) => r.externalId === "CG-1-2026-4472");
  assert.ok(board);
  assert.equal(board!.pdfUrl, undefined); // no pdf on this one
});

test("parseTdwlFilingsList throws on bad JSON / missing data", () => {
  assert.throws(
    () => parseTdwlFilingsList(makeSnapshot({ venue: "TDWL", dataType: "filings_list", body: "<html>403</html>" })),
    /not valid JSON/,
  );
  assert.throws(
    () => parseTdwlFilingsList(makeSnapshot({ venue: "TDWL", dataType: "filings_list", body: "{}" })),
    /missing top-level/,
  );
});

test("parseTdwlFilingDetail: builds NormalizedFiling from PDF snapshot + list handoff meta", () => {
  const snap = makeSnapshot({
    venue: "TDWL",
    dataType: "filing_detail",
    body: Buffer.from("%PDF-1.7 ...binary..."),
    contentType: "application/pdf",
    externalId: "CG-1-2026-4471",
    meta: {
      sourceRef: "CG-1-2026-4471",
      title: "stc announces interim dividend of SAR 0.55 per share",
      category: "Dividend Distribution",
      filedAt: "2026-07-13T06:05:00.000Z",
      companySymbol: "STC",
      pdfStoragePath: "TDWL/filing_detail/2026/07/13/abc.pdf.gz",
    },
  });
  const { rows, parserVersion } = parseTdwlFilingDetail(snap);
  assert.equal(parserVersion, TDWL_FILING_DETAIL_PARSER_VERSION);
  assert.equal(rows.length, 1);
  const f = rows[0]!;
  assert.equal(f.externalId, "CG-1-2026-4471");
  assert.equal(f.filingType, "DIVIDEND");
  assert.equal(f.securityTicker, "STC");
  assert.equal(f.pdfStoragePath, "TDWL/filing_detail/2026/07/13/abc.pdf.gz");
  assert.match(f.title, /interim dividend/);
});

test("parseTdwlFilingDetail: market-wide notice has null securityTicker", () => {
  const snap = makeSnapshot({
    venue: "TDWL",
    dataType: "filing_detail",
    body: Buffer.from("%PDF"),
    contentType: "application/pdf",
    externalId: "CG-1-2026-9000",
    meta: { title: "Market holiday circular", category: "Other" },
  });
  const f = parseTdwlFilingDetail(snap).rows[0]!;
  assert.equal(f.securityTicker, null);
  assert.equal(f.filingType, "OTHER");
});

test("parseTdwlFilingDetail throws when externalId is absent", () => {
  const snap = makeSnapshot({ venue: "TDWL", dataType: "filing_detail", body: Buffer.from("x"), contentType: "application/pdf" });
  assert.throws(() => parseTdwlFilingDetail(snap), /no externalId/);
});

test("filingsList task exposes the frozen dataType", () => {
  assert.equal(tdwlFilingsList.dataType, "filings_list");
});
