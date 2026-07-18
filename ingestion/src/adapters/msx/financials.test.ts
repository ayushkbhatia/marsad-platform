// MSX financials-index parser test. Golden-tested against the REAL snapshot.aspx/FinancialsReports
// response (ingestion/fixtures/msx/financials-reports-BKMB.json, 118 reports). Zero network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  msxFinancialsReportsBody,
  msxFinancialsReportsUrl,
  msxReportZipUrl,
  parseMsxFinancialReports,
  parseReportPeriod,
  parseUploadDate,
  withinUploadWindow,
} from './financials.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../fixtures/msx/financials-reports-BKMB.json');
const fixture = readFileSync(fixturePath);

test('MSX financials: parses the live BKMB index', () => {
  const rows = parseMsxFinancialReports(fixture);
  assert.equal(rows.length, 118, 'every report in the fixture parses');

  const first = rows[0]!;
  assert.equal(first.reportId, '16227');
  assert.equal(first.sourceRef, 'MSX-FS-16227');
  assert.equal(first.fileNameEn, 'BKMB_2026_Q1 (Un-Audited)_e.zip');
  assert.equal(first.zipUrl, 'https://www.msx.om/MSMDOCS/FinancialReports/BKMB_2026_Q1%20(Un-Audited)_e.zip');
  assert.equal(first.periodEnd, '2026-03-31');
  assert.equal(first.periodKind, 'quarter');
  assert.equal(first.uploadDate, '2026-04-28');
  assert.equal(first.audited, false);

  // Every row is uniquely keyed and carries a usable download target.
  assert.equal(new Set(rows.map((r) => r.sourceRef)).size, rows.length, 'source_refs unique');
  assert.ok(rows.every((r) => r.zipUrl.startsWith('https://www.msx.om/MSMDOCS/FinancialReports/')));
});

test('MSX financials: the audited annual supersedes the un-audited one for the SAME period end', () => {
  // BKMB files Yearly (Un-Audited) in Jan, then Yearly (Audited) in Mar, both ending 2025-12-31.
  // They are DISTINCT ReportIDs — the researcher must archive both and let source_rank/versioning decide.
  const rows = parseMsxFinancialReports(fixture);
  const fy2025 = rows.filter((r) => r.periodEnd === '2025-12-31' && r.periodKind === 'annual');
  assert.equal(fy2025.length, 2, 'both cuts of FY2025 are present');

  const audited = fy2025.find((r) => r.audited);
  const unaudited = fy2025.find((r) => !r.audited);
  assert.ok(audited && unaudited, 'one audited, one un-audited');
  assert.equal(audited.categoryId, '7');
  assert.equal(unaudited.categoryId, '6');
  assert.notEqual(audited.reportId, unaudited.reportId, 'distinct filings, not a duplicate');
});

test('MSX financials: period comes from the title, never the fiscal filename year', () => {
  // The filename year is FISCAL. AAIC_2025_Q3 is really 01/10/2025–31/12/2025 (April FY start), so a
  // ReportYear-derived period would be wrong by a quarter for every non-Dec filer.
  assert.deepEqual(
    parseReportPeriod('Unaudited financial statements for Quarter 3 ended on 2025-12-31', 'Q3 (Un-Audited)'),
    { periodEnd: '2025-12-31', periodKind: 'quarter' },
  );
  assert.deepEqual(
    parseReportPeriod('Audited financial statements for the year ended on 2026-03-31', 'Yearly (Audited)'),
    { periodEnd: '2026-03-31', periodKind: 'annual' },
  );
  // The 'Reviewed' variant is still a quarter.
  assert.equal(
    parseReportPeriod('Reviewed financial statements for Quarter 3 ended on 2024-09-30', 'Q3 (Reviewed)').periodKind,
    'quarter',
  );
});

test('MSX financials: the "ending", no-"on" title variant still yields a period', () => {
  // Real BKMB row: the ISO date is present, just phrased differently. Recover it.
  assert.deepEqual(
    parseReportPeriod('Financial statement for quarter ending 2021-09-30', 'Q3 (Un-Audited)'),
    { periodEnd: '2021-09-30', periodKind: 'quarter' },
  );
});

test('MSX financials: pre-2022 free-text titles yield a null period rather than a guess', () => {
  // A month-name heuristic would be wrong by a quarter for every non-Dec fiscal filer, and a wrong period
  // silently corrupts a statement row — so these degrade to null. periodKind still resolves off the label,
  // and the authoritative period lives in the zip's FilingInformation document.
  const p = parseReportPeriod('Unaudited Financial Reports Q2 2021', 'Q2 (Un-Audited)');
  assert.equal(p.periodEnd, null, 'no date invented from a free-text title');
  assert.equal(p.periodKind, 'quarter', 'kind still known from the label');

  // Real AAIC row. AAIC's FY starts 1 Apr, so "first quarter ended 30 June 2021" is genuinely Q1 — but
  // parsing month names would also mis-date the Dec-FY filers. Refuse rather than guess.
  const a = parseReportPeriod('Consolidated Audited Financial Statements for the year ended 31st March 2021', 'Yearly (Audited)');
  assert.equal(a.periodEnd, null, 'free-text month names are not parsed');
  assert.equal(a.periodKind, 'annual');
});

test('MSX financials: upload-date window filters to the backfill horizon', () => {
  assert.equal(parseUploadDate('Apr 28, 2026'), '2026-04-28');
  assert.equal(parseUploadDate('Jan 27, 2026'), '2026-01-27');
  assert.equal(parseUploadDate(''), null);
  assert.equal(parseUploadDate('garbage'), null);

  const rows = parseMsxFinancialReports(fixture);
  const recent = withinUploadWindow(rows, '2021-07-17');
  assert.ok(recent.length > 0 && recent.length < rows.length, 'window is a strict, non-empty subset');
  assert.ok(recent.every((r) => r.uploadDate !== null && r.uploadDate >= '2021-07-17'));
});

test('MSX financials: malformed bodies yield no targets and never throw', () => {
  assert.deepEqual(parseMsxFinancialReports('not json'), []);
  assert.deepEqual(parseMsxFinancialReports('{"d":null}'), []);
  assert.deepEqual(parseMsxFinancialReports('{}'), []);
  // A row with no English artifact is dropped (Arabic-only), not emitted with a broken url.
  assert.deepEqual(parseMsxFinancialReports('{"d":[{"ReportID":"1","FileNameEn":""}]}'), []);
});

test('MSX financials: dirty filenames survive url-encoding verbatim', () => {
  // Real MSX data contains a double space: "AAIT  _2014_Yearly_e.zip". Trimming inside the name would
  // 404; the segment must be encoded as-is.
  assert.equal(
    msxReportZipUrl('AAIT  _2014_Yearly_e.zip'),
    'https://www.msx.om/MSMDOCS/FinancialReports/AAIT%20%20_2014_Yearly_e.zip',
  );
});

test('MSX financials: index request targets the ScriptService with a full-history body', () => {
  assert.equal(msxFinancialsReportsUrl(), 'https://www.msx.om/snapshot.aspx/FinancialsReports');
  assert.equal(msxFinancialsReportsBody('BKMB'), '{"Symbol":"BKMB","Year":""}');
  assert.equal(msxFinancialsReportsBody('AAIC', '2025'), '{"Symbol":"AAIC","Year":"2025"}');
});
